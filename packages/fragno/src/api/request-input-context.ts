import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./internal/path";
import { FragnoApiValidationError } from "./api";

export type RequestBodyType =
  | unknown // JSON
  | FormData
  | Blob
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
  readonly #body: RequestBodyType;
  readonly #inputSchema: TInputSchema | undefined;
  readonly #shouldValidateInput: boolean;

  constructor(config: {
    path: TPath;
    method: string;
    pathParams: ExtractPathParams<TPath>;
    searchParams: URLSearchParams;
    body: RequestBodyType;

    request?: Request;
    inputSchema?: TInputSchema;
    shouldValidateInput?: boolean;
  }) {
    this.#path = config.path;
    this.#method = config.method;
    this.#pathParams = config.pathParams;
    this.#searchParams = config.searchParams;
    this.#body = config.body;
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
  }): Promise<RequestInputContext<TPath, TInputSchema>> {
    const url = new URL(config.request.url);

    // TODO: Support other body types other than json
    const json =
      config.request.body instanceof ReadableStream ? await config.request.json() : undefined;

    return new RequestInputContext({
      method: config.method,
      path: config.path,
      pathParams: config.pathParams,
      searchParams: url.searchParams,
      body: json,
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
  >(config: {
    method: string;
    path: TPath;
    pathParams: ExtractPathParams<TPath>;
    searchParams?: URLSearchParams;
    body: RequestBodyType;
  }): RequestInputContext<TPath, TInputSchema> {
    return new RequestInputContext({
      method: config.method,
      path: config.path,
      pathParams: config.pathParams,
      searchParams: config.searchParams ?? new URLSearchParams(),
      body: config.body,
      shouldValidateInput: false, // No input validation in SSR context
    });
  }

  get method(): string {
    return this.#method;
  }

  get path(): TPath {
    return this.#path;
  }

  get pathParams(): ExtractPathParams<TPath> {
    return this.#pathParams;
  }

  get query(): URLSearchParams {
    return this.#searchParams;
  }

  get rawBody(): RequestBodyType {
    return this.#body;
  }

  get input(): TInputSchema extends undefined
    ? undefined
    : {
        schema: TInputSchema;
        valid: () => Promise<
          TInputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TInputSchema> : never
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
          return;
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

    if (this.#body instanceof FormData || this.#body instanceof Blob) {
      throw new Error("Schema validation is only supported for JSON data, not FormData or Blob");
    }

    const result = await this.#inputSchema["~standard"].validate(this.#body);

    if (result.issues) {
      throw new FragnoApiValidationError("Validation failed", result.issues);
    }

    return result.value as TInputSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<TInputSchema>
      : never;
  }
}
