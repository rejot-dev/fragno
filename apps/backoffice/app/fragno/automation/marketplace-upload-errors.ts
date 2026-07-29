import { NonRetryableError } from "@fragno-dev/workflows/workflow";

const RETRYABLE_MARKETPLACE_UPLOAD_ERROR_CODES = new Set(["STORAGE_ERROR", "UPLOAD_EXPIRED"]);

class RetryableMarketplaceUploadRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(
      code
        ? `${operation} failed (${code}, HTTP ${status}): ${message}`
        : `${operation} failed (HTTP ${status}): ${message}`,
    );
    this.name = "RetryableMarketplaceUploadRequestError";
  }
}

class NonRetryableMarketplaceUploadRequestError extends NonRetryableError {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(
      code
        ? `${operation} failed (${code}, HTTP ${status}): ${message}`
        : `${operation} failed (HTTP ${status}): ${message}`,
    );
    this.name = "NonRetryableMarketplaceUploadRequestError";
  }
}

export const throwMarketplaceUploadRequestError = (input: {
  operation: string;
  status: number;
  code: string | null;
  message: string;
}): never => {
  if (
    (input.code && RETRYABLE_MARKETPLACE_UPLOAD_ERROR_CODES.has(input.code)) ||
    input.status === 408 ||
    input.status === 429 ||
    input.status >= 500
  ) {
    throw new RetryableMarketplaceUploadRequestError(
      input.operation,
      input.status,
      input.code,
      input.message,
    );
  }
  throw new NonRetryableMarketplaceUploadRequestError(
    input.operation,
    input.status,
    input.code,
    input.message,
  );
};

export const throwMarketplaceUploadRouteError = (input: {
  operation: string;
  status: number;
  error: { code: string; message: string };
}): never =>
  throwMarketplaceUploadRequestError({
    operation: input.operation,
    status: input.status,
    code: input.error.code,
    message: input.error.message,
  });

export const throwUnexpectedMarketplaceUploadResponse = (input: {
  operation: string;
  status: number;
}): never =>
  throwMarketplaceUploadRequestError({
    operation: input.operation,
    status: input.status,
    code: null,
    message: "Upload returned an unexpected response.",
  });
