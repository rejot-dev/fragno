import type { FragnoRouteConfig } from "@fragno-dev/core";

import { UploadServiceError } from "../services/errors";

export const uploadErrorCodes = [
  "UPLOAD_NOT_FOUND",
  "UPLOAD_ALREADY_ACTIVE",
  "UPLOAD_EXPIRED",
  "UPLOAD_INVALID_STATE",
  "FILE_PRECONDITION_FAILED",
  "FILE_TOO_LARGE",
  "INVALID_FILE_KEY",
  "INVALID_CHECKSUM",
  "INVALID_REQUEST",
] as const;

type UploadRouteError<Code extends string> = Parameters<
  FragnoRouteConfig<"GET", "/__error", undefined, undefined, Code>["handler"]
>[1]["error"];

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
    case "FILE_PRECONDITION_FAILED":
      return error({ message: "File changed after it was read", code }, 412);
    case "FILE_TOO_LARGE":
      return error({ message: cause.message, code }, 413);
    case "UPLOAD_NOT_FOUND":
      return error({ message: "Upload not found", code }, 404);
    case "UPLOAD_ALREADY_ACTIVE":
      return error({ message: "Upload already active", code }, 409);
    case "UPLOAD_EXPIRED":
      return error({ message: "Upload expired", code }, 410);
    case "UPLOAD_INVALID_STATE":
      return error({ message: "Upload invalid state", code }, 409);
    case "INVALID_FILE_KEY":
      return error({ message: "Invalid file key", code }, 400);
    case "INVALID_CHECKSUM":
      return error({ message: "Invalid checksum", code }, 400);
    case "INVALID_REQUEST":
      return error({ message: "Invalid request", code }, 400);
    case "TEXT_INDEX_DISABLED":
      return error({ message: "Text index is disabled", code }, 400);
    case "TEXT_SEARCH_REGEX_UNSUPPORTED":
      return error({ message: "Regex search is not supported by the text index", code }, 400);
  }

  throw cause;
}
