import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";

/**
 * How a caller should treat a failed operation. The HTTP API reports it as the error code of the
 * same name; Bash and Codemode show only the message.
 */
export type BackofficeOperationErrorKind = Exclude<BackofficeApiErrorCode, "authentication_failed">;

/** A failure with a known meaning for the caller, such as a missing or conflicting resource. */
export class BackofficeOperationError extends Error {
  constructor(
    readonly kind: BackofficeOperationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "BackofficeOperationError";
  }
}

/** Classifies a fragment route's failure status for errors that wrap route responses. */
export function backofficeOperationErrorKindForStatus(
  status: number,
): BackofficeOperationErrorKind {
  switch (status) {
    case 400:
      return "invalid_request";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    default:
      return "operation_failed";
  }
}
