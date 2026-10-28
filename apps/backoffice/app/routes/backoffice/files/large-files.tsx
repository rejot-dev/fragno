import { BLOB_MAX_SIZE_BYTES } from "@fragno-dev/backoffice-api/v0/blobs";
import { LargeFilesView, type LargeFileTransfer } from "@fragno-private/design-system/large-files";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useState } from "react";
import { useFetcher, useOutletContext, useRevalidator } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { backofficeFetch } from "@/fragno/auth/browser-auth.client";
import type { LargeFileUploadResult } from "@/routes/api/large-files-uploads";

import type { Route } from "./+types/large-files";
import {
  blobsFailure,
  openSelectedLargeFiles,
  refusalFailure,
  type LargeFilesFailure,
} from "./large-files.server";
import type { FilesLayoutContext } from "./layout-context";
import { largeFileDownloadPath, largeFileUploadsPath } from "./scope";

type LargeFilesPage = {
  blobs: Array<{ key: string; sizeBytes: number; contentType: string }>;
  cursor: string | null;
};

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const largeFiles = await openSelectedLargeFiles({ request, context });
  if (largeFiles.status !== "available") {
    return { status: largeFiles.status };
  }

  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor");
  const canModify = await largeFiles.files.canModify();
  let page: LargeFilesPage | LargeFilesFailure;
  try {
    page = await largeFiles.files.read(async (blobs) => {
      const response = await blobs("GET", "/blobs", {
        query: { ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) },
      });
      return response.type === "json" ? response.data : blobsFailure(response);
    });
  } catch (error) {
    page = refusalFailure(error);
  }
  return "blobs" in page
    ? {
        status: "available" as const,
        files: page.blobs,
        prefix,
        nextPageTo: page.cursor ? pageSearch(prefix, page.cursor) : null,
        firstPageTo: cursor ? pageSearch(prefix, null) : null,
        error: null,
        canModify,
      }
    : {
        status: "available" as const,
        files: [],
        prefix,
        nextPageTo: null,
        firstPageTo: null,
        error: `Large files could not be listed: ${page.message}`,
        canModify,
      };
}

export async function action({ request, context }: Route.ActionArgs) {
  const key = (await request.formData()).get("key");
  if (typeof key !== "string" || !key) {
    return { error: "Choose a large file to delete." };
  }
  const largeFiles = await openSelectedLargeFiles({ request, context });
  if (largeFiles.status !== "available") {
    return { error: "This scope has no large files." };
  }
  let failure: LargeFilesFailure | null;
  try {
    failure = await largeFiles.files.modify(async (blobs) => {
      const response = await blobs("DELETE", "/blobs/by-key", { query: { key } });
      return response.type === "json" ? null : blobsFailure(response);
    });
  } catch (error) {
    failure = refusalFailure(error);
  }
  return { error: failure && `${key} could not be deleted: ${failure.message}` };
}

export function meta() {
  return [{ title: "Large files" }];
}

export default function BackofficeLargeFiles({ loaderData }: Route.ComponentProps) {
  const { scope, selectedScope } = useOutletContext<FilesLayoutContext>();

  if (loaderData.status !== "available") {
    return (
      <div className={backofficePageBodyClassName}>
        <BackofficeSystemState
          tone="empty"
          label="Unavailable"
          title={
            loaderData.status === "scope"
              ? "This scope has no large files."
              : "Large file storage is not set up."
          }
          description={
            loaderData.status === "scope"
              ? "Switch to an organization, project, or your personal scope to keep large files."
              : "This deployment has no object storage for large files. Workspace files still work."
          }
        />
      </div>
    );
  }

  return (
    <div
      className={`${backofficePageBodyClassName} backoffice-scroll min-h-0 flex-1 overflow-y-auto`}
    >
      <LargeFiles
        {...loaderData}
        uploadsPath={largeFileUploadsPath(scope)}
        downloadHref={(key) => largeFileDownloadPath(selectedScope, key)}
      />
    </div>
  );
}

function LargeFiles({
  files,
  prefix,
  nextPageTo,
  firstPageTo,
  error,
  canModify,
  uploadsPath,
  downloadHref,
}: Extract<Route.ComponentProps["loaderData"], { status: "available" }> & {
  uploadsPath: string;
  downloadHref: (key: string) => string;
}) {
  const deletion = useFetcher<typeof action>();
  const { transfers, upload, dismiss } = useLargeFileTransfers(uploadsPath);

  return (
    <LargeFilesView
      files={files}
      prefix={prefix}
      nextPageTo={nextPageTo}
      firstPageTo={firstPageTo}
      error={deletion.data?.error ?? error}
      maxFileBytes={BLOB_MAX_SIZE_BYTES}
      downloadHref={downloadHref}
      access={
        canModify
          ? {
              kind: "editable",
              transfers,
              onUpload: (file, key) => {
                void upload(file, key);
              },
              onDismissTransfer: dismiss,
              onDelete: (key) => deletion.submit({ key }, { method: "post" }),
            }
          : { kind: "read-only" }
      }
    />
  );
}

/**
 * Uploads each file in three steps: Backoffice starts the upload, the browser PUTs the bytes
 * straight to storage, and Backoffice completes it once storage holds them.
 */
function useLargeFileTransfers(uploadsPath: string) {
  const [transfers, setTransfers] = useState<readonly LargeFileTransfer[]>([]);
  const revalidator = useRevalidator();
  const replace = (next: LargeFileTransfer) => {
    setTransfers((current) =>
      current.map((transfer) => (transfer.id === next.id ? next : transfer)),
    );
  };

  async function upload(file: File, key: string) {
    const id = crypto.randomUUID();
    const totalBytes = file.size;
    setTransfers((current) => [
      ...current,
      { id, key, phase: "uploading", sentBytes: 0, totalBytes },
    ]);
    try {
      const started = await postUploadStep(uploadsPath, {
        intent: "start",
        key,
        contentType: file.type || "application/octet-stream",
      });
      if (!started.ok || started.step !== "start") {
        throw new Error(started.ok ? "The upload did not start." : started.error);
      }
      await putToStorage(started.upload, file, (sentBytes) => {
        replace({ id, key, phase: "uploading", sentBytes, totalBytes });
      });
      replace({ id, key, phase: "completing", totalBytes });
      const completed = await postUploadStep(uploadsPath, {
        intent: "complete",
        uploadId: started.upload.uploadId,
      });
      if (!completed.ok) {
        throw new Error(completed.error);
      }
      setTransfers((current) => current.filter((transfer) => transfer.id !== id));
      await revalidator.revalidate();
    } catch (error) {
      replace({
        id,
        key,
        phase: "failed",
        error: error instanceof Error ? error.message : "The upload failed.",
      });
    }
  }

  return {
    transfers,
    upload,
    dismiss: (id: string) => {
      setTransfers((current) => current.filter((transfer) => transfer.id !== id));
    },
  };
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

function pageSearch(prefix: string, cursor: string | null): string {
  const search = new URLSearchParams({
    ...(prefix ? { prefix } : {}),
    ...(cursor ? { cursor } : {}),
  });
  return `?${search}`;
}
