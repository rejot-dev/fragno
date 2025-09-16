import { nanoquery, type FetcherStore, type MutatorStore } from "@nanostores/query";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { task, type ReadableAtom, type Store } from "nanostores";
import type { FragnoRouteConfig, HTTPMethod, NonGetHTTPMethod } from "../api/api";
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
import type { FragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../api/library";
import { FragnoClientApiError, FragnoClientError, FragnoClientFetchError } from "./client-error";
import type { InferOr } from "../util/types-util";
import { parseContentType } from "../util/content-type";
import {
  handleNdjsonStreamingFirstItem,
  type NdjsonStreamingStore,
} from "./internal/ndjson-streaming";
import { addStore, getInitialData, SSR_ENABLED } from "../util/ssr";
import { unwrapObject } from "../util/nanostores";
import type { LibraryBuilder } from "../api/library";
import {
  type AnyRouteOrFactory,
  type FlattenRouteFactories,
  resolveRouteFactories,
} from "../api/route";

/**
 * Symbols used to identify hook types
 */
const GET_HOOK_SYMBOL = Symbol("fragno-get-hook");
const MUTATOR_HOOK_SYMBOL = Symbol("fragno-mutator-hook");
const STORE_SYMBOL = Symbol("fragno-store");

/**
 * Extract only GET routes from a library config's routes array
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

export type ObjectContainingStoreField<T extends object> = T extends Store
  ? T
  : {
        [K in keyof T]: T[K] extends Store ? { [P in K]: T[P] } & Partial<Omit<T, K>> : never;
      }[keyof T] extends never
    ? never
    : T;

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
    query?: Record<TQueryParameters, string>;
  }): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
  store(args?: {
    path?: MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>;
    query?: Record<TQueryParameters, string | ReadableAtom<string>>;
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
    query?: Record<TQueryParameters, string>;
  }): Promise<InferOr<TOutputSchema, undefined>>;

  mutatorStore: MutatorStore<
    {
      body?: InferOr<TInputSchema, undefined>;
      path?: MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>;
      query?: Record<TQueryParameters, string | ReadableAtom<string>>;
    },
    InferOr<TOutputSchema, undefined>,
    FragnoClientError<TErrorCode>
  >;
  [MUTATOR_HOOK_SYMBOL]: true;
} & {
  readonly _inputSchema?: TInputSchema;
  readonly _outputSchema?: TOutputSchema;
};

export function buildUrl<TPath extends string>(
  config: {
    baseUrl?: string;
    mountRoute: string;
    path: TPath;
  },
  params: {
    pathParams?: Record<string, string | ReadableAtom<string>>;
    queryParams?: Record<string, string | ReadableAtom<string>>;
  },
): string {
  const { baseUrl = "", mountRoute, path } = config;
  const { pathParams, queryParams } = params ?? {};

  const normalizedPathParams = unwrapObject(pathParams) as ExtractPathParams<TPath, string>;
  const normalizedQueryParams = unwrapObject(queryParams) ?? {};

  const searchParams = new URLSearchParams(normalizedQueryParams);
  const builtPath = buildPath(path, normalizedPathParams ?? {});
  const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
  return `${baseUrl}${mountRoute}${builtPath}${search}`;
}

/**
 * This method returns an array, which can be passed directly to nanostores.
 *
 * The returned array is always: path, pathParams (In order they appear in the path), queryParams (In alphabetical order)
 * Missing pathParams are replaced with "<missing>".
 * @param path
 * @param params
 * @returns
 */
export function getCacheKey<TMethod extends HTTPMethod, TPath extends string>(
  method: TMethod,
  path: TPath,
  params?: {
    pathParams?: Record<string, string | ReadableAtom<string>>;
    queryParams?: Record<string, string | ReadableAtom<string>>;
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
        .map((key) => queryParams[key])
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
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
> {
  #publicConfig: FragnoPublicClientConfig;
  #libraryConfig: TLibraryConfig;

  #cache = new Map<string, CacheLine>();

  #createFetcherStore;
  #createMutatorStore;
  #invalidateKeys;

  constructor(publicConfig: FragnoPublicClientConfig, libraryConfig: TLibraryConfig) {
    this.#publicConfig = publicConfig;
    this.#libraryConfig = libraryConfig;

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

  createHook<TPath extends ExtractGetRoutePaths<TLibraryConfig["routes"]>>(
    path: ValidateGetRoutePath<TLibraryConfig["routes"], TPath>,
    options?: CreateHookOptions,
  ): FragnoClientHookData<
    "GET",
    TPath,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["outputSchema"]>,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["errorCodes"]>[number],
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["queryParameters"]>[number]
  > {
    const route = this.#libraryConfig.routes.find(
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

  createMutator<TPath extends ExtractNonGetRoutePaths<TLibraryConfig["routes"]>>(
    method: NonGetHTTPMethod,
    path: TPath,
    onInvalidate?: OnInvalidateFn<TPath>,
  ): FragnoClientMutatorData<
    NonGetHTTPMethod, // TODO: This can be any Method, but should be related to TPath
    TPath,
    ExtractRouteByPath<TLibraryConfig["routes"], TPath>["inputSchema"],
    ExtractRouteByPath<TLibraryConfig["routes"], TPath>["outputSchema"],
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["errorCodes"]>[number],
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["queryParameters"]>[number]
  > {
    type TRoute = ExtractRouteByPath<TLibraryConfig["routes"], TPath>;

    const route = this.#libraryConfig.routes.find(
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
    const mountRoute = getMountRoute(this.#libraryConfig);

    async function callServerSideHandler(params: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | ReadableAtom<string>>;
    }): Promise<Response> {
      const { pathParams, queryParams } = params ?? {};

      const normalizedPathParams = unwrapObject(pathParams) as ExtractPathParams<TPath, string>;
      const normalizedQueryParams = unwrapObject(queryParams) ?? {};

      const searchParams = new URLSearchParams(normalizedQueryParams);

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
      queryParams?: Record<string, string | ReadableAtom<string>>;
    }): Promise<Response> {
      const { pathParams, queryParams } = params ?? {};

      if (typeof window === "undefined") {
        return task(async () => callServerSideHandler({ pathParams, queryParams }));
      }

      const url = buildUrl({ baseUrl, mountRoute, path: route.path }, { pathParams, queryParams });

      let response: Response;
      try {
        response = await fetch(url);
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
    const mountRoute = getMountRoute(this.#libraryConfig);

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
        response = await fetch(url, {
          method,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
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

export function createClientBuilder<
  TConfig,
  TDeps,
  TServices extends Record<string, unknown>,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  libraryDefinition: LibraryBuilder<TConfig, TDeps, TServices>,
  publicConfig: FragnoPublicClientConfig,
  routesOrFactories: TRoutesOrFactories,
): ClientBuilder<
  FlattenRouteFactories<TRoutesOrFactories>,
  FragnoLibrarySharedConfig<FlattenRouteFactories<TRoutesOrFactories>>
> {
  const definition = libraryDefinition.definition;

  // For client-side, we resolve route factories with dummy context
  // This will be removed by the bundle plugin anyway
  const dummyContext = {
    config: {} as TConfig,
    deps: {} as TDeps,
    services: {} as TServices,
  };

  const routes = resolveRouteFactories(dummyContext, routesOrFactories);

  const libraryConfig: FragnoLibrarySharedConfig<FlattenRouteFactories<TRoutesOrFactories>> = {
    name: definition.name,
    routes,
  };

  const mountRoute = publicConfig.mountRoute ?? `/${definition.name}`;
  const fullPublicConfig = {
    ...publicConfig,
    mountRoute,
  };

  return new ClientBuilder(fullPublicConfig, libraryConfig);
}

export * from "./client-error";
