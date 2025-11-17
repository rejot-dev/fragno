import type { HTTPMethod } from "./api";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Public configuration for Fragno fragments on the server side.
 */
export interface FragnoPublicConfig {
  mountRoute?: string;
}

/**
 * Configuration for custom fetch behavior in client-side fragments.
 */
export type FetcherConfig =
  | { type: "options"; options: RequestInit }
  | { type: "function"; fetcher: typeof fetch };

/**
 * Public configuration for Fragno fragments on the client side.
 */
export interface FragnoPublicClientConfig {
  mountRoute?: string;
  baseUrl?: string;
  fetcherConfig?: FetcherConfig;
}

/**
 * Shared configuration for fragment routes.
 */
export interface FragnoFragmentSharedConfig<
  TRoutes extends readonly {
    method: HTTPMethod;
    path: string;
    inputSchema?: StandardSchemaV1 | undefined;
    outputSchema?: StandardSchemaV1 | undefined;
    errorCodes?: readonly string[];
    queryParameters?: readonly string[];
    pathParameters?: readonly string[];
  }[] = [],
> {
  name: string;
  routes: TRoutes;
}
