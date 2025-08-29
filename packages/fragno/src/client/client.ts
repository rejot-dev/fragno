import { nanoquery, type FetcherStore, type MutatorStore } from "@nanostores/query";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { task, type ReadableAtom } from "nanostores";
import type { FragnoRouteConfig, HTTPMethod, NonGetHTTPMethod } from "../api/api";
import {
  buildPath,
  extractPathParams,
  type ExtractPathParams,
  type ExtractPathParamsOrWiden,
  type HasPathParams,
} from "../api/internal/path";
import { getMountRoute } from "../api/internal/route";
import { RequestInputContext } from "../api/request-input-context";
import { RequestOutputContext } from "../api/request-output-context";
import type { FragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../mod";
import { FragnoClientApiError, FragnoClientError, FragnoClientFetchError } from "./client-error";
import type { InferOrUnknown } from "../util/types-util";
import { parseContentType } from "../util/content-type";
import { handleNdjsonStreamingFirstItem } from "./internal/ndjson-streaming";
import { addStore, getInitialData } from "../util/ssr";

const fragnoOwnedCache = new Map<
  string,
  {
    data: unknown;
    error: unknown;
    retryCount: number;
    created: number;
    expires: number;
  }
>();

const [createFetcherStore, createMutationStore, { invalidateKeys }] = nanoquery({
  cache: fragnoOwnedCache,
});

export function clearHooksCache() {
  fragnoOwnedCache.clear();
}

// ============================================================================
// Utility Types for Hook Builder
// ============================================================================

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
 * Extract route paths from GET routes only for type validation
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
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<
    infer Method,
    infer Path,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >
    ? Method extends "GET"
      ? Path
      : never
    : never;
}[number];

export type ExtractNonGetRoutePaths<
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
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >
    ? Method extends NonGetHTTPMethod
      ? Path
      : never
    : never;
}[number];

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

/**
 * Generate the proper hook type for a given route path
 */
export type GenerateHookTypeForPath<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TPath extends ExtractGetRoutePaths<TRoutes>,
> = FragnoClientHook<
  ExtractOutputSchemaForPath<TRoutes, TPath>,
  NonNullable<ExtractRouteByPath<TRoutes, TPath>["errorCodes"]>[number]
>;

export interface FragnoClientHook<
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
> {
  name: string;
  store: FetcherStore<InferOrUnknown<TOutputSchema>, FragnoClientError<TErrorCode>>;
}

export type ClientHookParams<TPath extends string, TValueType> =
  // If TPath is a general string (not a specific literal), we cannot know
  // whether path params exist. Allow both pathParams and queryParams.
  string extends TPath
    ? {
        pathParams?: Record<string, TValueType>;
        queryParams?: Record<string, TValueType>;
      }
    : HasPathParams<TPath> extends true
      ? {
          pathParams: ExtractPathParamsOrWiden<TPath, TValueType>;
          queryParams?: Record<string, TValueType>;
        }
      : {
          queryParams?: Record<string, TValueType>;
        };

export type ResolvedClientHookParams<TPath extends string, TValueType> = TPath extends string
  ? {
      pathParams?: Record<string, TValueType>;
      queryParams?: Record<string, TValueType>;
    }
  : {
      queryParams?: Record<string, TValueType>;
    };

export type NewFragnoClientHookData<
  TMethod extends HTTPMethod,
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
> = {
  route: FragnoRouteConfig<
    TMethod,
    TPath,
    StandardSchemaV1 | undefined,
    TOutputSchema,
    TErrorCode,
    string
  >;
  query(
    params: ClientHookParams<TPath, string>,
  ): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
  store(
    params: ClientHookParams<TPath, string | ReadableAtom<string>>,
  ): FetcherStore<StandardSchemaV1.InferOutput<TOutputSchema>, FragnoClientError<TErrorCode>>;
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
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
> = {
  route: FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, string>;
  mutateQuery(
    body: StandardSchemaV1.InferInput<TInputSchema>,
    params: ClientHookParams<TPath, string | ReadableAtom<string>>,
  ): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
  mutatorStore: MutatorStore<
    {
      body: StandardSchemaV1.InferInput<TInputSchema>;
      // TODO(Wilco): Fix this, currently path params aren't typed

      // params: ClientHookParams<TPath, string | ReadableAtom<string>>;
      // params: {
      //   pathParams: ExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>;
      //   queryParams?: Record<string, string | ReadableAtom<string>>;
      // };
      params: {
        pathParams?: Record<string, string | ReadableAtom<string>>;
        queryParams?: Record<string, string | ReadableAtom<string>>;
      };
    },
    StandardSchemaV1.InferOutput<TOutputSchema>,
    FragnoClientError<TErrorCode>
  >;
} & {
  // readonly _method?: TMethod;
  // readonly _path?: TPath;
  readonly _inputSchema?: TInputSchema;
  readonly _outputSchema?: TOutputSchema;
};

export type ExtractOutputSchemaFromHook<T> =
  T extends FragnoClientHook<infer OutputSchema, infer _ErrorCode> ? OutputSchema : never;

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

  const normalizedPathParams = Object.fromEntries(
    Object.entries(pathParams ?? {}).map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.get(),
    ]),
  ) as ExtractPathParams<TPath, string>;

  const normalizedQueryParams = Object.fromEntries(
    Object.entries(queryParams ?? {}).map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.get(),
    ]),
  );

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

export function createRouteQueryHook<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: { mountRoute?: string; name: string },
  route: FragnoRouteConfig<"GET", TPath, TInputSchema, TOutputSchema, TErrorCode, string>,
  options: CreateHookOptions = {},
): NewFragnoClientHookData<"GET", TPath, TOutputSchema, TErrorCode> {
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

  const baseUrl = publicConfig.baseUrl ?? "";
  const mountRoute = getMountRoute(libraryConfig);

  async function callServerSideHandler(params: {
    pathParams?: Record<string, string | ReadableAtom<string>>;
    queryParams?: Record<string, string | ReadableAtom<string>>;
  }): Promise<Response> {
    const { pathParams, queryParams } = params ?? {};

    const normalizedPathParams = Object.fromEntries(
      Object.entries(pathParams ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? value : value.get(),
      ]),
    ) as ExtractPathParams<TPath, string>;

    const normalizedQueryParams = Object.fromEntries(
      Object.entries(queryParams ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? value : value.get(),
      ]),
    );

    const searchParams = new URLSearchParams(normalizedQueryParams);

    const result = await route.handler(
      RequestInputContext.fromSSRContext({
        method: route.method,
        path: route.path,
        pathParams: normalizedPathParams,
        searchParams,
        body: undefined, // No body for GET
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
    store: (params: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | ReadableAtom<string>>;
    }) => {
      const { pathParams, queryParams } = params ?? {};

      const key = getCacheKey(route.method, route.path, params);

      //   Nanostores during the second render only shows the loading value, because the store doesn't publish the cached value immediately.
      //  This means, that on the second server render, we only get a loading value.
      // This is a quick hack, to show the idea works, there should definitly be a better solution.
      const mappedKey = key.map((d) => (typeof d === "string" ? d : d.get())).join("");
      if (fragnoOwnedCache.has(mappedKey)) {
        return {
          get: () => fragnoOwnedCache.get(mappedKey),
        };
      }

      const store = createFetcherStore<
        StandardSchemaV1.InferOutput<TOutputSchema>,
        FragnoClientError<TErrorCode>
      >(key, {
        fetcher: async (): Promise<StandardSchemaV1.InferOutput<TOutputSchema>> => {
          const initialData = getInitialData(
            key.map((d) => (typeof d === "string" ? d : d.get())).join(""),
          );

          if (initialData) {
            return initialData;
          }

          const response = await executeQuery({ pathParams, queryParams });

          const isStreaming = isStreamingResponse(response);

          if (!isStreaming) {
            return response.json() as Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
          }

          if (isStreaming === "ndjson") {
            // Start streaming in background and return first item
            const { firstItem } = await handleNdjsonStreamingFirstItem(response, store);
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
    query: async (params?: {
      pathParams?: Record<string, string>;
      queryParams?: Record<string, string>;
    }) => {
      const response = await executeQuery(params);

      const isStreaming = isStreamingResponse(response);

      if (!isStreaming) {
        return (await response.json()) as StandardSchemaV1.InferOutput<TOutputSchema>;
      }

      throw new Error("Streaming responses are not supported server side");
    },
  };
}

// Type guard to check if a hook is a GET hook
export function isGetHook(
  hook:
    | NewFragnoClientHookData<"GET", string, StandardSchemaV1, string>
    | FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1, string>,
): hook is NewFragnoClientHookData<"GET", string, StandardSchemaV1, string> {
  return hook.route.method === "GET" && "store" in hook && "query" in hook;
}

// Type guard to check if a hook is a mutator
export function isMutatorHook(
  hook:
    | NewFragnoClientHookData<"GET", string, StandardSchemaV1, string>
    | FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1, string>,
): hook is FragnoClientMutatorData<
  NonGetHTTPMethod,
  string,
  StandardSchemaV1,
  StandardSchemaV1,
  string
> {
  return hook.route.method !== "GET" && "mutateQuery" in hook && "mutatorStore" in hook;
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

// ============================================================================
// Hook Builder (factory style)
// ============================================================================

function invalidate<TPath extends string>(
  method: HTTPMethod,
  path: TPath,
  params: {
    pathParams?: ExtractPathParamsOrWiden<TPath, string>;
    queryParams?: Record<string, string>;
  },
) {
  // Use getCacheKey to generate the cache key prefix for invalidation
  const prefixArray = getCacheKey(method, path, {
    pathParams: params?.pathParams,
    queryParams: params?.queryParams,
  });

  const prefix = prefixArray.map((k) => (typeof k === "string" ? k : k.get())).join("");

  invalidateKeys((key) => key.startsWith(prefix));
}

type OnInvalidateFn<TPath extends string> = (
  invalidateFunction: typeof invalidate,
  params: {
    pathParams: ExtractPathParamsOrWiden<TPath, string>;
    queryParams?: Record<string, string>;
  },
) => void;

export function createClientBuilder<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
): {
  createHook: <TPath extends ExtractGetRoutePaths<TLibraryConfig["routes"]>>(
    path: ValidateGetRoutePath<TLibraryConfig["routes"], TPath>,
    options?: CreateHookOptions,
  ) => NewFragnoClientHookData<
    "GET",
    TPath,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["outputSchema"]>,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["errorCodes"]>[number]
  >;

  createMutator: <TPath extends ExtractNonGetRoutePaths<TLibraryConfig["routes"]>>(
    method: NonGetHTTPMethod,
    path: TPath,
    onInvalidate?: OnInvalidateFn<TPath>,
  ) => FragnoClientMutatorData<
    NonGetHTTPMethod,
    TPath,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["inputSchema"]>,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["outputSchema"]>,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["errorCodes"]>[number]
  >;
} {
  return {
    createHook: (path, options) => createLibraryHook(publicConfig, libraryConfig, path, options),
    createMutator: (method, path, onInvalidate) =>
      createLibraryMutator(publicConfig, libraryConfig, method, path, onInvalidate),
  };
}

export function createLibraryHook<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
  TPath extends ExtractGetRoutePaths<TLibraryConfig["routes"]>,
  TRoute extends ExtractRouteByPath<TLibraryConfig["routes"], TPath>,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
  path: ValidateGetRoutePath<TLibraryConfig["routes"], TPath>,
  options?: CreateHookOptions,
): NewFragnoClientHookData<
  "GET",
  TPath,
  NonNullable<TRoute["outputSchema"]>,
  NonNullable<TRoute["errorCodes"]>[number]
> {
  const route = libraryConfig.routes.find(
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

  return createRouteQueryHook(publicConfig, libraryConfig, route, options);
}

export function createLibraryMutator<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
  TPath extends ExtractNonGetRoutePaths<TLibraryConfig["routes"]>,
  TMethod extends NonGetHTTPMethod,
  TRoute extends ExtractRouteByPath<TLibraryConfig["routes"], TPath>,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
  method: TMethod,
  path: TPath,
  onInvalidate?: OnInvalidateFn<TPath>,
): FragnoClientMutatorData<
  NonGetHTTPMethod,
  TPath,
  NonNullable<TRoute["inputSchema"]>,
  NonNullable<TRoute["outputSchema"]>,
  NonNullable<TRoute["errorCodes"]>[number]
> {
  const route = libraryConfig.routes.find(
    (
      r,
    ): r is FragnoRouteConfig<
      TMethod,
      TPath,
      NonNullable<TRoute["inputSchema"]>,
      NonNullable<TRoute["outputSchema"]>,
      string,
      string
    > =>
      r.path === path &&
      r.method === method &&
      r.inputSchema !== undefined &&
      r.outputSchema !== undefined,
  );

  if (!route) {
    throw new Error(
      `Route '${path}' not found or is not a ${method} route with an input and output schema.`,
    );
  }

  return createRouteQueryMutator(publicConfig, libraryConfig, route, onInvalidate);
}

export function createRouteQueryMutator<
  TPath extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: { mountRoute?: string; name: string },
  route: FragnoRouteConfig<
    NonGetHTTPMethod,
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    string
  >,
  onInvalidate: OnInvalidateFn<TPath> = (invalidate, params) =>
    invalidate("GET", route.path, params),
): FragnoClientMutatorData<NonGetHTTPMethod, TPath, TInputSchema, TOutputSchema, TErrorCode> {
  const method = route.method;

  const baseUrl = publicConfig.baseUrl ?? "";
  const mountRoute = getMountRoute(libraryConfig);

  async function mutateQuery(
    body: StandardSchemaV1.InferInput<TInputSchema>,
    params: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | ReadableAtom<string>>;
    },
  ) {
    const { pathParams, queryParams } = params ?? {};

    const url = buildUrl({ baseUrl, mountRoute, path: route.path }, { pathParams, queryParams });

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw FragnoClientFetchError.fromUnknownFetchError(error);
    }

    if (!response.ok) {
      throw await FragnoClientApiError.fromResponse<TErrorCode>(response);
    }

    return response.json();
  }

  const mutatorStore = createMutationStore<
    {
      body: StandardSchemaV1.InferInput<TInputSchema>;
      params: {
        pathParams?: Record<string, string | ReadableAtom<string>>;
        queryParams?: Record<string, string | ReadableAtom<string>>;
      };
    },
    StandardSchemaV1.InferOutput<TOutputSchema>,
    FragnoClientError<TErrorCode>
  >(async ({ data }) => {
    if (typeof window === "undefined") {
      // TODO(Wilco): Handle server-side rendering.
    }

    const { body, params } = data;
    const result = await mutateQuery(body, params);
    const resolvedParams: {
      pathParams: ExtractPathParamsOrWiden<TPath, string>;
      queryParams?: Record<string, string>;
    } = {
      pathParams: Object.fromEntries(
        Object.entries(params.pathParams ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" ? value : value.get(),
        ]),
      ) as ExtractPathParamsOrWiden<TPath, string>,
      queryParams: Object.fromEntries(
        Object.entries(params.queryParams ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" ? value : value.get(),
        ]),
      ),
    };

    onInvalidate(invalidate, resolvedParams);

    return result;
  });

  return {
    route,
    mutateQuery,
    mutatorStore,
  };
}
