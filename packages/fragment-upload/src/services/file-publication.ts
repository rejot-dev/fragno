import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { FragnoId } from "@fragno-dev/db/schema";

import type { FileHookPayload } from "../config";
import { uploadSchema } from "../schema";
import type { FileStatus, PreparedFileWrite, UploadFileWritePrecondition } from "../types";
import type { UploadMutationUnitOfWork } from "./context";
import { UploadServiceError } from "./errors";
import type { UploadSnapshot } from "./upload-model";
import { toSafeNumber } from "./upload-model";

export type FileRow = TableToColumnValues<typeof uploadSchema.tables.file>;
type ReadyFileRow = FileRow & { status: "ready" };
type RevisionFileWritePrecondition = Extract<UploadFileWritePrecondition, { kind: "revision" }>;
type FileWritePreconditionDetails = {
  uploadId?: string;
  provider: string;
  fileKey: string;
};

/** A file as a write reads it: with the `storage_object` row holding its content, if any. */
export type StoredFileRow = FileRow & { object: { id: FragnoId } | null };

/** Everything a file publishes about content stored under `objectKey`. */
export type FileContentSource = Pick<
  FileRow,
  | "key"
  | "provider"
  | "uploaderId"
  | "filename"
  | "contentType"
  | "checksum"
  | "visibility"
  | "tags"
  | "metadata"
  | "objectKey"
  | "sizeBytes"
> & { uploadId: string | null };

export function buildUploadHookPayload(
  upload: Pick<
    UploadSnapshot,
    "id" | "key" | "provider" | "uploaderId" | "contentType" | "objectKey" | "expectedSizeBytes"
  >,
): FileHookPayload {
  return {
    provider: upload.provider,
    fileKey: upload.key,
    objectKey: upload.objectKey,
    uploadId: upload.id.toString(),
    uploaderId: upload.uploaderId ?? null,
    sizeBytes: toSafeNumber(upload.expectedSizeBytes),
    contentType: upload.contentType,
  };
}

export function buildFileHookPayload(
  file: Pick<
    FileRow,
    "provider" | "key" | "objectKey" | "uploaderId" | "sizeBytes" | "contentType"
  >,
  uploadId?: string,
): FileHookPayload {
  return {
    provider: file.provider,
    fileKey: file.key,
    objectKey: file.objectKey,
    uploadId,
    uploaderId: file.uploaderId ?? null,
    sizeBytes: toSafeNumber(file.sizeBytes),
    contentType: file.contentType,
  };
}

export function assertFileWritePrecondition(
  file: FileRow | null,
  precondition: RevisionFileWritePrecondition,
  details?: FileWritePreconditionDetails,
): asserts file is ReadyFileRow;
export function assertFileWritePrecondition(
  file: FileRow | null,
  precondition: UploadFileWritePrecondition | undefined,
  details?: FileWritePreconditionDetails,
): void;
export function assertFileWritePrecondition(
  file: FileRow | null,
  precondition: UploadFileWritePrecondition | undefined,
  details?: FileWritePreconditionDetails,
): void {
  if (!precondition) {
    return;
  }

  if (precondition.kind === "absent") {
    if (file?.status === "ready") {
      throw new UploadServiceError(
        "FILE_PRECONDITION_FAILED",
        "A ready file already exists for the expected-absence write.",
        details,
      );
    }
    return;
  }

  if (file?.status !== "ready" || file.id.version !== precondition.revision) {
    throw new UploadServiceError(
      "FILE_PRECONDITION_FAILED",
      "The ready file revision does not match the write precondition.",
      details,
    );
  }
}

/**
 * Points the file at its new content and deletes the content it replaces, in the same transaction,
 * so no reader sees the file without content.
 */
export function publishFileContent(
  uow: UploadMutationUnitOfWork,
  existing: StoredFileRow | null,
  source: FileContentSource,
) {
  const now = uow.now();
  // Named field by field: callers pass wider rows, such as an upload's, whose `id` would otherwise
  // overwrite the file's and lose it to replicas that know the file by its ID.
  const content: Omit<FileContentSource, "uploadId"> = {
    key: source.key,
    provider: source.provider,
    uploaderId: source.uploaderId,
    filename: source.filename,
    contentType: source.contentType,
    checksum: source.checksum,
    visibility: source.visibility,
    tags: source.tags,
    metadata: source.metadata,
    objectKey: source.objectKey,
    sizeBytes: source.sizeBytes,
  };
  const fileRecord = {
    ...content,
    status: "ready" as FileStatus,
    deletedAt: null,
  };
  // Publication starts the file over, even when it replaces one.
  const persistedRecord = { ...fileRecord, createdAt: now, updatedAt: now, completedAt: now };
  const readyHookPayload = buildFileHookPayload(fileRecord, source.uploadId ?? undefined);
  uow.triggerHook("onFileReady", readyHookPayload);
  uow.triggerHook("onFileTextIndexRequested", readyHookPayload);

  if (existing) {
    uow.update("file", existing.id, (b) => b.set(persistedRecord).check());
    if (existing.object) {
      uow.delete("storage_object", existing.object.id);
    }
    return { id: existing.id, ...fileRecord, revision: existing.id.version + 1 };
  }

  const fileId = uow.create(
    "file",
    persistedRecord,
    // Retrying the whole transaction rereads the file the concurrent write created.
    { retryOnUniqueConflict: ({ error }) => error.kind === "unique" },
  );
  return { id: fileId, ...fileRecord, revision: fileId.version };
}

/** Marks the file deleted and deletes its content in the same transaction. */
export function deleteFileContent(uow: UploadMutationUnitOfWork, file: StoredFileRow) {
  const now = uow.now();
  uow.update("file", file.id, (b) =>
    b.set({ status: "deleted", updatedAt: now, deletedAt: now }).check(),
  );
  if (file.object) {
    uow.delete("storage_object", file.object.id);
  }
  uow.triggerHook("onFileDeleted", buildFileHookPayload(file));
  const { object: _object, ...row } = file;
  return { ...row, status: "deleted" as const, revision: file.id.version + 1 };
}

export function toPreparedFileWrite(upload: UploadSnapshot): PreparedFileWrite {
  return {
    uploadId: upload.id.toString(),
    provider: upload.provider,
    fileKey: upload.key,
    sizeBytes: toSafeNumber(upload.bytesUploaded),
    contentType: upload.contentType,
    checksum: upload.checksum,
    expiresAt: upload.expiresAt.toISOString(),
  };
}
