import type { FragmentDefinition } from "../api/fragment-builder";
import type { FragnoRouteConfig, HTTPMethod } from "../api/api";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "../api/route";
import type { FragnoPublicConfig } from "../api/fragment-instantiation";
import { createFragment } from "../api/fragment-instantiation";
import type { RouteHandlerInputOptions } from "../api/route-handler-input-options";
import type { ExtractRouteByPath, ExtractRoutePath } from "../client/client";
import type { InferOrUnknown } from "../util/types-util";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Re-export for convenience
export type { RouteHandlerInputOptions };

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
      stream: AsyncGenerator<T extends unknown[] ? T[number] : T>;
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
async function* parseNDJSONStream<T>(
  response: Response,
): AsyncGenerator<T extends unknown[] ? T[number] : T> {
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
          yield JSON.parse(line) as T extends unknown[] ? T[number] : T;
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      yield JSON.parse(buffer) as T extends unknown[] ? T[number] : T;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Options for creating a test fragment
 */
export interface CreateFragmentForTestOptions<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
> {
  config: TConfig;
  options?: Partial<TOptions>;
  deps?: Partial<TDeps>;
  services?: Partial<TServices>;
  additionalContext?: Partial<TAdditionalContext>;
}

/**
 * Fragment test instance with type-safe callRoute method
 */
export interface FragmentForTest<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> {
  config: TConfig;
  deps: TDeps;
  services: TServices;
  additionalContext: TAdditionalContext & TOptions;
  callRoute: <
    const TMethod extends HTTPMethod,
    const TPath extends ExtractRoutePath<TRoutes, TMethod>,
  >(
    method: TMethod,
    path: TPath,
    inputOptions?: RouteHandlerInputOptions<
      TPath,
      ExtractRouteByPath<TRoutes, TPath, TMethod>["inputSchema"]
    >,
  ) => Promise<
    TestResponse<
      InferOrUnknown<NonNullable<ExtractRouteByPath<TRoutes, TPath, TMethod>["outputSchema"]>>
    >
  >;
}

/**
 * Create a fragment instance for testing with optional dependency and service overrides
 *
 * @param fragmentBuilder - The fragment builder with definition and required options
 * @param routesOrFactories - Route configurations or route factories
 * @param options - Configuration and optional overrides for deps/services
 * @returns A fragment test instance with a type-safe callRoute method
 *
 * @example
 * ```typescript
 * const fragment = createFragmentForTest(
 *   chatnoDefinition,
 *   [routesFactory],
 *   {
 *     config: { openaiApiKey: "test-key" },
 *     options: { mountRoute: "/api/chatno" },
 *     services: {
 *       generateStreamMessages: mockGenerator
 *     }
 *   }
 * );
 *
 * // Call routes directly by method and path
 * const response = await fragment.callRoute("POST", "/login", {
 *   body: { username: "test", password: "test123" }
 * });
 *
 * if (response.type === 'json') {
 *   expect(response.data).toEqual({...});
 * }
 * ```
 */
export function createFragmentForTest<
  TConfig,
  TDeps,
  TServices extends Record<string, unknown>,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  fragmentBuilder: {
    definition: FragmentDefinition<TConfig, TDeps, TServices, TAdditionalContext>;
    $requiredOptions: TOptions;
  },
  routesOrFactories: TRoutesOrFactories,
  options: CreateFragmentForTestOptions<TConfig, TDeps, TServices, TAdditionalContext, TOptions>,
): FragmentForTest<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext,
  TOptions,
  FlattenRouteFactories<TRoutesOrFactories>
> {
  const {
    config,
    options: fragmentOptions = {} as TOptions,
    deps: depsOverride,
    services: servicesOverride,
    additionalContext: additionalContextOverride,
  } = options;

  // Create deps from definition or use empty object
  const definition = fragmentBuilder.definition;
  const baseDeps = definition.dependencies
    ? definition.dependencies(config, fragmentOptions)
    : ({} as TDeps);

  // Merge deps with overrides
  const deps = { ...baseDeps, ...depsOverride } as TDeps;

  // Create services from definition or use empty object
  const baseServices = definition.services
    ? definition.services(config, fragmentOptions, deps)
    : ({} as TServices);

  // Merge services with overrides
  const services = { ...baseServices, ...servicesOverride } as TServices;

  // Merge additional context with options
  const additionalContext = {
    ...definition.additionalContext,
    ...fragmentOptions,
    ...additionalContextOverride,
  } as TAdditionalContext & TOptions;

  // Create the actual fragment using createFragment
  const fragment = createFragment(fragmentBuilder, config, routesOrFactories, fragmentOptions);

  return {
    config,
    deps,
    services,
    additionalContext,
    callRoute: async (method, path, inputOptions) => {
      const response = await fragment.callRoute(method, path, inputOptions);
      return parseResponse(response);
    },
  };
}
