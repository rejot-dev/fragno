import type { TableToColumnValues } from "@fragno-dev/db/query";

import { uploadSchema } from "../schema";
import type { FileVisibility, UploadChecksum, UploadPublicationMode, UploadStatus } from "../types";
import { UploadServiceError } from "./errors";

export type CreateUploadInput = {
  keyParts?: readonly (string | number)[];
  fileKey?: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum?: UploadChecksum | null;
  tags?: string[];
  visibility?: FileVisibility;
  uploaderId?: string;
  metadata?: Record<string, unknown>;
  publicationMode?: UploadPublicationMode;
  replaceActiveUpload?: boolean;
};

type UploadRow = TableToColumnValues<typeof uploadSchema.tables.upload>;

export type UploadSnapshot = Omit<UploadRow, "status" | "publicationMode"> & {
  status: UploadStatus;
  publicationMode: UploadPublicationMode;
};

export type ActiveUploadSnapshot = Omit<UploadSnapshot, "status"> & {
  status: "created" | "in_progress";
};

export type UploadSessionSnapshot = Pick<
  ActiveUploadSnapshot,
  "id" | "key" | "status" | "publicationMode" | "expiresAt"
>;

export type NormalizedUploadInput = {
  keyParts?: readonly (string | number)[];
  fileKey?: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum: UploadChecksum | null;
  tags: string[] | null;
  visibility: FileVisibility;
  uploaderId: string | null;
  metadata: Record<string, unknown> | null;
  publicationMode: UploadPublicationMode;
  expectedSizeBytes: bigint;
};

const DEFAULT_VISIBILITY: FileVisibility = "private";
const MAX_SAFE_SIZE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);

export function toUploadSnapshot(upload: UploadRow): UploadSnapshot {
  return upload as UploadSnapshot;
}

export function toBigInt(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

export function toSafeNumber(value: bigint): number {
  if (value > MAX_SAFE_SIZE_BYTES) {
    throw new UploadServiceError("INVALID_REQUEST", "The upload size exceeds the safe range.");
  }
  return Number(value);
}

export function normalizeUploadInput(input: CreateUploadInput): NormalizedUploadInput {
  return {
    ...input,
    uploaderId: input.uploaderId ?? null,
    visibility: input.visibility ?? DEFAULT_VISIBILITY,
    checksum: input.checksum ?? null,
    tags: input.tags ?? null,
    metadata: input.metadata ?? null,
    publicationMode: input.publicationMode ?? "immediate",
    expectedSizeBytes: toBigInt(input.sizeBytes),
  };
}

function isFinalizedUploadStatus(status: UploadStatus): boolean {
  return (
    status === "prepared" ||
    status === "completed" ||
    status === "aborted" ||
    status === "failed" ||
    status === "expired"
  );
}

export function isTerminalUploadStatus(status: UploadStatus): boolean {
  return (
    status === "completed" || status === "aborted" || status === "failed" || status === "expired"
  );
}

export function ensureActiveUpload(upload: UploadSnapshot): void {
  if (upload.status === "expired") {
    throw new UploadServiceError("UPLOAD_EXPIRED", "The upload has expired.");
  }
  if (isFinalizedUploadStatus(upload.status)) {
    throw new UploadServiceError(
      "UPLOAD_INVALID_STATE",
      `Uploads in the '${upload.status}' state are not active.`,
    );
  }
}

export function pickActiveUpload(uploads: UploadSnapshot[]): ActiveUploadSnapshot | null {
  const active = uploads.filter(
    (upload): upload is ActiveUploadSnapshot => !isFinalizedUploadStatus(upload.status),
  );
  if (active.length === 0) {
    return null;
  }
  return active.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }

  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }

  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]),
  );
};

export function uploadMetadataMatches(
  upload: UploadSnapshot,
  input: NormalizedUploadInput,
): boolean {
  const checksumMatches =
    upload.checksum === null
      ? input.checksum === null
      : input.checksum !== null &&
        upload.checksum.algo === input.checksum.algo &&
        upload.checksum.value === input.checksum.value;
  const tagsMatch =
    upload.tags === null
      ? input.tags === null
      : input.tags !== null &&
        upload.tags.length === input.tags.length &&
        upload.tags.every((tag, index) => tag === input.tags?.[index]);
  const metadataMatches = jsonValuesEqual(upload.metadata, input.metadata);

  return (
    upload.filename === input.filename &&
    upload.contentType === input.contentType &&
    upload.visibility === input.visibility &&
    (upload.uploaderId ?? null) === input.uploaderId &&
    upload.expectedSizeBytes === input.expectedSizeBytes &&
    upload.publicationMode === input.publicationMode &&
    checksumMatches &&
    tagsMatch &&
    metadataMatches
  );
}
