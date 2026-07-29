import type { FragnoRouteConfig } from "@fragno-dev/core";

import { UploadServiceError } from "../services/errors";
import type { UploadStatus } from "../types";

export const uploadErrorCodes = [
  "UPLOAD_NOT_FOUND",
  "UPLOAD_ALREADY_ACTIVE",
  "UPLOAD_METADATA_MISMATCH",
  "FILE_ALREADY_EXISTS",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "PROVIDER_MISMATCH",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
  "STORAGE_ERROR",
] as const;

type UploadErrorCode = (typeof uploadErrorCodes)[number];

type UploadRouteError<Code extends string> = Parameters<
  FragnoRouteConfig<"GET", "/__error", undefined, undefined, Code>["handler"]
>[1]["error"];

export function rejectInactiveUpload(
  upload: { status: UploadStatus; expiresAt: Date },
  error: UploadRouteError<UploadErrorCode>,
): Response | null {
  if (upload.status === "completed") {
    return error({ message: "File already exists", code: "FILE_ALREADY_EXISTS" }, 409);
  }

  if (upload.status === "prepared") {
    return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
  }

  if (upload.status === "expired" || upload.expiresAt.getTime() <= Date.now()) {
    return error({ message: "Upload expired", code: "UPLOAD_EXPIRED" }, 410);
  }

  if (upload.status === "aborted" || upload.status === "failed") {
    return error({ message: "Upload invalid state", code: "UPLOAD_INVALID_STATE" }, 409);
  }

  return null;
}

export function rejectProviderMismatch(
  upload: { provider: string },
  activeProvider: string,
  error: UploadRouteError<UploadErrorCode>,
): Response | null {
  if (upload.provider === activeProvider) {
    return null;
  }

  return error({ message: "Upload provider mismatch", code: "PROVIDER_MISMATCH" }, 409);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Each route supplies a narrower error callback, and Code keeps the shared mapper within that route's declared error union.
export function handleUploadServiceError<Code extends string>(
  cause: unknown,
  error: UploadRouteError<Code>,
): Response {
  if (!(cause instanceof UploadServiceError)) {
    throw cause;
  }

  const code = cause.code as Code;
  switch (cause.code) {
    case "FILE_NOT_FOUND":
      return error({ message: "File not found", code }, 404);
    case "FILE_DELETED":
      return error({ message: "File deleted", code }, 410);
    case "FILE_ALREADY_EXISTS":
      return error({ message: "File already exists", code }, 409);
    case "FILE_PRECONDITION_FAILED":
      return error({ message: "File changed after it was read", code }, 412);
    case "UPLOAD_NOT_FOUND":
      return error({ message: "Upload not found", code }, 404);
    case "UPLOAD_ALREADY_ACTIVE":
      return error({ message: "Upload already active", code }, 409);
    case "UPLOAD_METADATA_MISMATCH":
      return error({ message: "Upload metadata mismatch", code }, 409);
    case "UPLOAD_EXPIRED":
      return error({ message: "Upload expired", code }, 410);
    case "UPLOAD_INVALID_STATE":
      return error({ message: "Upload invalid state", code }, 409);
    case "PROVIDER_MISMATCH":
      return error({ message: "Upload provider mismatch", code }, 409);
    case "INVALID_FILE_KEY":
      return error({ message: "Invalid file key", code }, 400);
    case "INVALID_CHECKSUM":
      return error({ message: "Invalid checksum", code }, 400);
    case "INVALID_REQUEST":
      return error({ message: "Invalid request", code }, 400);
    case "STORAGE_ERROR":
      return error({ message: "Storage error", code }, 502);
    case "TEXT_INDEX_DISABLED":
      return error({ message: "Text index is disabled", code }, 400);
    case "TEXT_SEARCH_REGEX_UNSUPPORTED":
      return error({ message: "Regex search is not supported by the text index", code }, 400);
    case "TEXT_SEARCH_INVALID_QUERY":
      return error({ message: "Invalid text search query", code }, 400);
  }

  throw cause;
}
