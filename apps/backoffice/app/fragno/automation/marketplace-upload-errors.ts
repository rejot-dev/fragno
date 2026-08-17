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

type MarketplaceUploadRouteError = {
  code: string;
  message: string;
  issues?: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<PropertyKey>;
  }>;
};

const marketplaceUploadRouteErrorMessage = (error: MarketplaceUploadRouteError) => {
  if (!error.issues?.length) {
    return error.message;
  }

  const issueDetails = error.issues.map((issue) => {
    const path = issue.path?.length ? issue.path.map(String).join(".") : "request";
    return `${path}: ${issue.message}`;
  });
  return `${error.message}: ${issueDetails.join("; ")}`;
};

export const throwMarketplaceUploadRouteError = (input: {
  operation: string;
  status: number;
  error: MarketplaceUploadRouteError;
}): never =>
  throwMarketplaceUploadRequestError({
    operation: input.operation,
    status: input.status,
    code: input.error.code,
    message: marketplaceUploadRouteErrorMessage(input.error),
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
