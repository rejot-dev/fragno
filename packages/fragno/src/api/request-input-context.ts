import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./internal/path";
import { FragnoApiValidationError, type HTTPMethod } from "./api";
import type { MutableRequestState } from "./mutable-request-state";

export type RequestBodyType =
  | unknown // JSON
  | FormData
  | Blob
  | ReadableStream<Uint8Array>
  | null
  | undefined;

export class RequestInputContext<
  TPath extends string = string,
  TInputSchema extends StandardSchemaV1 | undefined = undefined,
> {
  readonly #path: TPath;
  readonly #method: string;
  readonly #pathParams: ExtractPathParams<TPath>;
  readonly #searchParams: URLSearchParams;
  readonly #headers: Headers;
  readonly #body: string | undefined;
  readonly #parsedBody: RequestBodyType;
  readonly #inputSchema: TInputSchema | undefined;
  readonly #shouldValidateInput: boolean;

  constructor(config: {
    path: TPath;
    method: string;
    pathParams: ExtractPathParams<TPath>;
    searchParams: URLSearchParams;
    parsedBody: RequestBodyType;
    rawBody?: string;
    headers: Headers;
    request?: Request;
    inputSchema?: TInputSchema;
    shouldValidateInput?: boolean;
  }) {
    this.#path = config.path;
    this.#method = config.method;
    this.#pathParams = config.pathParams;
    this.#searchParams = config.searchParams;
    this.#headers = config.headers;
    this.#body = config.rawBody;
    this.#parsedBody = config.parsedBody;
    this.#inputSchema = config.inputSchema;
    this.#shouldValidateInput = config.shouldValidateInput ?? true;
  }

  /**
   * Create a RequestContext from a Request object for server-side handling
   */
  static async fromRequest<
    TPath extends string,
    TInputSchema extends StandardSchemaV1 | undefined = undefined,
  >(config: {
    request: Request;
    method: string;
    path: TPath;
    pathParams: ExtractPathParams<TPath>;
    inputSchema?: TInputSchema;
    shouldValidateInput?: boolean;
    state: MutableRequestState;
    rawBody?: string;
  }): Promise<RequestInputContext<TPath, TInputSchema>> {
    // Use the mutable state (potentially modified by middleware)
    return new RequestInputContext({
      method: config.method,
      path: config.path,
      pathParams: config.state.pathParams as ExtractPathParams<TPath>,
      searchParams: config.state.searchParams,
      headers: config.state.headers,
      parsedBody: config.state.body,
      rawBody: config.rawBody,
      inputSchema: config.inputSchema,
      shouldValidateInput: config.shouldValidateInput,
    });
  }

  /**
   * Create a RequestContext for server-side rendering contexts (no Request object)
   */
  static fromSSRContext<
    TPath extends string,
    TInputSchema extends StandardSchemaV1 | undefined = undefined,
  >(
    config:
      | {
          method: "GET";
          path: TPath;
          pathParams: ExtractPathParams<TPath>;
          searchParams?: URLSearchParams;
          headers?: Headers;
        }
      | {
          method: Exclude<HTTPMethod, "GET">;
          path: TPath;
          pathParams: ExtractPathParams<TPath>;
          searchParams?: URLSearchParams;
          headers?: Headers;
          body: RequestBodyType;
          inputSchema?: TInputSchema;
        },
  ): RequestInputContext<TPath, TInputSchema> {
    return new RequestInputContext({
      method: config.method,
      path: config.path,
      pathParams: config.pathParams,
      searchParams: config.searchParams ?? new URLSearchParams(),
      headers: config.headers ?? new Headers(),
      parsedBody: "body" in config ? config.body : undefined,
      inputSchema: "inputSchema" in config ? config.inputSchema : undefined,
      shouldValidateInput: false, // No input validation in SSR context
    });
  }

  /**
   * The HTTP method as string (e.g., `GET`, `POST`)
   */
  get method(): string {
    return this.#method;
  }
  /**
   * The matched route path (e.g., `/users/:id`)
   * @remarks `string`
   */
  get path(): TPath {
    return this.#path;
  }
  /**
   * Extracted path parameters as object (e.g., `{ id: '123' }`)
   * @remarks `Record<string, string>`
   */
  get pathParams(): ExtractPathParams<TPath> {
    return this.#pathParams;
  }
  /**
   * [URLSearchParams](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) object for query parameters
   * @remarks `URLSearchParams`
   */
  get query(): URLSearchParams {
    return this.#searchParams;
  }
  /**
   * [Headers](https://developer.mozilla.org/en-US/docs/Web/API/Headers) object for request headers
   * @remarks `Headers`
   */
  get headers(): Headers {
    return this.#headers;
  }

  get rawBody(): string | undefined {
    return this.#body;
  }

  /**
   * Access the request body as FormData.
   *
   * Use this method when handling file uploads or multipart form submissions.
   * The request must have been sent with Content-Type: multipart/form-data.
   *
   * @throws Error if the request body is not FormData
   *
   * @example
   * ```typescript
   * defineRoute({
   *   method: "POST",
   *   path: "/upload",
   *   async handler(ctx, res) {
   *     const formData = ctx.formData();
   *     const file = formData.get("file") as File;
   *     const description = formData.get("description") as string;
   *     // ... process file
   *   }
   * });
   * ```
   */
  formData(): FormData {
    if (!(this.#parsedBody instanceof FormData)) {
      throw new Error(
        "Request body is not FormData. Ensure the request was sent with Content-Type: multipart/form-data.",
      );
    }
    return this.#parsedBody;
  }

  /**
   * Check if the request body is FormData.
   *
   * Useful for routes that accept both JSON and FormData payloads.
   *
   * @example
   * ```typescript
   * defineRoute({
   *   method: "POST",
   *   path: "/upload",
   *   async handler(ctx, res) {
   *     if (ctx.isFormData()) {
   *       const formData = ctx.formData();
   *       // handle file upload
   *     } else {
   *       const json = await ctx.input.valid();
   *       // handle JSON payload
   *     }
   *   }
   * });
   * ```
   */
  isFormData(): boolean {
    return this.#parsedBody instanceof FormData;
  }

  /**
   * Access the request body as a ReadableStream (application/octet-stream).
   *
   * @throws Error if the request body is not a ReadableStream
   */
  bodyStream(): ReadableStream<Uint8Array> {
    if (!(this.#parsedBody instanceof ReadableStream)) {
      throw new Error(
        "Request body is not a ReadableStream. Ensure the request was sent with Content-Type: application/octet-stream.",
      );
    }
    return this.#parsedBody;
  }

  /**
   * Check if the request body is a ReadableStream.
   */
  isBodyStream(): boolean {
    return this.#parsedBody instanceof ReadableStream;
  }

  /**
   * Input validation context (only if inputSchema is defined)
   * @remarks `InputContext`
   */
  get input(): TInputSchema extends undefined
    ? undefined
    : {
        schema: TInputSchema;
        valid: () => Promise<
          TInputSchema extends StandardSchemaV1
            ? StandardSchemaV1.InferOutput<TInputSchema>
            : unknown
        >;
      } {
    if (!this.#inputSchema) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return undefined as any;
    }

    return {
      schema: this.#inputSchema,
      valid: async () => {
        if (!this.#shouldValidateInput) {
          // In SSR context, return the body directly without validation
          return this.#parsedBody;
        }

        return this.#validateInput();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  async #validateInput(): Promise<
    TInputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TInputSchema> : never
  > {
    if (!this.#inputSchema) {
      throw new Error("No input schema defined for this route");
    }

    if (this.#parsedBody instanceof FormData || this.#parsedBody instanceof Blob) {
      throw new Error("Schema validation is only supported for JSON data, not FormData or Blob");
    }

    if (this.#parsedBody instanceof ReadableStream) {
      throw new Error(
        "Schema validation is only supported for JSON data, not FormData, Blob, or ReadableStream",
      );
    }

    const result = await this.#inputSchema["~standard"].validate(this.#parsedBody);

    if (result.issues) {
      throw new FragnoApiValidationError("Validation failed", result.issues);
    }

    return result.value as TInputSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<TInputSchema>
      : never;
  }
}
