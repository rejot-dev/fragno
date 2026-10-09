import { z } from "zod";

const backofficeApiErrorCodeSchema = z.enum([
  "invalid_request",
  "authentication_failed",
  "forbidden",
  "not_found",
  "operation_failed",
]);
export type BackofficeApiErrorCode = z.output<typeof backofficeApiErrorCodeSchema>;

/** Every error response carries this body; the status follows from the code alone. */
export const backofficeApiErrorSchema = z
  .strictObject({
    error: z.strictObject({
      code: backofficeApiErrorCodeSchema,
      message: z.string(),
    }),
  })
  .meta({ id: "BackofficeApiError" });
export type BackofficeApiError = z.output<typeof backofficeApiErrorSchema>;

export const BACKOFFICE_API_ERROR_STATUS = {
  invalid_request: 400,
  authentication_failed: 401,
  forbidden: 403,
  not_found: 404,
  // The operation ran and failed, e.g. a domain rule rejected the request.
  operation_failed: 422,
} as const satisfies Record<BackofficeApiErrorCode, number>;

export const BACKOFFICE_API_ERROR_DESCRIPTIONS = {
  invalid_request: "The scope or the request body is invalid.",
  authentication_failed: "The bearer credential is missing, invalid, or expired.",
  forbidden: "The credential may not perform this operation in this scope.",
  not_found: "The operation does not exist, or is not available to the credential in this scope.",
  operation_failed: "The operation ran and failed.",
} as const satisfies Record<BackofficeApiErrorCode, string>;
