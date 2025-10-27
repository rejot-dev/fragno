import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragmentBuilder } from "../api/fragment-builder";
import type { FragnoRouteConfig, HTTPMethod } from "../api/api";
import type { ExtractPathParams } from "../api/internal/path";
import { RequestInputContext } from "../api/request-input-context";
import { RequestOutputContext } from "../api/request-output-context";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "../api/route";
import { resolveRouteFactories } from "../api/route";

/**
 * Discriminated union representing all possible test response types
 */
export type TestResponse<T> =
  | {
      type: "empty";
      status: number;
      headers: Headers;
    }
  | {
      type: "error";
      status: number;
      headers: Headers;
      error: { message: string; code: string };
    }
  | {
      type: "json";
      status: number;
      headers: Headers;
      data: T;
    }
  | {
      type: "jsonStream";
      status: number;
      headers: Headers;
      stream: AsyncGenerator<T>;
    };

/**
 * Parse a Response object into a TestResponse discriminated union
 */
async function parseResponse<T>(response: Response): Promise<TestResponse<T>> {
  const status = response.status;
  const headers = response.headers;
  const contentType = headers.get("content-type") || "";

  // Check for streaming response
  if (contentType.includes("application/x-ndjson")) {
    return {
      type: "jsonStream",
      status,
      headers,
      stream: parseNDJSONStream<T>(response),
    };
  }

  // Parse JSON body
  const text = await response.text();

  // Empty response
  if (!text || text === "null") {
    return {
      type: "empty",
      status,
      headers,
    };
  }

  const data = JSON.parse(text);

  // Error response (has message and code)
  if (data && typeof data === "object" && "message" in data && "code" in data) {
    return {
      type: "error",
      status,
      headers,
      error: { message: data.message, code: data.code },
    };
  }

  // JSON response
  return {
    type: "json",
    status,
    headers,
    data: data as T,
  };
}

/**
 * Parse an NDJSON stream into an async generator
 */
async function* parseNDJSONStream<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          yield JSON.parse(line) as T;
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      yield JSON.parse(buffer) as T;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Options for creating a test fragment
 */
export interface CreateFragmentForTestOptions<TConfig, TDeps, TServices> {
  config: TConfig;
  deps?: Partial<TDeps>;
  services?: Partial<TServices>;
}

/**
 * Options for calling a route handler
 */
export interface RouteHandlerInputOptions<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
> {
  pathParams?: ExtractPathParams<TPath>;
  body?: TInputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferInput<TInputSchema> : never;
  query?: URLSearchParams | Record<string, string>;
  headers?: Headers | Record<string, string>;
}

/**
 * Options for overriding config/deps/services when initializing routes
 */
export interface InitRoutesOverrides<TConfig, TDeps, TServices> {
  config?: Partial<TConfig>;
  deps?: Partial<TDeps>;
  services?: Partial<TServices>;
}

/**
 * Fragment test instance with type-safe handler method
 */
export interface FragmentForTest<TConfig, TDeps, TServices> {
  config: TConfig;
  deps: TDeps;
  services: TServices;
  handler: <
    TMethod extends HTTPMethod,
    TPath extends string,
    TInputSchema extends StandardSchemaV1 | undefined,
    TOutputSchema extends StandardSchemaV1 | undefined,
    TErrorCode extends string,
    TQueryParameters extends string,
  >(
    route: FragnoRouteConfig<
      TMethod,
      TPath,
      TInputSchema,
      TOutputSchema,
      TErrorCode,
      TQueryParameters
    >,
    inputOptions?: RouteHandlerInputOptions<TPath, TInputSchema>,
  ) => Promise<
    TestResponse<
      TOutputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TOutputSchema> : unknown
    >
  >;
  initRoutes: <const TRoutesOrFactories extends readonly AnyRouteOrFactory[]>(
    routesOrFactories: TRoutesOrFactories,
    overrides?: InitRoutesOverrides<TConfig, TDeps, TServices>,
  ) => FlattenRouteFactories<TRoutesOrFactories>;
}

/**
 * Create a fragment instance for testing with optional dependency and service overrides
 *
 * @param fragmentDefinition - The fragment definition created with defineFragment()
 * @param options - Configuration and optional overrides for deps/services
 * @returns A fragment test instance with a type-safe handler method
 *
 * @example
 * ```typescript
 * const fragment = createFragmentForTest(chatnoDefinition, {
 *   config: { openaiApiKey: "test-key" },
 *   services: {
 *     generateStreamMessages: mockGenerator
 *   }
 * });
 *
 * // Initialize routes with fragment's config/deps/services
 * const [route] = fragment.initRoutes(routes);
 *
 * // Or override specific config/deps/services for certain routes
 * const [route] = fragment.initRoutes(routes, {
 *   services: { mockService: mockImplementation }
 * });
 *
 * const response = await fragment.handler(route, {
 *   pathParams: { id: "123" },
 *   body: { message: "Hello" }
 * });
 *
 * if (response.type === 'json') {
 *   expect(response.data).toEqual({...});
 * }
 * ```
 */
export function createFragmentForTest<TConfig, TDeps, TServices extends Record<string, unknown>>(
  fragmentDefinition: FragmentBuilder<TConfig, TDeps, TServices>,
  options: CreateFragmentForTestOptions<TConfig, TDeps, TServices>,
): FragmentForTest<TConfig, TDeps, TServices> {
  const { config, deps: depsOverride, services: servicesOverride } = options;

  // Create deps from definition or use empty object
  const definition = fragmentDefinition.definition;
  const baseDeps = definition.dependencies ? definition.dependencies(config, {}) : ({} as TDeps);

  // Merge deps with overrides
  const deps = { ...baseDeps, ...depsOverride } as TDeps;

  // Create services from definition or use empty object
  const baseServices = definition.services
    ? definition.services(config, {}, deps)
    : ({} as TServices);

  // Merge services with overrides
  const services = { ...baseServices, ...servicesOverride } as TServices;

  return {
    config,
    deps,
    services,
    initRoutes: <const TRoutesOrFactories extends readonly AnyRouteOrFactory[]>(
      routesOrFactories: TRoutesOrFactories,
      overrides?: InitRoutesOverrides<TConfig, TDeps, TServices>,
    ): FlattenRouteFactories<TRoutesOrFactories> => {
      // Merge overrides with base config/deps/services
      const routeContext = {
        config: { ...config, ...overrides?.config } as TConfig,
        deps: { ...deps, ...overrides?.deps } as TDeps,
        services: { ...services, ...overrides?.services } as TServices,
      };
      return resolveRouteFactories(routeContext, routesOrFactories);
    },
    handler: async <
      TMethod extends HTTPMethod,
      TPath extends string,
      TInputSchema extends StandardSchemaV1 | undefined,
      TOutputSchema extends StandardSchemaV1 | undefined,
      TErrorCode extends string,
      TQueryParameters extends string,
    >(
      route: FragnoRouteConfig<
        TMethod,
        TPath,
        TInputSchema,
        TOutputSchema,
        TErrorCode,
        TQueryParameters
      >,
      inputOptions?: RouteHandlerInputOptions<TPath, TInputSchema>,
    ): Promise<
      TestResponse<
        TOutputSchema extends StandardSchemaV1
          ? StandardSchemaV1.InferOutput<TOutputSchema>
          : unknown
      >
    > => {
      const {
        pathParams = {} as ExtractPathParams<TPath>,
        body,
        query,
        headers,
      } = inputOptions || {};

      // Convert query to URLSearchParams if needed
      const searchParams =
        query instanceof URLSearchParams
          ? query
          : query
            ? new URLSearchParams(query)
            : new URLSearchParams();

      // Convert headers to Headers if needed
      const requestHeaders =
        headers instanceof Headers ? headers : headers ? new Headers(headers) : new Headers();

      // Construct RequestInputContext
      const inputContext = new RequestInputContext<TPath, TInputSchema>({
        path: route.path,
        method: route.method,
        pathParams,
        searchParams,
        headers: requestHeaders,
        body,
        inputSchema: route.inputSchema,
        shouldValidateInput: false, // Skip validation in tests
      });

      // Construct RequestOutputContext
      const outputContext = new RequestOutputContext(route.outputSchema);

      // Call the route handler
      const response = await route.handler(inputContext, outputContext);

      // Parse and return the response
      return parseResponse<
        TOutputSchema extends StandardSchemaV1
          ? StandardSchemaV1.InferOutput<TOutputSchema>
          : unknown
      >(response);
    },
  };
}
