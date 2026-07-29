import type { TableToColumnValues } from "@fragno-dev/db/query";

import type { FileHookPayload } from "../config";
import { uploadSchema } from "../schema";
import type { FileStatus, PreparedFileWrite, UploadFileWritePrecondition } from "../types";
import { UploadServiceError } from "./errors";
import type { UploadSnapshot } from "./upload-model";
import { toSafeNumber } from "./upload-model";

export type FileRow = TableToColumnValues<typeof uploadSchema.tables.file>;
type FilePublicationRecord = Omit<FileRow, "id" | "createdAt" | "updatedAt" | "completedAt">;
type UploadPublicationSource = Pick<
  UploadSnapshot,
  | "id"
  | "key"
  | "provider"
  | "uploaderId"
  | "filename"
  | "expectedSizeBytes"
  | "contentType"
  | "checksum"
  | "visibility"
  | "tags"
  | "metadata"
  | "objectKey"
>;

export type FilePublicationPlan = {
  fileRecord: FilePublicationRecord;
  readyHookPayload: FileHookPayload;
  supersededObjectHookPayload: FileHookPayload | null;
};

export function buildUploadHookPayload(
  upload: UploadPublicationSource,
  sizeBytes = upload.expectedSizeBytes,
): FileHookPayload {
  return {
    provider: upload.provider,
    fileKey: upload.key,
    objectKey: upload.objectKey,
    uploadId: upload.id.toString(),
    uploaderId: upload.uploaderId ?? null,
    sizeBytes: toSafeNumber(sizeBytes),
    contentType: upload.contentType,
  };
}

function buildFileHookPayload(file: FileRow): FileHookPayload {
  return {
    provider: file.provider,
    fileKey: file.key,
    objectKey: file.objectKey,
    uploaderId: file.uploaderId ?? null,
    sizeBytes: toSafeNumber(file.sizeBytes),
    contentType: file.contentType,
  };
}

export function assertFileWritePrecondition(
  file: FileRow | null,
  precondition: UploadFileWritePrecondition | undefined,
  details?: { uploadId?: string; provider: string; fileKey: string },
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

function buildFilePublicationRecord(
  upload: UploadPublicationSource,
  sizeBytes: bigint,
): FilePublicationRecord {
  return {
    key: upload.key,
    provider: upload.provider,
    uploaderId: upload.uploaderId ?? null,
    filename: upload.filename,
    sizeBytes,
    contentType: upload.contentType,
    checksum: upload.checksum ?? null,
    visibility: upload.visibility,
    tags: upload.tags ?? null,
    metadata: upload.metadata ?? null,
    status: "ready" as FileStatus,
    objectKey: upload.objectKey,
    deletedAt: null,
    errorCode: null,
    errorMessage: null,
  };
}

export function planFilePublication(
  upload: UploadPublicationSource,
  existingFile: FileRow | null,
  sizeBytes: bigint,
): FilePublicationPlan {
  if (existingFile?.objectKey === upload.objectKey) {
    throw new UploadServiceError(
      "STORAGE_ERROR",
      "A replacement upload must use a distinct storage object.",
    );
  }

  return {
    fileRecord: buildFilePublicationRecord(upload, sizeBytes),
    readyHookPayload: buildUploadHookPayload(upload, sizeBytes),
    supersededObjectHookPayload:
      existingFile && existingFile.status !== "deleted" ? buildFileHookPayload(existingFile) : null,
  };
}

export function toPreparedFileWrite(
  upload: UploadSnapshot,
  sizeBytes = upload.bytesUploaded,
): PreparedFileWrite {
  return {
    uploadId: upload.id.toString(),
    provider: upload.provider,
    fileKey: upload.key,
    objectKey: upload.objectKey,
    sizeBytes: toSafeNumber(sizeBytes),
    contentType: upload.contentType,
    checksum: upload.checksum,
    expiresAt: upload.expiresAt.toISOString(),
  };
}
