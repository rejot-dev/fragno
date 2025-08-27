import type { StatusCode } from "../http/http-status";

export type FragnoErrorOptions = {
  cause?: Error | unknown;
};

/**
 * Base error class for all Fragno client errors.
 */
export abstract class FragnoClientError<TCode extends string = string> extends Error {
  readonly #code: TCode;

  constructor(message: string, code: TCode, options: FragnoErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "FragnoClientError";
    this.#code = code;
  }

  get code(): TCode | (string & {}) {
    return this.#code;
  }
}

export abstract class FragnoClientFetchError<
  TCode extends string = string,
> extends FragnoClientError<TCode> {
  constructor(message: string, code: TCode, options: FragnoErrorOptions = {}) {
    super(message, code, options);
    this.name = "FragnoClientFetchError";
  }

  static fromUnknownFetchError(error: unknown): FragnoClientFetchError {
    if (!(error instanceof Error)) {
      return new FragnoClientFetchNetworkError("Network request failed", { cause: error });
    }

    if (error.name === "AbortError") {
      return new FragnoClientFetchAbortError("Request was aborted", { cause: error });
    }

    return new FragnoClientFetchNetworkError("Network request failed", { cause: error });
  }
}

/**
 * Error thrown when a network request fails (e.g., no internet connection, DNS failure).
 */
export class FragnoClientFetchNetworkError extends FragnoClientFetchError<"NETWORK_ERROR"> {
  constructor(message: string = "Network request failed", options: FragnoErrorOptions = {}) {
    super(message, "NETWORK_ERROR", options);
    this.name = "FragnoClientFetchNetworkError";
  }
}

/**
 * Error thrown when a request is aborted (e.g., user cancels request, timeout).
 */
export class FragnoClientFetchAbortError extends FragnoClientFetchError<"ABORT_ERROR"> {
  constructor(message: string = "Request was aborted", options: FragnoErrorOptions = {}) {
    super(message, "ABORT_ERROR", options);
    this.name = "FragnoClientFetchAbortError";
  }
}

export class FragnoClientUnknownApiError extends FragnoClientError<"UNKNOWN_API_ERROR"> {
  readonly #status: StatusCode;

  constructor(
    message: string = "Unknown API error",
    status: StatusCode,
    options: FragnoErrorOptions = {},
  ) {
    super(message, "UNKNOWN_API_ERROR", options);
    this.name = "FragnoClientUnknownApiError";
    this.#status = status;
  }

  get status(): StatusCode {
    return this.#status;
  }
}

export class FragnoClientApiError<
  TErrorCode extends string = string,
> extends FragnoClientError<TErrorCode> {
  readonly #status: StatusCode;

  constructor(
    { message, code }: { message: string; code: TErrorCode },
    status: StatusCode,
    options: FragnoErrorOptions = {},
  ) {
    super(message, code, options);
    this.name = "FragnoClientApiError";
    this.#status = status;
  }

  get status(): StatusCode {
    return this.#status;
  }

  /**
   * The error code returned by the API.
   *
   * The type is `TErrorCode` (the set of known error codes for this route), but may also be a string
   * for forward compatibility with future error codes.
   */
  get code(): TErrorCode | (string & {}) {
    return super.code as TErrorCode | (string & {});
  }

  static async fromResponse<TErrorCode extends string = string>(
    response: Response,
  ): Promise<FragnoClientApiError<TErrorCode> | FragnoClientUnknownApiError> {
    const unknown = await response.json();
    const status = response.status as StatusCode;

    if (!("error" in unknown || "code" in unknown)) {
      return new FragnoClientUnknownApiError("Unknown API error", status);
    }

    if (!(typeof unknown.error === "string" && typeof unknown.code === "string")) {
      return new FragnoClientUnknownApiError("Unknown API error", status);
    }

    return new FragnoClientApiError(
      {
        message: unknown.error,
        code: unknown.code as TErrorCode,
      },
      status,
    );
  }
}
