import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  FragmentInstantiationBuilder,
  FragnoInstantiatedFragment,
  FragmentDefinition,
} from "@fragno-dev/core";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "@fragno-dev/core/route";
import {
  createAdapter,
  type SupportedAdapter,
  type AdapterContext,
  type SchemaConfig,
} from "./adapters";
import type { DatabaseAdapter } from "@fragno-dev/db";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { BaseTestContext } from ".";
import { drainDurableHooks } from "./durable-hooks";

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

// Forward declarations for recursive type references
interface FragmentResult<
  TDeps,
  TServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutes extends readonly any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  TSchema extends AnySchema,
> {
  fragment: FragnoInstantiatedFragment<
    TRoutes,
    TDeps,
    TServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    FragnoPublicConfig
  >;
  services: TServices;
  deps: TDeps;
  callRoute: FragnoInstantiatedFragment<
    TRoutes,
    TDeps,
    TServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    FragnoPublicConfig
  >["callRoute"];
  db: SimpleQueryInterface<TSchema>;
}

// Safe: Catch-all for any fragment result type
type AnyFragmentResult = FragmentResult<
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any // eslint-disable-line @typescript-eslint/no-explicit-any
>;

// Safe: Catch-all for any fragment builder config type
type AnyFragmentBuilderConfig = FragmentBuilderConfig<
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any // eslint-disable-line @typescript-eslint/no-explicit-any
>;

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
  TPrivateServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  TInternalRoutes extends readonly AnyRouteOrFactory[],
> {
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
  >;
  builder: FragmentInstantiationBuilder<
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
    TRoutesOrFactories,
    TInternalRoutes
  >;
  migrateToVersion?: number;
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
  TFragments extends Record<string, AnyFragmentResult>,
  TAdapter extends SupportedAdapter,
  TFirstFragmentThisContext extends RequestThisContext = RequestThisContext,
> {
  fragments: TFragments;
  test: TestContext<TAdapter, TFirstFragmentThisContext>;
}

/**
 * Internal storage for fragment configurations
 */
type FragmentConfigMap = Map<string, AnyFragmentBuilderConfig>;

/**
 * Builder for creating multiple database fragments for testing
 */
export class DatabaseFragmentsTestBuilder<
  TFragments extends Record<string, AnyFragmentResult>,
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
   * @param options - Additional options (optional)
   */
  withFragment<
    TName extends string,
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
    TRoutesOrFactories extends readonly AnyRouteOrFactory[],
    TInternalRoutes extends readonly AnyRouteOrFactory[],
  >(
    name: TName,
    builder: FragmentInstantiationBuilder<
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
      TRoutesOrFactories,
      TInternalRoutes
    >,
    options?: {
      migrateToVersion?: number;
    },
  ): DatabaseFragmentsTestBuilder<
    TFragments & {
      [K in TName]: FragmentResult<
        TDeps,
        BoundServices<TBaseServices & TServices>,
        TServiceThisContext,
        THandlerThisContext,
        TRequestStorage,
        FlattenRouteFactories<TRoutesOrFactories>,
        ExtractSchemaFromDeps<TDeps> // Extract actual schema type from deps
      >;
    },
    TAdapter,
    // If this is the first fragment (TFragments is empty {}), use THandlerThisContext; otherwise keep existing
    keyof TFragments extends never ? THandlerThisContext : TFirstFragmentThisContext
  > {
    this.#fragments.set(name, {
      definition: builder.definition,
      builder,
      migrateToVersion: options?.migrateToVersion,
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

      // Extract schema and namespace from definition by calling dependencies with a mock adapter
      let schema: AnySchema | undefined;
      let namespace: string | null | undefined;

      if (definition.dependencies) {
        try {
          // Create a mock adapter to extract the schema
          const mockAdapter = {
            createQueryEngine: () => ({ schema: null }),
            getSchemaVersion: async () => undefined,
            namingStrategy: {
              namespaceScope: "suffix",
              namespaceToSchema: (value: string) => value,
              tableName: (logicalTable: string, ns: string | null) =>
                ns ? `${logicalTable}_${ns}` : logicalTable,
              columnName: (logicalColumn: string) => logicalColumn,
              indexName: (logicalIndex: string) => logicalIndex,
              uniqueIndexName: (logicalIndex: string) => logicalIndex,
              foreignKeyName: ({ referenceName }: { referenceName: string }) => referenceName,
            },
            contextStorage: { run: (_data: unknown, fn: () => unknown) => fn() },
            close: async () => {},
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

          // The schema and namespace are in deps for database fragments
          if (deps && typeof deps === "object" && "schema" in deps) {
            schema = (deps as any).schema; // eslint-disable-line @typescript-eslint/no-explicit-any
            namespace = (deps as any).namespace; // eslint-disable-line @typescript-eslint/no-explicit-any
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

      if (namespace === undefined) {
        throw new Error(
          `Fragment '${definition.name}' does not have a namespace in dependencies. ` +
            `This should be automatically provided by withDatabase().`,
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

    const { testContext, adapter } = await createAdapter(adapterConfig, schemaConfigs);

    // Helper to create fragments with service wiring
    const createFragments = () => {
      // First pass: create fragments without service dependencies to extract provided services
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providedServicesByName: Record<string, { service: any; orm: any }> = {};
      const fragmentResults: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

      for (let i = 0; i < fragmentConfigs.length; i++) {
        const fragmentConfig = fragmentConfigs[i]!;
        const builderConfig = builderConfigs[i]!;
        const namespace = schemaConfigs[i]!.namespace;
        const schema = schemaConfigs[i]!.schema;
        const orm = testContext.getOrm(namespace);

        // Merge builder options with database adapter
        const mergedOptions = {
          ...builderConfig.options,
          databaseAdapter: adapter,
        };

        // Instantiate fragment using the builder
        const fragment = fragmentConfig.builder.withOptions(mergedOptions).build();

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

        // Rebuild the fragment with service implementations using the builder
        const fragment = fragmentConfig.builder
          .withOptions(mergedOptions)
          .withServices(serviceImplementations as any) // eslint-disable-line @typescript-eslint/no-explicit-any
          .build();

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

    const originalCleanup = testContext.cleanup;
    const cleanup = async () => {
      let drainError: unknown;
      let cleanupError: unknown;

      for (const result of fragmentResults) {
        try {
          await drainDurableHooks(result.fragment);
        } catch (error) {
          if (!drainError) {
            drainError = error;
          }
        }
      }

      try {
        await originalCleanup();
      } catch (error) {
        cleanupError = error;
      }

      if (drainError && cleanupError) {
        throw new AggregateError(
          [drainError, cleanupError],
          "Failed to drain durable hooks and clean up test context",
        );
      }

      if (drainError) {
        throw drainError;
      }

      if (cleanupError) {
        throw cleanupError;
      }
    };

    const finalTestContext = {
      ...testContext,
      resetDatabase,
      cleanup,
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
 *       .withRoutes([...])
 *   )
 *   .withFragment("post",
 *     instantiate(postFragmentDef)
 *       .withRoutes([...])
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
