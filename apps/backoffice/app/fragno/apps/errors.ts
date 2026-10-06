/** Domain failures shared by the app registry and organization installation boundaries. */
export type BackofficeAppErrorCode =
  | "APP_NOT_FOUND"
  | "APP_REGISTRATION_CONFLICT"
  | "APP_CURSOR_INVALID"
  | "APP_GRANTS_NOT_REQUESTED"
  | "APP_INSTALLATION_NOT_FOUND"
  | "APP_INSTALLATION_INACTIVE"
  | "APP_INSTALLATION_CONFLICT"
  | "APP_INSTALLATION_CURSOR_INVALID";

/** Known app failures are serialized at RPC boundaries; unexpected failures still propagate. */
export class BackofficeAppDomainError extends Error {
  override readonly name = "BackofficeAppDomainError";

  constructor(
    readonly code: BackofficeAppErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Domain failures retain their codes across Durable Object RPC. */
export type BackofficeAppOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: BackofficeAppErrorCode; message: string } };

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
