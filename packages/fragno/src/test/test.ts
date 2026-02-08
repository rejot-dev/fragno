import type { RequestThisContext } from "../api/api";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "../api/route";
import type { FragnoPublicConfig } from "../api/shared-types";
import {
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceConstructorFn,
} from "../api/fragment-definition-builder";
import {
  instantiateFragment,
  type FragnoInstantiatedFragment,
  type RoutesWithInternal,
} from "../api/fragment-instantiator";
import type { BoundServices } from "../api/bind-services";

// Re-export for convenience
export type { RouteHandlerInputOptions } from "../api/route-handler-input-options";
export type { FragnoResponse } from "../api/fragno-response";

export type TestBaseServices<TDeps> = {
  /**
   * Access to fragment dependencies for testing purposes.
   */
  deps: TDeps;
};

/**
 * Extension function that adds test utilities to a fragment definition.
 * This adds a `test` service to base services with access to deps.
 *
 * @example
 * ```typescript
 * const definition = defineFragment("my-fragment")
 *   .withDependencies(({ config }) => ({ client: createClient(config) }))
 *   .extend(withTestUtils())
 *   .build();
 *
 * const fragment = createFragmentForTest(definition, [], { config: {...} });
 * expect(fragment.services.test.deps.client).toBeDefined();
 * ```
 */
export function withTestUtils() {
  return <
    TConfig,
    TOptions extends FragnoPublicConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDeps,
    TPrivateServices,
    TServiceThisContext extends RequestThisContext,
    THandlerThisContext extends RequestThisContext,
    TRequestStorage,
  >(
    builder: FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDeps,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage
    >,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices & TestBaseServices<TDeps>,
    TServices,
    TServiceDeps,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage
  > => {
    // Get the current base services factory
    const currentBaseDef = builder.build();
    const currentBaseServices = currentBaseDef.baseServices;

    // Create new base services factory that merges test utilities
    const newBaseServices: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDeps,
      TPrivateServices,
      TBaseServices & TestBaseServices<TDeps>,
      TServiceThisContext
    > = (context) => {
      // Call existing base services if they exist
      const existingServices = currentBaseServices
        ? currentBaseServices(context)
        : ({} as TBaseServices);

      // Add test utilities
      const testUtils: TestBaseServices<TDeps> = {
        deps: context.deps,
      };

      return {
        ...existingServices,
        ...testUtils,
      } as TBaseServices & TestBaseServices<TDeps>;
    };

    // Create new builder with updated base services
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices & TestBaseServices<TDeps>,
      TServices,
      TServiceDeps,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage
    >(builder.name, {
      dependencies: currentBaseDef.dependencies,
      baseServices: newBaseServices,
      namedServices: currentBaseDef.namedServices,
      privateServices: currentBaseDef.privateServices,
      serviceDependencies: currentBaseDef.serviceDependencies,
      createRequestStorage: currentBaseDef.createRequestStorage,
      createThisContext: currentBaseDef.createThisContext,
    });
  };
}

/**
 * Options for creating a test fragment with the new architecture
 */
export interface CreateFragmentForTestOptions<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TServiceDependencies,
> {
  config: TConfig;
  options?: Partial<TOptions>;
  serviceImplementations?: TServiceDependencies;
}

/**
 * Create a fragment instance for testing with optional service dependency overrides.
 * This uses the new fragment definition and instantiation architecture.
 *
 * **Important:** Use `.extend(withTestUtils())` before `.build()` to expose deps via `services.test.deps`.
 *
 * Returns an instantiated fragment with:
 * - `services` - Services (base + named) from the fragment definition
 * - `services.test.deps` - Dependencies (only if you used .extend(withTestUtils()))
 * - `callRoute()` - Type-safe method to call routes directly
 * - `handler()` - Request handler for integration
 * - `inContext()` - Run code within request context
 *
 * @param definition - The fragment definition from builder.build()
 * @param routesOrFactories - Route configurations or route factories
 * @param options - Configuration and optional overrides
 * @returns An instantiated fragment ready for testing
 *
 * @example
 * ```typescript
 * const definition = defineFragment<{ apiKey: string }>("test")
 *   .withDependencies(({ config }) => ({ client: createClient(config.apiKey) }))
 *   .providesService("api", ({ deps }) => ({ call: () => deps.client.call() }))
 *   .extend(withTestUtils())  // <- Add test utilities
 *   .build();
 *
 * const fragment = createFragmentForTest(
 *   definition,
 *   [route1, route2],
 *   {
 *     config: { apiKey: "test-key" },
 *     options: { mountRoute: "/api/test" }
 *   }
 * );
 *
 * // Access deps via test utilities
 * expect(fragment.services.test.deps.client).toBeDefined();
 * expect(fragment.services.api.call()).toBeDefined();
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
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices extends Record<string, unknown>,
  TServices extends Record<string, unknown>,
  TServiceDependencies,
  TPrivateServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  TInternalRoutes extends readonly AnyRouteOrFactory[] = readonly [],
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
    TInternalRoutes
  >,
  routesOrFactories: TRoutesOrFactories,
  options: CreateFragmentForTestOptions<TConfig, TOptions, TServiceDependencies>,
): FragnoInstantiatedFragment<
  RoutesWithInternal<FlattenRouteFactories<TRoutesOrFactories>, TInternalRoutes>,
  TDeps,
  BoundServices<TBaseServices & TServices>,
  TServiceThisContext,
  THandlerThisContext,
  TRequestStorage,
  TOptions
> {
  const { config, options: fragmentOptions = {} as TOptions, serviceImplementations } = options;

  // Use default mountRoute for testing if not provided
  const fullOptions = {
    mountRoute: "/api/test",
    ...fragmentOptions,
  } as TOptions;

  // Instantiate and return the fragment directly
  return instantiateFragment(
    definition,
    config,
    routesOrFactories,
    fullOptions,
    serviceImplementations,
  );
}
