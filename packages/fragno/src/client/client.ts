import { nanoquery, type FetcherStore } from "@nanostores/query";
import type { FragnoRouteConfig } from "../api/api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../mod";
import { getMountRoute } from "../api/internal/route";

type InferOrUnknown<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : unknown;

export interface FragnoClientHook<TOutputSchema extends StandardSchemaV1 | undefined> {
  name: string;
  store: FetcherStore<InferOrUnknown<TOutputSchema>>;
}

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
