import { backofficeFetch } from "@/fragno/auth/browser-auth.client";
import type { LargeFileUploadResult } from "@/routes/api/large-files-uploads";

/** How far an upload got: its bytes going to storage, then Backoffice recording the blob. */
export type LargeFileUploadProgress =
  | { phase: "uploading"; sentBytes: number }
  | { phase: "completing" };

/**
 * Uploads a file as the blob `key` in three steps: Backoffice starts the upload, the browser PUTs
 * the bytes straight to storage, and Backoffice completes it once storage holds them.
 */
export async function uploadLargeFile({
  uploadsPath,
  file,
  key,
  onProgress,
}: {
  uploadsPath: string;
  file: File;
  key: string;
  onProgress: (progress: LargeFileUploadProgress) => void;
}): Promise<void> {
  const started = await postUploadStep(uploadsPath, {
    intent: "start",
    key,
    contentType: file.type || "application/octet-stream",
  });
  if (!started.ok || started.step !== "start") {
    throw new Error(started.ok ? "The upload did not start." : started.error);
  }
  await putToStorage(started.upload, file, (sentBytes) => {
    onProgress({ phase: "uploading", sentBytes });
  });
  onProgress({ phase: "completing" });
  const completed = await postUploadStep(uploadsPath, {
    intent: "complete",
    uploadId: started.upload.uploadId,
  });
  if (!completed.ok) {
    throw new Error(completed.error);
  }
}

/** Deletes the blob `key`, uploaded by someone who no longer wants it. */
export async function discardLargeFile(uploadsPath: string, key: string): Promise<void> {
  const discarded = await postUploadStep(uploadsPath, { intent: "discard", key });
  if (!discarded.ok) {
    throw new Error(discarded.error);
  }
}

/** Refreshes an expiring credential and retries, so a long upload still completes. */
async function postUploadStep(
  uploadsPath: string,
  step: Record<string, string>,
): Promise<LargeFileUploadResult> {
  const response = await backofficeFetch(uploadsPath, {
    method: "POST",
    body: new URLSearchParams(step),
  });
  // The route answers each step in JSON; authentication and authorization answer in text.
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return {
      ok: false,
      error: (await response.text()) || `Backoffice answered ${response.status}.`,
    };
  }
  return (await response.json()) as LargeFileUploadResult;
}

/** XHR rather than fetch, because only XHR reports how much of a request body was sent. */
function putToStorage(
  upload: Extract<LargeFileUploadResult, { step: "start" }>["upload"],
  file: File,
  onProgress: (sentBytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(`Storage rejected the upload (${request.status}).`));
      }
    });
    request.addEventListener("error", () => {
      reject(new Error("The upload could not reach storage."));
    });
    request.send(file);
  });
}
