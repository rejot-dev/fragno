import type { StatusCode } from "../http/http-status";

export class FragnoClientApiError<TErrorCode extends string = string> extends Error {
  readonly #status: StatusCode;
  readonly #code: TErrorCode;

  constructor({ message, code }: { message: string; code: TErrorCode }, status: StatusCode) {
    super(message);
    this.name = "FragnoClientApiError";
    this.#status = status;
    this.#code = code;
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
    return this.#code;
  }

  static async fromResponse<TErrorCode extends string = string>(
    response: Response,
  ): Promise<FragnoClientApiError<TErrorCode> | undefined> {
    const unknown = await response.json();

    if (!("error" in unknown || "code" in unknown)) {
      return undefined;
    }

    if (!(typeof unknown.error === "string" && typeof unknown.code === "string")) {
      return undefined;
    }

    return new FragnoClientApiError(
      {
        message: unknown.error,
        code: unknown.code as TErrorCode,
      },
      response.status as StatusCode,
    );
  }
}
