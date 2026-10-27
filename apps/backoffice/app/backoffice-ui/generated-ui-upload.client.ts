import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { GeneratedUiUploadedFile } from "@fragno-private/backoffice-ui/generated-ui-upload";

import type { UploadProgress } from "@fragno-dev/upload";

import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createScopedUploadHelpers } from "@/fragno/upload-client";
import { workspaceFileName } from "@/lib/workspace-file-name";

// Every file a run's forms upload sits below this folder, so it alone identifies their uploads.
function runUploadsFolder(instanceId: string): string {
  return `uploads/${encodeURIComponent(instanceId)}/`;
}

/**
 * Uploads a generated UI's file into the scope's workspace, keeping its name. The random folder
 * keeps each upload of a run apart, so two files with the same name do not replace each other.
 * The file it replaces is deleted once the new one is uploaded, unless this run's forms did not
 * upload it, such as a file the workflow put in the form.
 */
export async function uploadGeneratedUiFile({
  scope,
  file,
  replaces,
  instanceId,
  onProgress,
}: {
  scope: BackofficeRoutableScope;
  file: File;
  replaces: GeneratedUiUploadedFile | null;
  instanceId: string;
  onProgress: (progress: UploadProgress) => void;
}): Promise<GeneratedUiUploadedFile> {
  const fileKey = `${runUploadsFolder(instanceId)}${crypto.randomUUID()}/${workspaceFileName(file.name)}`;
  const result = await createScopedUploadHelpers(scope).createUploadAndTransfer(file, {
    provider: UPLOAD_PROVIDER_DATABASE,
    fileKey,
    onProgress,
  });

  if (result.kind !== "published") {
    throw new Error("Generated UI uploads must publish their file to the workspace.");
  }

  const replacedFileKey = replaces?.path.slice("/workspace/".length);
  if (replaces && replacedFileKey?.startsWith(runUploadsFolder(instanceId))) {
    try {
      await createScopedUploadHelpers(replaces.scope).deleteFile(replacedFileKey, {
        provider: UPLOAD_PROVIDER_DATABASE,
      });
    } catch (error) {
      // The new file is uploaded and the form holds it; a leftover file must not undo that.
      console.error("Could not delete the replaced generated UI upload.", error);
    }
  }

  return {
    scope,
    path: `/workspace/${result.file.fileKey}`,
    filename: file.name,
    sizeBytes: result.file.sizeBytes,
    contentType: result.file.contentType,
  };
}
