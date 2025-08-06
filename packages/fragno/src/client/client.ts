import { nanoquery, type FetcherStore } from "@nanostores/query";
import type { FragnoRouteConfig } from "../api/api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../mod";
import { getMountRoute } from "../api/internal/route";

type InferOrUnknown<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : unknown;

// ============================================================================
// Utility Types for FragnoClientBuilder
// ============================================================================

/**
 * Extract only GET routes from a library config's routes array
 */
export type ExtractGetRoutes<
  T extends readonly FragnoRouteConfig<
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<infer Path, infer Input, infer Output>
    ? T[K]["method"] extends "GET"
      ? FragnoRouteConfig<Path, Input, Output>
      : never
    : never;
}[number][];

/**
 * Extract route paths from GET routes only for type validation
 */
export type ExtractGetRoutePaths<
  T extends readonly FragnoRouteConfig<
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<
    infer Path,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >
    ? T[K]["method"] extends "GET"
      ? Path
      : never
    : never;
}[number];

/**
 * Extract the output schema type for a specific route path from a routes array
 */
export type ExtractOutputSchemaForPath<
  TRoutes extends readonly FragnoRouteConfig<
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TPath extends string,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends FragnoRouteConfig<
    TPath,
    StandardSchemaV1 | undefined,
    infer Output
  >
    ? TRoutes[K]["method"] extends "GET"
      ? Output
      : never
    : never;
}[number];

/**
 * Check if a path exists as a GET route in the routes array
 */
export type IsValidGetRoutePath<
  TRoutes extends readonly FragnoRouteConfig<
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TPath extends string,
> = TPath extends ExtractGetRoutePaths<TRoutes> ? true : false;

/**
 * Generate the proper hook type for a given route path
 */
export type GenerateHookTypeForPath<
  TRoutes extends readonly FragnoRouteConfig<
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
  TPath extends ExtractGetRoutePaths<TRoutes>,
> = FragnoClientHook<ExtractOutputSchemaForPath<TRoutes, TPath>>;

/**
 * Utility type to ensure only valid GET route paths can be used
 */
export type ValidateGetRoutePath<
  TRoutes extends readonly FragnoRouteConfig<
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
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
> = ExtractGetRoutePaths<T> extends never ? false : true;

export interface FragnoClientHook<TOutputSchema extends StandardSchemaV1 | undefined> {
  name: string;
  store: FetcherStore<InferOrUnknown<TOutputSchema>>;
}

export type ExtractOutputSchemaFromHook<T extends FragnoClientHook<StandardSchemaV1 | undefined>> =
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

export function createRouteQueryHook<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: FragnoLibrarySharedConfig,
  route: FragnoRouteConfig<TPath, TInputSchema, TOutputSchema>,
): FragnoClientHook<TOutputSchema> {
  const baseUrl = publicConfig.baseUrl ?? "";
  const mountRoute = getMountRoute(libraryConfig);
  // Remove double slash if present (except for protocol)
  const fullPath = `${baseUrl}${mountRoute}${route.path}`.replace(/([^:]\/)\/+/g, "$1");

  console.log({
    baseUrl,
    mountRoute,
    fullPath,
  });

  // Create a fetcher store that will handle the API request
  const store = createFetcherStore<InferOrUnknown<TOutputSchema>>([fullPath], {
    // Only fetch when explicitly triggered for POST/PUT/etc methods
    // GET requests can be fetched immediately
    ...(route.method !== "GET" && { dedupeTime: 0 }),
  });

  return {
    name: `${route.method} ${route.path}`,
    store,
  };
}

// export function createClientBuilder(
//   publicConfig: FragnoPublicClientConfig,
//   libraryConfig: FragnoLibrarySharedConfig,
// ) {

// }
