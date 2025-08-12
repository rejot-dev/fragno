import { nanoquery, type FetcherStore } from "@nanostores/query";
import type { FragnoRouteConfig, HTTPMethod, RequestContext } from "../api/api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyFragnoLibrarySharedConfig,
  FragnoLibrarySharedConfig,
  FragnoPublicClientConfig,
} from "../mod";
import { getMountRoute } from "../api/internal/route";
import { buildPath, type ExtractPathParams, type HasPathParams } from "../api/internal/path";
// import type { ReadableAtom } from "nanostores";

type InferOrUnknown<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : unknown;

// ============================================================================
// Utility Types for FragnoClientBuilder
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

export type FragnoClientHookQueryFn<TPath extends string, TOutputSchema extends StandardSchemaV1> =
  HasPathParams<TPath> extends true
    ? (params: {
        pathParams: ExtractPathParams<TPath>;
        queryParams?: Record<string, string>;
      }) => Promise<StandardSchemaV1.InferOutput<TOutputSchema>>
    : (params?: {
        queryParams?: Record<string, string>;
      }) => Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;

export type NewFragnoClientHookData<
  TMethod extends HTTPMethod,
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
> = {
  route: FragnoRouteConfig<TMethod, TPath, StandardSchemaV1 | undefined, TOutputSchema>;
} & (HasPathParams<TPath> extends true
  ? {
      query(params: {
        pathParams: ExtractPathParams<TPath>;
        queryParams?: Record<string, string>;
      }): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
      // store(params: {
      //   pathParams: ExtractPathParams<TPath, string | ReadableAtom<string>>;
      //   queryParams?: Record<string, string | ReadableAtom<string>>;
      // }): FetcherStore<StandardSchemaV1.InferOutput<TOutputSchema>>;
    }
  : {
      query(params?: {
        queryParams?: Record<string, string>;
      }): Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
      // store(params?: {
      //   queryParams?: Record<string, string | ReadableAtom<string>>;
      // }): FetcherStore<StandardSchemaV1.InferOutput<TOutputSchema>>;
    });

export type ExtractOutputSchemaFromHook<T> =
  T extends FragnoClientHook<infer OutputSchema> ? OutputSchema : never;

// Create a global nanoquery context
const [createFetcherStore] = nanoquery({
  fetcher: async (...keys: (string | number | boolean)[]) => {
    const url = keys.join("");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  },
});

console.log("createFetcherStore", createFetcherStore);

export function createRouteQueryHook<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: AnyFragnoLibrarySharedConfig,
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

  return {
    route,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: {} as any,
    // store: (params?: {
    //   pathParams?: ExtractPathParams<TPath, string | ReadableAtom<string>>;
    //   queryParams?: Record<string, ReadableAtom<string>>;
    // }) => {
    //   const { pathParams, queryParams } = params ?? {};

    //   const deps: (string | ReadableAtom<string>)[] = [
    //     ...Object.values(pathParams ?? {}),
    //     ...Object.values(queryParams ?? {}),
    //   ];

    //   return createFetcherStore<InferOrUnknown<TOutputSchema>>(deps, {
    //     dedupeTime: 0,
    //   });
    // },
    query: async (params?: {
      pathParams?: ExtractPathParams<TPath>;
      queryParams?: Record<string, string>;
    }) => {
      const { pathParams, queryParams } = params ?? {};

      const searchParams = new URLSearchParams(queryParams ?? {});

      const builtPath = buildPath(route.path, pathParams ?? {});
      const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
      // Remove double slash if present (except for protocol)
      const joined = `${baseUrl}${mountRoute}${builtPath}`.replace(/([^:]\/)\/+/g, "$1");
      const url = `${joined}${search}`;

      if (typeof window === "undefined") {
        // Server-side rendering

        console.log("server-side fetching", {
          searchParams,
        });

        const ctx = {
          path: route.path,
          pathParams: pathParams ?? {},
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

      console.log("client-side fetching", {
        searchParams,
        builtPath,
        joined,
        url,
      });

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
// FragnoClientBuilder Implementation
// ============================================================================

/**
 * A fluent builder for creating type-safe client hooks from library configurations.
 * Only supports GET routes for hook creation.
 */
export class FragnoClientBuilder<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRoutes extends readonly FragnoRouteConfig<HTTPMethod, string, any, any>[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  THooks extends Record<string, NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = {},
> {
  #hooks: Record<string, NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = {};
  #publicConfig: FragnoPublicClientConfig;
  #libraryConfig: TLibraryConfig;

  constructor(publicConfig: FragnoPublicClientConfig, libraryConfig: TLibraryConfig) {
    this.#publicConfig = publicConfig;
    this.#libraryConfig = libraryConfig;
  }

  get routes(): TLibraryConfig["routes"] {
    return this.#libraryConfig.routes;
  }

  /**
   * Add a hook for a GET route. The path must be a valid GET route in the library configuration.
   * @param name - The name of the hook to create
   * @param path - The route path (must be a GET route)
   * @returns A new builder instance with the hook added to the type
   */
  addHook<THookName extends string, TPath extends ExtractGetRoutePaths<TLibraryConfig["routes"]>>(
    name: THookName,
    path: ValidateGetRoutePath<TLibraryConfig["routes"], TPath>,
  ): FragnoClientBuilder<
    TRoutes,
    TLibraryConfig,
    THooks & {
      [K in THookName]: GenerateNewHookTypeForPath<TLibraryConfig["routes"], TPath>;
    }
  > {
    if (this.#hooks[name]) {
      throw new Error(`Hook with name '${name}' already exists`);
    }

    const route = this.#libraryConfig.routes.find(
      (
        r,
      ): r is FragnoRouteConfig<
        "GET",
        typeof path,
        StandardSchemaV1 | undefined,
        StandardSchemaV1
      > => r.path === path && r.method === "GET" && r.outputSchema,
    );

    if (!route) {
      throw new Error(`Route '${path}' not found or is not a GET route with an output schema.`);
    }

    // Create the hook using the existing createRouteQueryHook function
    const hook = createRouteQueryHook(this.#publicConfig, this.#libraryConfig, route);

    // Return new builder instance with updated hooks
    const newBuilder = new FragnoClientBuilder(this.#publicConfig, this.#libraryConfig);
    newBuilder.#hooks = { ...this.#hooks, [name]: hook };
    return newBuilder as FragnoClientBuilder<
      TRoutes,
      TLibraryConfig,
      THooks & {
        [K in THookName]: GenerateNewHookTypeForPath<TLibraryConfig["routes"], TPath>;
      }
    >;
  }

  get hooks(): THooks {
    return this.#hooks as THooks;
  }

  /**
   * Build and return the final hooks object with all configured hooks.
   * @returns Object containing all the hooks that were added
   */
  build(): THooks {
    return { ...this.#hooks } as THooks;
  }
}

/**
 * Factory function to create a new FragnoClientBuilder instance.
 * @param publicConfig - Public configuration for the client
 * @param libraryConfig - Library configuration containing routes
 * @returns A new FragnoClientBuilder instance
 */
export function createClientBuilder<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRoutes extends readonly FragnoRouteConfig<HTTPMethod, string, any, any>[],
  TLibraryConfig extends FragnoLibrarySharedConfig<TRoutes>,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
): FragnoClientBuilder<TRoutes, TLibraryConfig> {
  return new FragnoClientBuilder(publicConfig, libraryConfig);
}
