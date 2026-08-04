import type { UploadProgress } from "@fragno-dev/upload";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";
import { createScopedUploadHelpers } from "@/fragno/upload-client";

const safeFilenameExtension = (filename: string): string => {
  const extension = /\.([a-z0-9]{1,16})$/i.exec(filename)?.[1];
  return extension ? `.${extension.toLowerCase()}` : "";
};

export async function uploadPreparedGeneratedUiFile({
  scope,
  file,
  workflowName,
  instanceId,
  stepRecordId,
  onProgress,
}: {
  scope: BackofficeRoutableScope;
  file: File;
  workflowName: string;
  instanceId: string;
  stepRecordId: string;
  onProgress: (progress: UploadProgress) => void;
}): Promise<PreparedUploadedFileReference> {
  const fileKey = [
    "generated-ui",
    "workflows",
    encodeURIComponent(workflowName),
    encodeURIComponent(instanceId),
    encodeURIComponent(stepRecordId),
    `${crypto.randomUUID()}${safeFilenameExtension(file.name)}`,
  ].join("/");
  const result = await createScopedUploadHelpers(scope).createUploadAndTransfer(file, {
    fileKey,
    publicationMode: "batch",
    visibility: "private",
    onProgress,
  });

  if (result.kind !== "prepared") {
    throw new Error("Generated UI uploads must remain prepared until the workflow decides.");
  }

  return {
    kind: "prepared-upload",
    scope,
    uploadId: result.write.uploadId,
    provider: result.write.provider,
    fileKey: result.write.fileKey,
    filename: file.name,
    sizeBytes: result.write.sizeBytes,
    contentType: result.write.contentType,
    expiresAt: result.write.expiresAt,
  };
}
