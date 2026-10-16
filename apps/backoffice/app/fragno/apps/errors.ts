import {
  BackofficeOperationError,
  type BackofficeOperationErrorKind,
} from "@/backoffice-runtime/operation-error";

/** Domain failures shared by the app registry and organization installation boundaries. */
export type BackofficeAppErrorCode =
  | "APP_NOT_FOUND"
  | "APP_REGISTRATION_CONFLICT"
  | "APP_SLUG_TAKEN"
  | "APP_CURSOR_INVALID"
  | "APP_GRANTS_NOT_REQUESTED"
  | "APP_INSTALLATION_NOT_FOUND"
  | "APP_INSTALLATION_INACTIVE"
  | "APP_INSTALLATION_CONFLICT"
  | "APP_INSTALLATION_CURSOR_INVALID"
  | "APP_INSTALLATION_PROJECT_NOT_FOUND"
  | "APP_INSTALLATION_ACTIVATION_STALE"
  | "APP_INSTALLATION_ALREADY_CLAIMED"
  | "APP_INSTALLATION_UNCLAIMED"
  | "APP_INSTALLATION_OUT_OF_SCOPE"
  | "APP_ACTIONS_REVISION_STALE"
  | "APP_ACTION_NOT_FOUND"
  | "APP_ENDPOINT_UNREACHABLE";

const BACKOFFICE_APP_ERROR_KIND = {
  APP_NOT_FOUND: "not_found",
  APP_REGISTRATION_CONFLICT: "conflict",
  APP_SLUG_TAKEN: "conflict",
  APP_CURSOR_INVALID: "invalid_request",
  APP_GRANTS_NOT_REQUESTED: "invalid_request",
  APP_INSTALLATION_NOT_FOUND: "not_found",
  APP_INSTALLATION_INACTIVE: "conflict",
  APP_INSTALLATION_CONFLICT: "conflict",
  APP_INSTALLATION_CURSOR_INVALID: "invalid_request",
  APP_INSTALLATION_PROJECT_NOT_FOUND: "not_found",
  APP_INSTALLATION_ACTIVATION_STALE: "conflict",
  APP_INSTALLATION_ALREADY_CLAIMED: "conflict",
  APP_INSTALLATION_UNCLAIMED: "conflict",
  APP_INSTALLATION_OUT_OF_SCOPE: "forbidden",
  APP_ACTIONS_REVISION_STALE: "conflict",
  APP_ACTION_NOT_FOUND: "not_found",
  APP_ENDPOINT_UNREACHABLE: "operation_failed",
} as const satisfies Record<BackofficeAppErrorCode, BackofficeOperationErrorKind>;

/** Known app failures are serialized at RPC boundaries; unexpected failures still propagate. */
export class BackofficeAppDomainError extends BackofficeOperationError {
  override readonly name = "BackofficeAppDomainError";

  constructor(
    readonly code: BackofficeAppErrorCode,
    message: string,
  ) {
    super(BACKOFFICE_APP_ERROR_KIND[code], message);
  }
}

/** Domain failures retain their codes across Durable Object RPC. */
export type BackofficeAppOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: BackofficeAppErrorCode; message: string } };

/** Reconstructs domain errors serialized across Durable Object RPC boundaries. */
export function requireBackofficeAppOperationValue<T>(result: BackofficeAppOperationResult<T>): T {
  if (!result.ok) {
    throw new BackofficeAppDomainError(result.error.code, result.error.message);
  }
  return result.value;
}

/** Maps only known domain failures, including those raised during cross-object orchestration. */
export async function runBackofficeAppOperation<T>(
  operation: () => Promise<T>,
): Promise<BackofficeAppOperationResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof BackofficeAppDomainError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
}
