import {
  BACKOFFICE_API_ERROR_STATUS,
  type BackofficeApiError,
  type BackofficeApiErrorCode,
} from "@fragno-dev/backoffice-api/errors";

/** An error response in the API's envelope; the code decides the status. */
export function apiError(
  code: BackofficeApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: { code, message } } satisfies BackofficeApiError, {
    status: BACKOFFICE_API_ERROR_STATUS[code],
    headers: { "cache-control": "no-store", ...headers },
  });
}
