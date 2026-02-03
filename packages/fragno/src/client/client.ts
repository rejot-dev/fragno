import { nanoquery, type FetcherStore, type MutatorStore } from "@nanostores/query";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { computed, task, type ReadableAtom, type Store } from "nanostores";
import type {
  FragnoRouteConfig,
  HTTPMethod,
  NonGetHTTPMethod,
  RequestThisContext,
  RouteContentType,
} from "../api/api";
import {
  buildPath,
  extractPathParams,
  type ExtractPathParams,
  type ExtractPathParamsOrWiden,
  type MaybeExtractPathParamsOrWiden,
} from "../api/internal/path";
import { getMountRoute } from "../api/internal/route";
import { RequestInputContext } from "../api/request-input-context";
import { RequestOutputContext } from "../api/request-output-context";
import type {
  FetcherConfig,
  FragnoFragmentSharedConfig,
  FragnoPublicClientConfig,
  FragnoPublicConfig,
} from "../api/shared-types";
import { FragnoClientApiError, FragnoClientError, FragnoClientFetchError } from "./client-error";
import type { InferOr } from "../util/types-util";
import { parseContentType } from "../util/content-type";
import {
  handleNdjsonStreamingFirstItem,
  type NdjsonStreamingStore,
} from "./internal/ndjson-streaming";
import { addStore, getInitialData, SSR_ENABLED } from "../util/ssr";
import { unwrapObject } from "../util/nanostores";
import type { FragmentDefinition } from "../api/fragment-definition-builder";
import type { AnyFragnoInstantiatedFragment } from "../api/fragment-instantiator";
import {
  type AnyRouteOrFactory,
  type FlattenRouteFactories,
  resolveRouteFactories,
} from "../api/route";
import { mergeFetcherConfigs } from "./internal/fetcher-merge";

/**
 * Symbols used to identify hook types
 */
const GET_HOOK_SYMBOL = Symbol("fragno-get-hook");
const MUTATOR_HOOK_SYMBOL = Symbol("fragno-mutator-hook");
const STORE_SYMBOL = Symbol("fragno-store");

/**
 * Check if a value contains files that should be sent as FormData.
 * @internal
 */
function containsFiles(value: unknown): boolean {
  if (value instanceof File || value instanceof Blob) {
    return true;
  }

  if (value instanceof FormData) {
    return true;
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(
      (v) => v instanceof File || v instanceof Blob || v instanceof FormData,
    );
  }

  return false;
}

/**
 * Convert an object containing files to FormData.
 * Handles nested File/Blob values by appending them directly.
 * Other values are JSON-stringified.
 * @internal
 */
function toFormData(value: object): FormData {
  const formData = new FormData();

  for (const [key, val] of Object.entries(value)) {
    if (val instanceof File) {
      formData.append(key, val, val.name);
    } else if (val instanceof Blob) {
      formData.append(key, val);
    } else if (val !== undefined && val !== null) {
      // For non-file values, stringify if needed
      formData.append(key, typeof val === "string" ? val : JSON.stringify(val));
    }
  }

  return formData;
}

/**
 * Prepare request body and headers for sending.
 * Handles FormData (file uploads) vs JSON data.
 * @internal
 */
function prepareRequestBody(
  body: unknown,
  contentType?: RouteContentType,
): { body: BodyInit | undefined; headers?: HeadersInit } {
  if (body === undefined) {
    return { body: undefined };
  }

  if (contentType === "application/octet-stream") {
    if (
      body instanceof ReadableStream ||
      body instanceof Blob ||
      body instanceof File ||
      body instanceof ArrayBuffer ||
      body instanceof Uint8Array
    ) {
      return { body: body as BodyInit, headers: { "Content-Type": "application/octet-stream" } };
    }

    throw new Error(
      "Octet-stream routes only accept Blob, File, ArrayBuffer, Uint8Array, or ReadableStream bodies.",
    );
  }

  // If already FormData, send as-is (browser sets Content-Type with boundary)
  if (body instanceof FormData) {
    return { body };
  }

  // If body is directly a File or Blob, wrap it in FormData
  if (body instanceof File) {
    const formData = new FormData();
    formData.append("file", body, body.name);
    return { body: formData };
  }

  if (body instanceof Blob) {
    const formData = new FormData();
    formData.append("file", body);
    return { body: formData };
  }

  // If object contains files, convert to FormData
  if (typeof body === "object" && body !== null && containsFiles(body)) {
    return { body: toFormData(body) };
  }

  // Otherwise, JSON-stringify
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

/**
 * Merge request headers from multiple sources.
 * Returns undefined if there are no headers to merge.
 * @internal
 */
function mergeRequestHeaders(
  ...headerSources: (HeadersInit | undefined)[]
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  let hasHeaders = false;

  for (const source of headerSources) {
    if (!source) {
      continue;
    }

    if (source instanceof Headers) {
      for (const [key, value] of source.entries()) {
        result[key] = value;
        hasHeaders = true;
      }
    } else if (Array.isArray(source)) {
      for (const [key, value] of source) {
        result[key] = value;
        hasHeaders = true;
      }
    } else {
      for (const [key, value] of Object.entries(source)) {
        result[key] = value;
        hasHeaders = true;
      }
    }
  }

  return hasHeaders ? result : undefined;
}

/**
 * Extract only GET routes from a library config's routes array
 * @internal
 */
export type ExtractGetRoutes<
  T extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<
    infer Method,
    infer Path,
    infer Input,
    infer Output,
    infer ErrorCode,
    infer QueryParams
  >
    ? Method extends "GET"
      ? FragnoRouteConfig<Method, Path, Input, Output, ErrorCode, QueryParams>
      : never
    : never;
}[number][];

/**
 * Extract the path from a route configuration for a given method
 * @internal
 */
export type ExtractRoutePath<
  T extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TExpectedMethod extends HTTPMethod = HTTPMethod,
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<
    infer Method,
    infer Path,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >
    ? Method extends TExpectedMethod
      ? Path
      : never
    : never;
}[number];

/**
 * @internal
 */
export type ExtractGetRoutePaths<
  T extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> = ExtractRoutePath<T, "GET">;

/**
 * @internal
 */
export type ExtractNonGetRoutePaths<
  T extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> = ExtractRoutePath<T, NonGetHTTPMethod>;

/**
 * Extract the route configuration type(s) for a given path from a routes array.
 * Optionally narrow by HTTP method via the third type parameter.
 *
 * Defaults to extracting all methods for the matching path, producing a union
 * if multiple methods exist for the same path.
 * @internal
 */
export type ExtractRouteByPath<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TPath extends string,
  TMethod extends HTTPMethod = HTTPMethod,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends FragnoRouteConfig<
    infer M,
    TPath,
    infer Input,
    infer Output,
    infer ErrorCode,
    infer QueryParams
  >
    ? M extends TMethod
      ? FragnoRouteConfig<M, TPath, Input, Output, ErrorCode, QueryParams>
      : never
    : never;
}[number];

/**
 * Extract the output schema type for a specific route path from a routes array
 * @internal
 */
export type ExtractOutputSchemaForPath<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TPath extends string,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends FragnoRouteConfig<
    infer Method,
    TPath,
    StandardSchemaV1 | undefined,
    infer Output
  >
    ? Method extends "GET"
      ? Output
      : never
    : never;
}[number];

/**
 * Check if a path exists as a GET route in the routes array
 * @internal
 */
export type IsValidGetRoutePath<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TPath extends string,
> = TPath extends ExtractGetRoutePaths<TRoutes> ? true : false;

/**
 * Utility type to ensure only valid GET route paths can be used
 * @internal
 */
export type ValidateGetRoutePath<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TPath extends string,
> =
  TPath extends ExtractGetRoutePaths<TRoutes>
    ? TPath
    : `Error: Path '${TPath}' is not a valid GET route. Available GET routes: ${ExtractGetRoutePaths<TRoutes>}`;

/**
 * Helper type to check if a routes array has any GET routes
 * @internal
 */
export type HasGetRoutes<
  T extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> = ExtractGetRoutePaths<T> extends never ? false : true;

/**
 * @internal
 */
export type ObjectContainingStoreField<T extends object> = T extends Store
  ? T
  : {
        [K in keyof T]: T[K] extends Store ? { [P in K]: T[P] } & Partial<Omit<T, K>> : never;
      }[keyof T] extends never
    ? never
    : T;

/**
 * @internal
 */
export type FragnoStoreData<T extends object> = {
  obj: T;
  [STORE_SYMBOL]: true;
};

export type FragnoClientHookData<
  TMethod extends HTTPMethod,
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
> = {
  route: FragnoRouteConfig<
    TMethod,
    TPath,
    StandardSchemaV1 | undefined,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  >;
  query(args?: {
    path?: MaybeExtractPathParamsOrWiden<TPath, string>;
    query?: Record<TQueryParameters, string | undefined>;
  }): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
  store(args?: {
    path?: MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>;
    query?: Record<TQueryParameters, string | undefined | ReadableAtom<string | undefined>>;
  }): FetcherStore<StandardSchemaV1.InferOutput<TOutputSchema>, FragnoClientError<TErrorCode>>;
  [GET_HOOK_SYMBOL]: true;
} & {
  // Phantom field that preserves the specific TOutputSchema type parameter
  // in the structural type. This makes the type covariant, allowing more
  // specific schema types (like z.ZodString) to be assigned to variables
  // typed with more general schema types (like StandardSchemaV1<any, any>)
  readonly _outputSchema?: TOutputSchema;
};

export type FragnoClientMutatorData<
  TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
> = {
  route: FragnoRouteConfig<
    TMethod,
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  >;

  mutateQuery(args?: {
    body?: InferOr<TInputSchema, undefined>;
    path?: MaybeExtractPathParamsOrWiden<TPath, string>;
    query?: Record<TQueryParameters, string | undefined>;
  }): Promise<InferOr<TOutputSchema, undefined>>;

  mutatorStore: MutatorStore<
    {
      body?: InferOr<TInputSchema, undefined>;
      path?: MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>;
      query?: Record<TQueryParameters, string | undefined | ReadableAtom<string | undefined>>;
    },
    InferOr<TOutputSchema, undefined>,
    FragnoClientError<TErrorCode>
  >;
  [MUTATOR_HOOK_SYMBOL]: true;
} & {
  readonly _inputSchema?: TInputSchema;
  readonly _outputSchema?: TOutputSchema;
};

/**
 * @internal
 */
export function buildUrl<TPath extends string>(
  config: {
    baseUrl?: string;
    mountRoute: string;
    path: TPath;
  },
  params: {
    pathParams?: Record<string, string | ReadableAtom<string>>;
    queryParams?: Record<string, string | undefined | ReadableAtom<string | undefined>>;
  },
): string {
  const { baseUrl = "", mountRoute, path } = config;
  const { pathParams, queryParams } = params ?? {};

  const normalizedPathParams = unwrapObject(pathParams) as ExtractPathParams<TPath, string>;
  const normalizedQueryParams = unwrapObject(queryParams) ?? {};

  // Filter out undefined values to prevent URLSearchParams from converting them to string "undefined"
  const filteredQueryParams = Object.fromEntries(
    Object.entries(normalizedQueryParams).filter(([_, value]) => value !== undefined),
  ) as Record<string, string>;

  const searchParams = new URLSearchParams(filteredQueryParams);
  const builtPath = buildPath(path, normalizedPathParams ?? {});
  const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
  return `${baseUrl}${mountRoute}${builtPath}${search}`;
}

/**
 * This method returns an array, which can be passed directly to nanostores.
 *
 * The returned array is always: path, pathParams (In order they appear in the path), queryParams (In alphabetical order)
 * Missing pathParams are replaced with "<missing>".
 * Atoms with undefined values are wrapped in computed atoms that map undefined to "" to avoid nanoquery treating the key as incomplete.
 * @param path
 * @param params
 * @returns
 * @internal
 */
export function getCacheKey<TMethod extends HTTPMethod, TPath extends string>(
  method: TMethod,
  path: TPath,
  params?: {
    pathParams?: Record<string, string | ReadableAtom<string>>;
    queryParams?: Record<string, string | undefined | ReadableAtom<string | undefined>>;
  },
): (string | ReadableAtom<string>)[] {
  if (!params) {
    return [method, path];
  }

  const { pathParams, queryParams } = params;

  const pathParamNames = extractPathParams(path);
  const pathParamValues = pathParamNames.map((name) => pathParams?.[name] ?? "<missing>");

  const queryParamValues = queryParams
    ? Object.keys(queryParams)
        .sort()
        .map((key) => {
          const value = queryParams[key];
          // If it's an atom, wrap it to convert undefined to ""
          if (value && typeof value === "object" && "get" in value) {
            return computed(value as ReadableAtom<string | undefined>, (v) => v ?? "");
          }
          // Plain string value (or undefined)
          return value ?? "";
        })
    : [];

  return [method, path, ...pathParamValues, ...queryParamValues];
}

function isStreamingResponse(response: Response): false | "ndjson" | "octet-stream" {
  const contentType = parseContentType(response.headers.get("content-type"));

  if (!contentType) {
    // Always assume 'normal' JSON by default.
    return false;
  }

  const isChunked = response.headers.get("transfer-encoding") === "chunked";

  if (!isChunked) {
    return false;
  }

  if (contentType.subtype === "octet-stream") {
    // TODO(Wilco): This is not actually supported properly
    return "octet-stream";
  }

  if (contentType.subtype === "x-ndjson") {
    return "ndjson";
  }

  return false;
}

// Type guard to check if a hook is a GET hook
/**
 * @internal
 */
export function isGetHook<
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: unknown,
): hook is FragnoClientHookData<"GET", TPath, TOutputSchema, TErrorCode, TQueryParameters> {
  return (
    typeof hook === "object" &&
    hook !== null &&
    GET_HOOK_SYMBOL in hook &&
    hook[GET_HOOK_SYMBOL] === true
  );
}

// Type guard to check if a hook is a mutator
/**
 * @internal
 */
export function isMutatorHook<
  TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: unknown,
): hook is FragnoClientMutatorData<
  TMethod,
  TPath,
  TInputSchema,
  TOutputSchema,
  TErrorCode,
  TQueryParameters
> {
  return (
    typeof hook === "object" &&
    hook !== null &&
    MUTATOR_HOOK_SYMBOL in hook &&
    hook[MUTATOR_HOOK_SYMBOL] === true
  );
}

/**
 * @internal
 */
export function isStore<TStore extends Store>(obj: unknown): obj is FragnoStoreData<TStore> {
  return (
    typeof obj === "object" && obj !== null && STORE_SYMBOL in obj && obj[STORE_SYMBOL] === true
  );
}

type OnErrorRetryFn = (opts: {
  error: unknown;
  key: string;
  retryCount: number;
}) => number | undefined;

export type CreateHookOptions = {
  /**
   * A function that will be called when an error occurs. Implements an exponential backoff strategy
   * when left undefined. When null, retries will be disabled. The number returned (> 0) by the
   * callback will determine in how many ms to retry next.
   */
  onErrorRetry?: OnErrorRetryFn | null;
};

type OnInvalidateFn<TPath extends string> = (
  invalidate: <TInnerPath extends string>(
    method: HTTPMethod,
    path: TInnerPath,
    params: {
      pathParams?: MaybeExtractPathParamsOrWiden<TInnerPath, string>;
      queryParams?: Record<string, string>;
    },
  ) => void,
  params: {
    pathParams: MaybeExtractPathParamsOrWiden<TPath, string>;
    queryParams?: Record<string, string>;
  },
) => void;

/**
 * @internal
 */
export type CacheLine = {
  data: unknown;
  error: unknown;
  retryCount: number;
  created: number;
  expires: number;
};

export class ClientBuilder<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TFragmentConfig extends FragnoFragmentSharedConfig<TRoutes>,
> {
  #publicConfig: FragnoPublicClientConfig;
  #fragmentConfig: TFragmentConfig;
  #fetcherConfig?: FetcherConfig;

  #cache = new Map<string, CacheLine>();

  #createFetcherStore;
  #createMutatorStore;
  #invalidateKeys;

  constructor(publicConfig: FragnoPublicClientConfig, fragmentConfig: TFragmentConfig) {
    this.#publicConfig = publicConfig;
    this.#fragmentConfig = fragmentConfig;
    this.#fetcherConfig = publicConfig.fetcherConfig;

    const [createFetcherStore, createMutatorStore, { invalidateKeys }] = nanoquery({
      cache: this.#cache,
    });
    this.#createFetcherStore = createFetcherStore;
    this.#createMutatorStore = createMutatorStore;
    this.#invalidateKeys = invalidateKeys;
  }

  get cacheEntries(): Readonly<Record<string, CacheLine>> {
    return Object.fromEntries(this.#cache.entries());
  }

  createStore<const T extends object>(obj: T): FragnoStoreData<T> {
    return { obj: obj, [STORE_SYMBOL]: true };
  }

  /**
   * Build a URL for a custom backend call using the configured baseUrl and mountRoute.
   * Useful for fragment authors who need to make custom fetch calls.
   */
  buildUrl<TPath extends string>(
    path: TPath,
    params?: {
      path?: MaybeExtractPathParamsOrWiden<TPath, string>;
      query?: Record<string, string>;
    },
  ): string {
    const baseUrl = this.#publicConfig.baseUrl ?? "";
    const mountRoute = getMountRoute({
      name: this.#fragmentConfig.name,
      mountRoute: this.#publicConfig.mountRoute,
    });

    return buildUrl(
      { baseUrl, mountRoute, path },
      { pathParams: params?.path, queryParams: params?.query },
    );
  }

  /**
   * Get the configured fetcher function for custom backend calls.
   * Returns fetch with merged options applied.
   */
  getFetcher(): {
    fetcher: typeof fetch;
    defaultOptions: RequestInit | undefined;
  } {
    return {
      fetcher: this.#getFetcher(),
      defaultOptions: this.#getFetcherOptions(),
    };
  }

  #getFetcher(): typeof fetch {
    if (this.#fetcherConfig?.type === "function") {
      return this.#fetcherConfig.fetcher;
    }
    return fetch;
  }

  #getFetcherOptions(): RequestInit | undefined {
    if (this.#fetcherConfig?.type === "options") {
      return this.#fetcherConfig.options;
    }
    return undefined;
  }

  createHook<TPath extends ExtractGetRoutePaths<TFragmentConfig["routes"]>>(
    path: ValidateGetRoutePath<TFragmentConfig["routes"], TPath>,
    options?: CreateHookOptions,
  ): FragnoClientHookData<
    "GET",
    TPath,
    NonNullable<ExtractRouteByPath<TFragmentConfig["routes"], TPath, "GET">["outputSchema"]>,
    NonNullable<ExtractRouteByPath<TFragmentConfig["routes"], TPath, "GET">["errorCodes"]>[number],
    NonNullable<
      ExtractRouteByPath<TFragmentConfig["routes"], TPath, "GET">["queryParameters"]
    >[number]
  > {
    const route = this.#fragmentConfig.routes.find(
      (
        r,
      ): r is FragnoRouteConfig<
        "GET",
        TPath,
        StandardSchemaV1 | undefined,
        StandardSchemaV1,
        string,
        string
      > => r.path === path && r.method === "GET" && r.outputSchema !== undefined,
    );

    if (!route) {
      throw new Error(`Route '${path}' not found or is not a GET route with an output schema.`);
    }

    return this.#createRouteQueryHook(route, options);
  }

  createMutator<TPath extends ExtractNonGetRoutePaths<TFragmentConfig["routes"]>>(
    method: NonGetHTTPMethod,
    path: TPath,
    onInvalidate?: OnInvalidateFn<TPath>,
  ): FragnoClientMutatorData<
    NonGetHTTPMethod, // TODO: This can be any Method, but should be related to TPath
    TPath,
    ExtractRouteByPath<TFragmentConfig["routes"], TPath>["inputSchema"],
    ExtractRouteByPath<TFragmentConfig["routes"], TPath>["outputSchema"],
    NonNullable<ExtractRouteByPath<TFragmentConfig["routes"], TPath>["errorCodes"]>[number],
    NonNullable<ExtractRouteByPath<TFragmentConfig["routes"], TPath>["queryParameters"]>[number]
  > {
    type TRoute = ExtractRouteByPath<TFragmentConfig["routes"], TPath>;

    const route = this.#fragmentConfig.routes.find(
      (
        r,
      ): r is FragnoRouteConfig<
        NonGetHTTPMethod,
        TPath,
        TRoute["inputSchema"],
        TRoute["outputSchema"],
        string,
        string
      > => r.method !== "GET" && r.path === path && r.method === method,
    );

    if (!route) {
      throw new Error(
        `Route '${path}' not found or is a GET route with an input and output schema.`,
      );
    }

    return this.#createRouteQueryMutator(route, onInvalidate);
  }

  #createRouteQueryHook<
    TPath extends string,
    TInputSchema extends StandardSchemaV1 | undefined,
    TOutputSchema extends StandardSchemaV1,
    TErrorCode extends string,
    TQueryParameters extends string,
  >(
    route: FragnoRouteConfig<
      "GET",
      TPath,
      TInputSchema,
      TOutputSchema,
      TErrorCode,
      TQueryParameters
    >,
    options: CreateHookOptions = {},
  ): FragnoClientHookData<"GET", TPath, TOutputSchema, TErrorCode, TQueryParameters> {
    if (route.method !== "GET") {
      throw new Error(
        `Only GET routes are supported for hooks. Route '${route.path}' is a ${route.method} route.`,
      );
    }

    if (!route.outputSchema) {
      throw new Error(
        `Output schema is required for GET routes. Route '${route.path}' has no output schema.`,
      );
    }

    const baseUrl = this.#publicConfig.baseUrl ?? "";
    const mountRoute = getMountRoute({
      name: this.#fragmentConfig.name,
      mountRoute: this.#publicConfig.mountRoute,
    });
    const fetcher = this.#getFetcher();
    const fetcherOptions = this.#getFetcherOptions();

    async function callServerSideHandler(params: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | undefined | ReadableAtom<string | undefined>>;
    }): Promise<Response> {
      const { pathParams, queryParams } = params ?? {};

      const normalizedPathParams = unwrapObject(pathParams) as ExtractPathParams<TPath, string>;
      const normalizedQueryParams = unwrapObject(queryParams) ?? {};

      // Filter out undefined values to prevent URLSearchParams from converting them to string "undefined"
      const filteredQueryParams = Object.fromEntries(
        Object.entries(normalizedQueryParams).filter(([_, value]) => value !== undefined),
      ) as Record<string, string>;

      const searchParams = new URLSearchParams(filteredQueryParams);

      const result = await route.handler(
        RequestInputContext.fromSSRContext({
          method: route.method,
          path: route.path,
          pathParams: normalizedPathParams,
          searchParams,
        }),
        new RequestOutputContext(route.outputSchema),
      );

      return result;
    }

    async function executeQuery(params?: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | undefined | ReadableAtom<string | undefined>>;
    }): Promise<Response> {
      const { pathParams, queryParams } = params ?? {};

      if (typeof window === "undefined") {
        return task(async () => callServerSideHandler({ pathParams, queryParams }));
      }

      const url = buildUrl({ baseUrl, mountRoute, path: route.path }, { pathParams, queryParams });

      let response: Response;
      try {
        response = fetcherOptions ? await fetcher(url, fetcherOptions) : await fetcher(url);
      } catch (error) {
        throw FragnoClientFetchError.fromUnknownFetchError(error);
      }

      if (!response.ok) {
        throw await FragnoClientApiError.fromResponse<TErrorCode>(response);
      }

      return response;
    }

    return {
      route,
      store: (args) => {
        const { path, query } = args ?? {};

        const key = getCacheKey(route.method, route.path, {
          pathParams: path,
          queryParams: query,
        });

        const store = this.#createFetcherStore<
          StandardSchemaV1.InferOutput<TOutputSchema>,
          FragnoClientError<TErrorCode>
        >(key, {
          fetcher: async (): Promise<StandardSchemaV1.InferOutput<TOutputSchema>> => {
            if (SSR_ENABLED) {
              const initialData = getInitialData(
                key.map((d) => (typeof d === "string" ? d : d.get())).join(""),
              );

              if (initialData) {
                return initialData;
              }
            }

            const response = await executeQuery({ pathParams: path, queryParams: query });
            const isStreaming = isStreamingResponse(response);

            if (!isStreaming) {
              return response.json() as Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
            }

            if (typeof window === "undefined") {
              return [];
            }

            if (isStreaming === "ndjson") {
              const storeAdapter: NdjsonStreamingStore<TOutputSchema, TErrorCode> = {
                setData: (value) => {
                  store.set({
                    ...store.get(),
                    loading: !(Array.isArray(value) && value.length > 0),
                    data: value as InferOr<TOutputSchema, undefined>,
                  });
                },
                setError: (value) => {
                  store.set({
                    ...store.get(),
                    error: value,
                  });
                },
              };

              // Start streaming in background and return first item
              const { firstItem } = await handleNdjsonStreamingFirstItem(response, storeAdapter);
              return [firstItem];
            }

            if (isStreaming === "octet-stream") {
              // TODO(Wilco): Implement this
              throw new Error("Octet-stream streaming is not supported.");
            }

            throw new Error("Unreachable");
          },

          onErrorRetry: options?.onErrorRetry,
          dedupeTime: Infinity,
        });

        if (typeof window === "undefined") {
          addStore(store);
        }

        return store;
      },
      query: async (args) => {
        const { path, query } = args ?? {};

        const response = await executeQuery({ pathParams: path, queryParams: query });

        const isStreaming = isStreamingResponse(response);

        if (!isStreaming) {
          return (await response.json()) as StandardSchemaV1.InferOutput<TOutputSchema>;
        }

        if (isStreaming === "ndjson") {
          const { streamingPromise } = await handleNdjsonStreamingFirstItem(response);
          // Resolves once the stream is done
          return await streamingPromise;
        }

        if (isStreaming === "octet-stream") {
          // TODO(Wilco): Implement this
          throw new Error("Octet-stream streaming is not supported.");
        }

        throw new Error("Unreachable");
      },
      [GET_HOOK_SYMBOL]: true,
    };
  }

  #createRouteQueryMutator<
    TPath extends string,
    TInputSchema extends StandardSchemaV1 | undefined,
    TOutputSchema extends StandardSchemaV1 | undefined,
    TErrorCode extends string,
    TQueryParameters extends string,
  >(
    route: FragnoRouteConfig<
      NonGetHTTPMethod,
      TPath,
      TInputSchema,
      TOutputSchema,
      TErrorCode,
      TQueryParameters
    >,
    onInvalidate: OnInvalidateFn<TPath> = (invalidate, params) =>
      invalidate("GET", route.path, params),
  ): FragnoClientMutatorData<
    NonGetHTTPMethod,
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  > {
    const method = route.method;

    const baseUrl = this.#publicConfig.baseUrl ?? "";
    const mountRoute = getMountRoute({
      name: this.#fragmentConfig.name,
      mountRoute: this.#publicConfig.mountRoute,
    });
    const fetcher = this.#getFetcher();
    const fetcherOptions = this.#getFetcherOptions();

    async function executeMutateQuery({
      body,
      path,
      query,
    }: {
      body?: InferOr<TInputSchema, undefined>;
      path?: ExtractPathParamsOrWiden<TPath, string>;
      query?: Record<string, string>;
    }): Promise<Response> {
      if (typeof window === "undefined") {
        return task(async () =>
          route.handler(
            RequestInputContext.fromSSRContext({
              inputSchema: route.inputSchema,
              method,
              path: route.path,
              pathParams: (path ?? {}) as ExtractPathParams<TPath, string>,
              searchParams: new URLSearchParams(query),
              body,
            }),
            new RequestOutputContext(route.outputSchema),
          ),
        );
      }

      const url = buildUrl(
        { baseUrl, mountRoute, path: route.path },
        { pathParams: path, queryParams: query },
      );

      let response: Response;
      try {
        const { body: preparedBody, headers: bodyHeaders } = prepareRequestBody(
          body,
          route.contentType,
        );

        // Merge headers: fetcherOptions headers + body-specific headers (e.g., Content-Type for JSON)
        // For FormData, bodyHeaders is undefined and browser sets Content-Type with boundary automatically
        const mergedHeaders = mergeRequestHeaders(
          fetcherOptions?.headers as HeadersInit | undefined,
          bodyHeaders,
        );

        const requestOptions: RequestInit & { duplex?: "half" } = {
          ...fetcherOptions,
          method,
          body: preparedBody,
          ...(mergedHeaders ? { headers: mergedHeaders } : {}),
        };
        if (preparedBody instanceof ReadableStream) {
          requestOptions.duplex = "half";
        }
        response = await fetcher(url, requestOptions);
      } catch (error) {
        throw FragnoClientFetchError.fromUnknownFetchError(error);
      }

      if (!response.ok) {
        throw await FragnoClientApiError.fromResponse<TErrorCode>(response);
      }

      return response;
    }

    const mutatorStore: FragnoClientMutatorData<
      NonGetHTTPMethod,
      TPath,
      TInputSchema,
      TOutputSchema,
      TErrorCode,
      TQueryParameters
    >["mutatorStore"] = this.#createMutatorStore(
      async ({ data }) => {
        if (typeof window === "undefined") {
          // TODO(Wilco): Handle server-side rendering.
        }

        const { body, path, query } = data as {
          body?: InferOr<TInputSchema, undefined>;
          path?: ExtractPathParamsOrWiden<TPath, string>;
          query?: Record<string, string>;
        };

        if (typeof body === "undefined" && route.inputSchema !== undefined) {
          throw new Error("Body is required.");
        }

        const response = await executeMutateQuery({ body, path, query });

        onInvalidate(this.#invalidate.bind(this), {
          pathParams: (path ?? {}) as MaybeExtractPathParamsOrWiden<TPath, string>,
          queryParams: query,
        });

        if (response.status === 201 || response.status === 204) {
          return undefined;
        }

        const isStreaming = isStreamingResponse(response);

        if (!isStreaming) {
          return response.json();
        }

        if (typeof window === "undefined") {
          return [];
        }

        if (isStreaming === "ndjson") {
          const storeAdapter: NdjsonStreamingStore<NonNullable<TOutputSchema>, TErrorCode> = {
            setData: (value) => {
              mutatorStore.set({
                ...mutatorStore.get(),
                loading: !(Array.isArray(value) && value.length > 0),
                data: value as InferOr<TOutputSchema, undefined>,
              });
            },
            setError: (value) => {
              mutatorStore.set({
                ...mutatorStore.get(),
                error: value,
              });
            },
          };

          // Start streaming in background and return first item
          const { firstItem } = await handleNdjsonStreamingFirstItem(response, storeAdapter);

          // Return the first item immediately. The streaming will continue in the background
          return [firstItem];
        }

        if (isStreaming === "octet-stream") {
          // TODO(Wilco): Implement this
          throw new Error("Octet-stream streaming is not supported.");
        }

        throw new Error("Unreachable");
      },
      {
        onError: (error) => {
          console.error("Error in mutatorStore", error);
        },
      },
    );

    const mutateQuery = (async (data) => {
      // TypeScript infers the fields to not exist, even though they might
      const { body, path, query } = data as {
        body?: InferOr<TInputSchema, undefined>;
        path?: ExtractPathParamsOrWiden<TPath, string>;
        query?: Record<string, string>;
      };

      if (typeof body === "undefined" && route.inputSchema !== undefined) {
        throw new Error("Body is required for mutateQuery");
      }

      const response = await executeMutateQuery({ body, path, query });

      if (response.status === 201 || response.status === 204) {
        return undefined;
      }

      const isStreaming = isStreamingResponse(response);

      if (!isStreaming) {
        return response.json();
      }

      if (isStreaming === "ndjson") {
        const { streamingPromise } = await handleNdjsonStreamingFirstItem(response);
        // Resolves once the stream is done, i.e. we block until done
        return await streamingPromise;
      }

      if (isStreaming === "octet-stream") {
        throw new Error("Octet-stream streaming is not supported for mutations");
      }

      throw new Error("Unreachable");
    }) satisfies FragnoClientMutatorData<
      NonGetHTTPMethod,
      TPath,
      TInputSchema,
      TOutputSchema,
      TErrorCode,
      TQueryParameters
    >["mutateQuery"];

    return {
      route,
      mutateQuery,
      mutatorStore,
      [MUTATOR_HOOK_SYMBOL]: true,
    };
  }

  #invalidate<TPath extends string>(
    method: HTTPMethod,
    path: TPath,
    params: {
      pathParams?: MaybeExtractPathParamsOrWiden<TPath, string>;
      queryParams?: Record<string, string>;
    },
  ) {
    const prefixArray = getCacheKey(method, path, {
      pathParams: params?.pathParams,
      queryParams: params?.queryParams,
    });

    const prefix = prefixArray.map((k) => (typeof k === "string" ? k : k.get())).join("");

    this.#invalidateKeys((key) => key.startsWith(prefix));
  }
}

/**
 * Create a client builder for fragments using the new fragment definition API.
 * This is the same as createClientBuilder but works with FragmentDefinition.
 */
export function createClientBuilder<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TPrivateServices,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment> = {},
>(
  definition: FragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TLinkedFragments
  >,
  publicConfig: FragnoPublicClientConfig,
  routesOrFactories: TRoutesOrFactories,
  authorFetcherConfig?: FetcherConfig,
): ClientBuilder<
  FlattenRouteFactories<TRoutesOrFactories>,
  FragnoFragmentSharedConfig<FlattenRouteFactories<TRoutesOrFactories>>
> {
  // For client-side, we resolve route factories with dummy context
  // This will be removed by the bundle plugin anyway
  const dummyContext = {
    config: {} as TConfig,
    deps: {} as TDeps,
    services: {} as TBaseServices & TServices,
    serviceDeps: {},
  };

  const routes = resolveRouteFactories(dummyContext, routesOrFactories);

  const fragmentConfig: FragnoFragmentSharedConfig<FlattenRouteFactories<TRoutesOrFactories>> = {
    name: definition.name,
    routes,
  };

  const mountRoute = getMountRoute({
    name: definition.name,
    mountRoute: publicConfig.mountRoute,
  });
  const mergedFetcherConfig = mergeFetcherConfigs(authorFetcherConfig, publicConfig.fetcherConfig);
  const fullPublicConfig = {
    ...publicConfig,
    mountRoute,
    fetcherConfig: mergedFetcherConfig,
  };

  return new ClientBuilder(fullPublicConfig, fragmentConfig);
}

export * from "./client-error";
export type { FetcherConfig, FragnoPublicClientConfig } from "../api/shared-types";
export type { FragnoFragmentSharedConfig } from "../api/fragment-instantiator";
