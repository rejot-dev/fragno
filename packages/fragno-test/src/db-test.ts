import type { AnySchema } from "@fragno-dev/db/schema";
import type { FragnoPublicConfig } from "@fragno-dev/core/api/fragment-instantiation";
import type { RequestThisContext } from "@fragno-dev/core/api";
import {
  type NewFragmentInstantiationBuilder,
  type NewFragnoInstantiatedFragment,
  instantiateNewFragment,
} from "@fragno-dev/core/api/fragment-instantiator";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "@fragno-dev/core/api/route";
import {
  createAdapter,
  type SupportedAdapter,
  type AdapterContext,
  type SchemaConfig,
} from "./adapters";
import type { DatabaseAdapter } from "@fragno-dev/db";
import type { AbstractQuery } from "@fragno-dev/db/query";
import type { BaseTestContext } from ".";
import type { NewFragmentDefinition } from "@fragno-dev/core/api/fragment-definition-builder";

// BoundServices is an internal type that strips 'this' parameters from service methods
// It's used to represent services after they've been bound to a context
type BoundServices<T> = {
  [K in keyof T]: T[K] extends (this: any, ...args: infer A) => infer R // eslint-disable-line @typescript-eslint/no-explicit-any
    ? (...args: A) => R
    : T[K] extends Record<string, unknown>
      ? BoundServices<T[K]>
      : T[K];
};

// Extract the schema type from database fragment dependencies
// Database fragments have ImplicitDatabaseDependencies<TSchema> which includes `schema: TSchema`
type ExtractSchemaFromDeps<TDeps> = TDeps extends { schema: infer TSchema extends AnySchema }
  ? TSchema
  : AnySchema;

/**
 * Configuration for a single fragment in the test builder
 */
interface FragmentBuilderConfig<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices extends Record<string, unknown>,
  TServices extends Record<string, unknown>,
  TServiceDependencies,
  TThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutesOrFactories extends readonly AnyRouteOrFactory[],
> {
  definition: NewFragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  >;
  builder: NewFragmentInstantiationBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage,
    TRoutesOrFactories
  >;
  migrateToVersion?: number;
}

/**
 * Result type for a single fragment
 */
interface FragmentResult<
  TDeps,
  TServices extends Record<string, unknown>,
  TThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutes extends readonly any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  TSchema extends AnySchema,
> {
  fragment: NewFragnoInstantiatedFragment<TRoutes, TDeps, TServices, TThisContext, TRequestStorage>;
  services: TServices;
  deps: TDeps;
  callRoute: NewFragnoInstantiatedFragment<
    TRoutes,
    TDeps,
    TServices,
    TThisContext,
    TRequestStorage
  >["callRoute"];
  db: AbstractQuery<TSchema>;
}

/**
 * Test context combining base and adapter-specific functionality
 */
type TestContext<
  T extends SupportedAdapter,
  TFirstFragmentThisContext extends RequestThisContext = RequestThisContext,
> = BaseTestContext &
  AdapterContext<T> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: DatabaseAdapter<any>;
    /**
     * Execute a callback within the first fragment's request context.
     * This is useful for calling services outside of route handlers in tests.
     */
    inContext<TResult>(callback: (this: TFirstFragmentThisContext) => TResult): TResult;
    inContext<TResult>(
      callback: (this: TFirstFragmentThisContext) => Promise<TResult>,
    ): Promise<TResult>;
  };

/**
 * Result of building the database fragments test
 */
interface DatabaseFragmentsTestResult<
  TFragments extends Record<string, FragmentResult<any, any, any, any, any, any>>, // eslint-disable-line @typescript-eslint/no-explicit-any
  TAdapter extends SupportedAdapter,
  TFirstFragmentThisContext extends RequestThisContext = RequestThisContext,
> {
  fragments: TFragments;
  test: TestContext<TAdapter, TFirstFragmentThisContext>;
}

/**
 * Internal storage for fragment configurations
 */
type FragmentConfigMap = Map<
  string,
  FragmentBuilderConfig<any, any, any, any, any, any, any, any, any> // eslint-disable-line @typescript-eslint/no-explicit-any
>;

/**
 * Builder for creating multiple database fragments for testing
 */
export class DatabaseFragmentsTestBuilder<
  TFragments extends Record<string, FragmentResult<any, any, any, any, any, any>>, // eslint-disable-line @typescript-eslint/no-explicit-any
  TAdapter extends SupportedAdapter | undefined = undefined,
  TFirstFragmentThisContext extends RequestThisContext = RequestThisContext,
> {
  #adapter?: SupportedAdapter;
  #fragments: FragmentConfigMap = new Map();

  /**
   * Set the test adapter configuration
   */
  withTestAdapter<TNewAdapter extends SupportedAdapter>(
    adapter: TNewAdapter,
  ): DatabaseFragmentsTestBuilder<TFragments, TNewAdapter, TFirstFragmentThisContext> {
    this.#adapter = adapter;
    return this as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /**
   * Add a fragment to the test setup
   *
   * @param name - Unique name for the fragment
   * @param builder - Pre-configured instantiation builder
   * @param options - Additional options including the fragment definition (required for schema extraction)
   */
  withFragment<
    TName extends string,
    TConfig,
    TOptions extends FragnoPublicConfig,
    TDeps,
    TBaseServices extends Record<string, unknown>,
    TServices extends Record<string, unknown>,
    TServiceDependencies,
    TThisContext extends RequestThisContext,
    TRequestStorage,
    TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  >(
    name: TName,
    builder: NewFragmentInstantiationBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TThisContext,
      TRequestStorage,
      TRoutesOrFactories
    >,
    options: {
      definition: NewFragmentDefinition<
        TConfig,
        TOptions,
        TDeps,
        TBaseServices,
        TServices,
        TServiceDependencies,
        TThisContext,
        TRequestStorage
      >;
      migrateToVersion?: number;
    },
  ): DatabaseFragmentsTestBuilder<
    TFragments & {
      [K in TName]: FragmentResult<
        TDeps,
        BoundServices<TBaseServices & TServices>,
        TThisContext,
        TRequestStorage,
        FlattenRouteFactories<TRoutesOrFactories>,
        ExtractSchemaFromDeps<TDeps> // Extract actual schema type from deps
      >;
    },
    TAdapter,
    // If this is the first fragment (TFragments is empty {}), use TThisContext; otherwise keep existing
    keyof TFragments extends never ? TThisContext : TFirstFragmentThisContext
  > {
    this.#fragments.set(name, {
      definition: options.definition,
      builder,
      migrateToVersion: options.migrateToVersion,
    });
    return this as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /**
   * Build the test setup and return fragments and test context
   */
  async build(): Promise<
    TAdapter extends SupportedAdapter
      ? DatabaseFragmentsTestResult<TFragments, TAdapter, TFirstFragmentThisContext>
      : never
  > {
    if (!this.#adapter) {
      throw new Error("Test adapter must be set using withTestAdapter()");
    }

    if (this.#fragments.size === 0) {
      throw new Error("At least one fragment must be added using withFragment()");
    }

    const adapterConfig = this.#adapter;

    // Extract fragment names and configs
    const fragmentNames = Array.from(this.#fragments.keys());
    const fragmentConfigs = Array.from(this.#fragments.values());

    // Extract schemas from definitions and prepare schema configs
    const schemaConfigs: SchemaConfig[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builderConfigs: Array<{ config: any; routes: any; options: any }> = [];

    for (const fragmentConfig of fragmentConfigs) {
      const builder = fragmentConfig.builder;
      const definition = builder.definition;

      // Extract schema from definition by calling dependencies with a mock adapter
      let schema: AnySchema | undefined;
      const namespace = definition.name + "-db";

      if (definition.dependencies) {
        try {
          // Create a mock adapter to extract the schema
          const mockAdapter = {
            createQueryEngine: () => ({ schema: null }),
            contextStorage: { run: (_data: unknown, fn: () => unknown) => fn() },
          };

          // Use the actual config from the builder instead of an empty mock
          // This ensures dependencies can be properly initialized (e.g., Stripe with API keys)
          const actualConfig = builder.config ?? {};

          const deps = definition.dependencies({
            config: actualConfig,
            options: {
              databaseAdapter: mockAdapter as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          });

          // The schema is in deps.schema for database fragments
          if (deps && typeof deps === "object" && "schema" in deps) {
            schema = (deps as any).schema; // eslint-disable-line @typescript-eslint/no-explicit-any
          }
        } catch (error) {
          // If extraction fails, provide a helpful error message
          const errorMessage =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Unknown error";

          throw new Error(
            `Failed to extract schema from fragment '${definition.name}'.\n` +
              `Original error: ${errorMessage}\n\n` +
              `Make sure the fragment is a database fragment using defineFragment().extend(withDatabase(schema)).`,
          );
        }
      }

      if (!schema) {
        throw new Error(
          `Fragment '${definition.name}' does not have a database schema. ` +
            `Make sure you're using defineFragment().extend(withDatabase(schema)).`,
        );
      }

      schemaConfigs.push({
        schema,
        namespace,
        migrateToVersion: fragmentConfig.migrateToVersion,
      });

      // Extract config, routes, and options from builder using public getters
      builderConfigs.push({
        config: builder.config ?? {},
        routes: builder.routes ?? [],
        options: builder.options ?? {},
      });
    }

    // Create adapter with all schemas
    const { testContext, adapter } = await createAdapter(adapterConfig, schemaConfigs);

    // Helper to create fragments with service wiring
    const createFragments = () => {
      // First pass: create fragments without service dependencies to extract provided services
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providedServicesByName: Record<string, { service: any; orm: any }> = {};
      const fragmentResults: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

      for (let i = 0; i < fragmentConfigs.length; i++) {
        const fragmentConfig = fragmentConfigs[i]!;
        const definition = fragmentConfig.builder.definition;
        const builderConfig = builderConfigs[i]!;
        const namespace = schemaConfigs[i]!.namespace;
        const schema = schemaConfigs[i]!.schema;
        const orm = testContext.getOrm(namespace);

        // Merge builder options with database adapter
        const mergedOptions = {
          ...builderConfig.options,
          databaseAdapter: adapter,
        };

        // Instantiate fragment
        const fragment = instantiateNewFragment(
          definition,
          builderConfig.config,
          builderConfig.routes,
          mergedOptions,
          undefined, // No service implementations yet
        );

        // Extract provided services based on serviceDependencies metadata
        // Note: serviceDependencies lists services this fragment USES, not provides
        // For provided services, we need to check what's actually in fragment.services
        // and match against other fragments' service dependencies

        // Store all services as potentially provided
        for (const [serviceName, serviceImpl] of Object.entries(fragment.services)) {
          providedServicesByName[serviceName] = {
            service: serviceImpl,
            orm,
          };
        }

        // Store the fragment result
        const deps = fragment.$internal?.deps;

        fragmentResults.push({
          fragment,
          services: fragment.services,
          deps: deps || {},
          callRoute: fragment.callRoute.bind(fragment),
          get db() {
            return orm;
          },
          _orm: orm,
          _schema: schema,
        });
      }

      // Second pass: rebuild fragments with service dependencies wired up
      for (let i = 0; i < fragmentConfigs.length; i++) {
        const fragmentConfig = fragmentConfigs[i]!;
        const definition = fragmentConfig.builder.definition;
        const builderConfig = builderConfigs[i]!;
        const namespace = schemaConfigs[i]!.namespace;
        const schema = schemaConfigs[i]!.schema;
        const orm = testContext.getOrm(namespace);

        // Build service implementations for services this fragment uses
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const serviceImplementations: Record<string, any> = {};
        const serviceDependencies = definition.serviceDependencies;

        if (serviceDependencies) {
          for (const serviceName of Object.keys(serviceDependencies)) {
            if (providedServicesByName[serviceName]) {
              serviceImplementations[serviceName] = providedServicesByName[serviceName]!.service;
            }
          }
        }

        // Merge builder options with database adapter
        const mergedOptions = {
          ...builderConfig.options,
          databaseAdapter: adapter,
        };

        // Rebuild the fragment with service implementations
        const fragment = instantiateNewFragment(
          definition,
          builderConfig.config,
          builderConfig.routes,
          mergedOptions,
          serviceImplementations,
        );

        // Update the result
        // Access deps from the internal property
        const deps = fragment.$internal?.deps;

        fragmentResults[i] = {
          fragment,
          services: fragment.services,
          deps: deps || {},
          callRoute: fragment.callRoute.bind(fragment),
          get db() {
            return orm;
          },
          _orm: orm,
          _schema: schema,
        };
      }

      return fragmentResults;
    };

    const fragmentResults = createFragments();

    // Wrap resetDatabase to also recreate all fragments
    const originalResetDatabase = testContext.resetDatabase;
    const resetDatabase = async () => {
      await originalResetDatabase();

      // Recreate all fragments with service wiring
      const newFragmentResults = createFragments();

      // Update the result objects
      newFragmentResults.forEach((newResult, index) => {
        const result = fragmentResults[index]!;
        result.fragment = newResult.fragment;
        result.services = newResult.services;
        result.deps = newResult.deps;
        result.callRoute = newResult.callRoute;
        result._orm = newResult._orm;
      });
    };

    // Get the first fragment's inContext method
    const firstFragment = fragmentResults[0]?.fragment;
    if (!firstFragment) {
      throw new Error("At least one fragment must be added");
    }

    const finalTestContext = {
      ...testContext,
      resetDatabase,
      adapter,
      inContext: firstFragment.inContext.bind(firstFragment),
    };

    // Build result object with named fragments
    const fragmentsObject = Object.fromEntries(
      fragmentNames.map((name, index) => [name, fragmentResults[index]]),
    );

    // Safe cast: We've already validated that adapterConfig is SupportedAdapter at the beginning of build()
    // TypeScript can't infer this through the conditional return type, so we use 'as any'
    return {
      fragments: fragmentsObject as TFragments,
      test: finalTestContext,
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

/**
 * Create a builder for setting up multiple database fragments for testing.
 * This is the new builder-based API that works with the new fragment instantiation builders.
 *
 * @example
 * ```typescript
 * const userFragmentDef = defineFragment("user")
 *   .extend(withDatabase(userSchema))
 *   .withDependencies(...)
 *   .build();
 *
 * const postFragmentDef = defineFragment("post")
 *   .extend(withDatabase(postSchema))
 *   .withDependencies(...)
 *   .build();
 *
 * const { fragments, test } = await buildDatabaseFragmentsTest()
 *   .withTestAdapter({ type: "kysely-sqlite" })
 *   .withFragment("user",
 *     instantiate(userFragmentDef)
 *       .withConfig({ ... })
 *       .withRoutes([...]),
 *     { definition: userFragmentDef }
 *   )
 *   .withFragment("post",
 *     instantiate(postFragmentDef)
 *       .withRoutes([...]),
 *     { definition: postFragmentDef }
 *   )
 *   .build();
 *
 * // Access fragments by name
 * await fragments.user.services.createUser(...);
 * await fragments.post.services.createPost(...);
 *
 * // Access dependencies directly
 * const userDeps = fragments.user.deps;
 *
 * // Shared test context
 * await test.resetDatabase();
 * await test.cleanup();
 * const adapter = test.adapter; // Access the database adapter
 * ```
 */
export function buildDatabaseFragmentsTest(): DatabaseFragmentsTestBuilder<
  {},
  undefined,
  RequestThisContext
> {
  return new DatabaseFragmentsTestBuilder();
}
