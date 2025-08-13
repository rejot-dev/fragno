import { nanoquery, type FetcherStore } from "@nanostores/query";
import type { FragnoRouteConfig, HTTPMethod, RequestContext } from "../api/api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../mod";
import { getMountRoute } from "../api/internal/route";
import {
  buildPath,
  type ExtractPathParams,
  type ExtractPathParamsOrWiden,
  type HasPathParams,
} from "../api/internal/path";
import { type ReadableAtom } from "nanostores";

type InferOrUnknown<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : unknown;

const [
  createFetcherStore,
  _createMutationStore,
  { invalidateKeys: _invalidateKeys, revalidateKeys: _revalidateKeys },
] = nanoquery();

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
    StandardSchemaV1 | undefined
  >[],
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<
    infer Method,
    infer Path,
    infer Input,
    infer Output
  >
    ? Method extends "GET"
      ? FragnoRouteConfig<Method, Path, Input, Output>
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
    StandardSchemaV1 | undefined
  >[],
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<
    infer Method,
    infer Path,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >
    ? Method extends "GET"
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
    StandardSchemaV1 | undefined
  >[],
  TPath extends string,
  TMethod extends HTTPMethod = HTTPMethod,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends FragnoRouteConfig<
    infer M,
    TPath,
    infer Input,
    infer Output
  >
    ? M extends TMethod
      ? FragnoRouteConfig<M, TPath, Input, Output>
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
    StandardSchemaV1 | undefined
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
    StandardSchemaV1 | undefined
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
    StandardSchemaV1 | undefined
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
    StandardSchemaV1 | undefined
  >[],
  TPath extends ExtractGetRoutePaths<TRoutes>,
> = FragnoClientHook<ExtractOutputSchemaForPath<TRoutes, TPath>>;

export interface FragnoClientHook<TOutputSchema extends StandardSchemaV1 | undefined> {
  name: string;
  store: FetcherStore<InferOrUnknown<TOutputSchema>>;
}

export type GenerateNewHookTypeForPath<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TPath extends ExtractGetRoutePaths<TRoutes>,
> = NewFragnoClientHookData<"GET", TPath, ExtractOutputSchemaForPath<TRoutes, TPath>>;

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

export type NewFragnoClientHookData<
  TMethod extends HTTPMethod,
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
> = {
  route: FragnoRouteConfig<TMethod, TPath, StandardSchemaV1 | undefined, TOutputSchema>;
  query(
    params: ClientHookParams<TPath, string>,
  ): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
  store(
    params: ClientHookParams<TPath, string | ReadableAtom<string>>,
  ): FetcherStore<StandardSchemaV1.InferOutput<TOutputSchema>>;
} & {
  // Phantom field that preserves the specific TOutputSchema type parameter
  // in the structural type. This makes the type covariant, allowing more
  // specific schema types (like z.ZodString) to be assigned to variables
  // typed with more general schema types (like StandardSchemaV1<any, any>)
  readonly _outputSchema?: TOutputSchema;
};

export type ExtractOutputSchemaFromHook<T> =
  T extends FragnoClientHook<infer OutputSchema> ? OutputSchema : never;

export function createRouteQueryHook<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: { mountRoute?: string; name: string },
  route: FragnoRouteConfig<"GET", TPath, TInputSchema, TOutputSchema>,
): NewFragnoClientHookData<"GET", TPath, TOutputSchema> {
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

  function buildUrl(params: {
    pathParams?: Record<string, string | ReadableAtom<string>>;
    queryParams?: Record<string, string | ReadableAtom<string>>;
  }) {
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
    const builtPath = buildPath(route.path, normalizedPathParams ?? {});
    const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return `${baseUrl}${mountRoute}${builtPath}${search}`;
  }

  return {
    route,
    store: (params: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | ReadableAtom<string>>;
    }) => {
      const { pathParams, queryParams } = params ?? {};

      const deps: (string | ReadableAtom<string>)[] = [
        ...Object.values(pathParams ?? {}),
        ...Object.values(queryParams ?? {}),
      ];

      // console.log("Creating Store, deps", { deps });

      const store = createFetcherStore<StandardSchemaV1.InferOutput<TOutputSchema>>(
        [route.path, ...deps],
        {
          fetcher: async (...keys: (string | number | boolean)[]) => {
            console.log("fetcher", {
              pathParams,
              queryParams,
              deps,
              keys,
              path: route.path,
            });

            const url = buildUrl({ pathParams, queryParams });

            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response.json();
          },

          dedupeTime: 0,
        },
      );

      // store.invalidate();
      // console.log("store", store.get());
      // store.fetch().then((data) => {
      //   console.log("store", data);
      // });

      return store;
    },
    query: async (params?: {
      pathParams?: Record<string, string>;
      queryParams?: Record<string, string>;
    }) => {
      const { pathParams, queryParams } = params ?? {};

      const searchParams = new URLSearchParams(queryParams ?? {});
      const url = buildUrl({ pathParams, queryParams });

      if (typeof window === "undefined") {
        // Server-side rendering

        console.log("server-side fetching", {
          searchParams,
        });

        const ctx = {
          path: route.path,
          pathParams: (pathParams ?? {}) as ExtractPathParams<TPath>,
          searchParams,
          // Construct this object with Input/Output undefined, because there is type-fuckery going on.
        } satisfies RequestContext<TPath, undefined, undefined>;

        return route.handler({
          ...ctx,
          output: {
            schema: route.outputSchema!,
          },
        } as unknown as RequestContext<TPath, TInputSchema, TOutputSchema>);
      } // Else: client side fetching

      // console.log("client-side fetching", {
      //   searchParams,
      //   builtPath,
      //   joined,
      //   url,
      // });

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: unknown = await response.json();
      return data as StandardSchemaV1.InferOutput<TOutputSchema>;
    },
  };
}

// ============================================================================
// Hook Builder (factory style)
// ============================================================================

export function createClientBuilder<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
): {
  createHook: <TPath extends ExtractGetRoutePaths<TLibraryConfig["routes"]>>(
    path: ValidateGetRoutePath<TLibraryConfig["routes"], TPath>,
  ) => NewFragnoClientHookData<
    "GET",
    TPath,
    NonNullable<ExtractRouteByPath<TLibraryConfig["routes"], TPath>["outputSchema"]>
  >;
} {
  return {
    createHook: (path) => createLibraryHook(publicConfig, libraryConfig, path),
  };
}

export function createLibraryHook<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
  TPath extends ExtractGetRoutePaths<TLibraryConfig["routes"]>,
  TRoute extends ExtractRouteByPath<TLibraryConfig["routes"], TPath>,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
  path: ValidateGetRoutePath<TLibraryConfig["routes"], TPath>,
): NewFragnoClientHookData<"GET", TPath, NonNullable<TRoute["outputSchema"]>> {
  const route = libraryConfig.routes.find(
    (r): r is FragnoRouteConfig<"GET", TPath, StandardSchemaV1 | undefined, StandardSchemaV1> =>
      r.path === path && r.method === "GET" && r.outputSchema !== undefined,
  );

  if (!route) {
    throw new Error(`Route '${path}' not found or is not a GET route with an output schema.`);
  }

  return createRouteQueryHook(publicConfig, libraryConfig, route);
}
