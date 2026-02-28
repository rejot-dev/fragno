import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  FragmentInstantiationBuilder,
  FragnoInstantiatedFragment,
  AnyFragnoInstantiatedFragment,
  FragmentDefinition,
} from "@fragno-dev/core";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "@fragno-dev/core/route";
import {
  createAdapter,
  type SupportedAdapter,
  type AdapterContext,
  type SchemaConfig,
} from "./adapters";
import type { DatabaseAdapter, FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
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

type FragmentFactoryContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: DatabaseAdapter<any>;
  test: BaseTestContext & AdapterContext<SupportedAdapter>;
};

type FragmentFactoryResult =
  | FragmentInstantiationBuilder<
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
    >
  | FragnoInstantiatedFragment<
      any, // eslint-disable-line @typescript-eslint/no-explicit-any
      any, // eslint-disable-line @typescript-eslint/no-explicit-any
      any, // eslint-disable-line @typescript-eslint/no-explicit-any
      any, // eslint-disable-line @typescript-eslint/no-explicit-any
      any, // eslint-disable-line @typescript-eslint/no-explicit-any
      any, // eslint-disable-line @typescript-eslint/no-explicit-any
      any // eslint-disable-line @typescript-eslint/no-explicit-any
    >;

type HandlerThisContextFromFactoryResult<T> =
  T extends FragmentInstantiationBuilder<
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    infer THandlerThisContext,
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any // eslint-disable-line @typescript-eslint/no-explicit-any
  >
    ? THandlerThisContext
    : T extends FragnoInstantiatedFragment<
          any, // eslint-disable-line @typescript-eslint/no-explicit-any
          any, // eslint-disable-line @typescript-eslint/no-explicit-any
          any, // eslint-disable-line @typescript-eslint/no-explicit-any
          any, // eslint-disable-line @typescript-eslint/no-explicit-any
          infer THandlerThisContext,
          any, // eslint-disable-line @typescript-eslint/no-explicit-any
          any // eslint-disable-line @typescript-eslint/no-explicit-any
        >
      ? THandlerThisContext
      : RequestThisContext;

type FragmentResultFromFactoryResult<T> =
  T extends FragmentInstantiationBuilder<
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    infer TDeps,
    infer TBaseServices,
    infer TServices,
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    any, // eslint-disable-line @typescript-eslint/no-explicit-any
    infer TServiceThisContext,
    infer THandlerThisContext,
    infer TRequestStorage,
    infer TRoutesOrFactories,
    any // eslint-disable-line @typescript-eslint/no-explicit-any
  >
    ? FragmentResult<
        TDeps,
        BoundServices<TBaseServices & TServices>,
        TServiceThisContext,
        THandlerThisContext,
        TRequestStorage,
        FlattenRouteFactories<TRoutesOrFactories>,
        ExtractSchemaFromDeps<TDeps>
      >
    : T extends FragnoInstantiatedFragment<
          infer TRoutes,
          infer TDeps,
          infer TServices,
          infer TServiceThisContext,
          infer THandlerThisContext,
          infer TRequestStorage,
          any // eslint-disable-line @typescript-eslint/no-explicit-any
        >
      ? FragmentResult<
          TDeps,
          BoundServices<TServices>,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage,
          TRoutes,
          ExtractSchemaFromDeps<TDeps>
        >
      : never;

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
export type AnyFragmentResult = FragmentResult<
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
  kind: "builder";
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
 * Configuration for a pre-built fragment instance
 */
interface FragmentInstanceConfig<
  TDeps,
  TServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutes extends readonly any[], // eslint-disable-line @typescript-eslint/no-explicit-any
> {
  kind: "instance";
  fragment: FragnoInstantiatedFragment<
    TRoutes,
    TDeps,
    TServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    FragnoPublicConfig
  >;
  migrateToVersion?: number;
}

/**
 * Configuration for a fragment factory
 */
interface FragmentFactoryConfig {
  kind: "factory";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: FragmentDefinition<any, any, any, any, any, any, any, any, any, any, any>;
  factory: (context: FragmentFactoryContext) => FragmentFactoryResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any;
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
type AnyFragmentInstanceConfig = FragmentInstanceConfig<
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any // eslint-disable-line @typescript-eslint/no-explicit-any
>;

type AnyFragmentFactoryConfig = FragmentFactoryConfig;

type AnyFragmentConfig =
  | AnyFragmentBuilderConfig
  | AnyFragmentInstanceConfig
  | AnyFragmentFactoryConfig;

type FragmentConfigMap = Map<string, AnyFragmentConfig>;

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
  #dbRoundtripGuard?: FragnoPublicConfigWithDatabase["dbRoundtripGuard"] = true;

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
   * Opt out of the default roundtrip guard (enabled by default), or override its configuration.
   * Useful for allowing multi-roundtrip routes in tests.
   */
  withDbRoundtripGuard(
    guard: FragnoPublicConfigWithDatabase["dbRoundtripGuard"] = false,
  ): DatabaseFragmentsTestBuilder<TFragments, TAdapter, TFirstFragmentThisContext> {
    this.#dbRoundtripGuard = guard;
    return this;
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
      kind: "builder",
      definition: builder.definition,
      builder,
      migrateToVersion: options?.migrateToVersion,
    });
    return this as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /**
   * Add a pre-built fragment instance to the test setup
   *
   * @param name - Unique name for the fragment
   * @param fragment - Already-built fragment instance
   */
  withFragmentInstance<
    TName extends string,
    TRoutes extends readonly any[], // eslint-disable-line @typescript-eslint/no-explicit-any
    TDeps,
    TServices extends Record<string, unknown>,
    TServiceThisContext extends RequestThisContext,
    THandlerThisContext extends RequestThisContext,
    TRequestStorage,
  >(
    name: TName,
    fragment: FragnoInstantiatedFragment<
      TRoutes,
      TDeps,
      TServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      FragnoPublicConfig
    >,
    options?: { migrateToVersion?: number },
  ): DatabaseFragmentsTestBuilder<
    TFragments & {
      [K in TName]: FragmentResult<
        TDeps,
        BoundServices<TServices>,
        TServiceThisContext,
        THandlerThisContext,
        TRequestStorage,
        TRoutes,
        ExtractSchemaFromDeps<TDeps>
      >;
    },
    TAdapter,
    keyof TFragments extends never ? THandlerThisContext : TFirstFragmentThisContext
  > {
    this.#fragments.set(name, {
      kind: "instance",
      fragment,
      migrateToVersion: options?.migrateToVersion,
    });

    return this as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /**
   * Add a fragment factory to the test setup.
   * The factory runs after the adapter is created.
   *
   * @param name - Unique name for the fragment
   * @param definition - Fragment definition (used to extract schema/namespace)
   * @param factory - Factory that returns a builder or a pre-built fragment
   */
  withFragmentFactory<TName extends string, TFactoryResult extends FragmentFactoryResult>(
    name: TName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    definition: FragmentDefinition<any, any, any, any, any, any, any, any, any, any, any>,
    factory: (context: FragmentFactoryContext) => TFactoryResult,
    options?: {
      migrateToVersion?: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config?: any;
    },
  ): DatabaseFragmentsTestBuilder<
    TFragments & {
      [K in TName]: FragmentResultFromFactoryResult<TFactoryResult>;
    },
    TAdapter,
    keyof TFragments extends never
      ? HandlerThisContextFromFactoryResult<TFactoryResult>
      : TFirstFragmentThisContext
  > {
    this.#fragments.set(name, {
      kind: "factory",
      definition,
      factory,
      config: options?.config,
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
      throw new Error(
        "At least one fragment must be added using withFragment(), withFragmentFactory(), or withFragmentInstance().",
      );
    }

    const adapterConfig = this.#adapter;

    // Extract fragment names and configs
    const fragmentEntries = Array.from(this.#fragments.entries());
    const fragmentNames = fragmentEntries.map(([name]) => name);

    // Extract schemas from definitions and prepare schema configs
    const schemaConfigs: SchemaConfig[] = [];
    const fragmentPlans: Array<{
      name: string;
      kind: "builder" | "instance" | "factory";
      schema: AnySchema;
      namespace: string | null;
      migrateToVersion?: number;
      builderConfig?: {
        builder: AnyFragmentBuilderConfig["builder"];
        definition: AnyFragmentBuilderConfig["definition"];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        routes: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: any;
      };
      factory?: FragmentFactoryConfig["factory"];
      cachedFactoryResult?: FragmentFactoryResult;
      fragment?: AnyFragnoInstantiatedFragment;
    }> = [];

    const extractSchemaFromDefinition = (
      definition: FragmentDefinition<any, any, any, any, any, any, any, any, any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actualConfig: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actualOptions?: any,
    ) => {
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

          const deps = definition.dependencies({
            config: actualConfig ?? {},
            options: {
              ...actualOptions,
              databaseAdapter: mockAdapter as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          });

          if (deps && typeof deps === "object" && "schema" in deps) {
            schema = (deps as any).schema; // eslint-disable-line @typescript-eslint/no-explicit-any
            namespace = (deps as any).namespace; // eslint-disable-line @typescript-eslint/no-explicit-any
          }
        } catch (error) {
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

      return { schema, namespace };
    };

    for (const [name, fragmentConfig] of fragmentEntries) {
      if (fragmentConfig.kind === "builder") {
        const builder = fragmentConfig.builder;
        const definition = builder.definition;
        const { schema, namespace } = extractSchemaFromDefinition(
          definition,
          builder.config ?? {},
          builder.options ?? {},
        );

        schemaConfigs.push({
          schema,
          namespace,
          migrateToVersion: fragmentConfig.migrateToVersion,
        });

        fragmentPlans.push({
          name,
          kind: "builder",
          schema,
          namespace,
          migrateToVersion: fragmentConfig.migrateToVersion,
          builderConfig: {
            builder: fragmentConfig.builder,
            definition: fragmentConfig.definition,
            config: builder.config ?? {},
            routes: builder.routes ?? [],
            options: builder.options ?? {},
          },
        });
        continue;
      }

      if (fragmentConfig.kind === "factory") {
        const definition = fragmentConfig.definition;
        const { schema, namespace } = extractSchemaFromDefinition(
          definition,
          fragmentConfig.config ?? {},
        );

        schemaConfigs.push({
          schema,
          namespace,
          migrateToVersion: fragmentConfig.migrateToVersion,
        });

        fragmentPlans.push({
          name,
          kind: "factory",
          schema,
          namespace,
          migrateToVersion: fragmentConfig.migrateToVersion,
          factory: fragmentConfig.factory,
        });

        continue;
      }

      const fragment = fragmentConfig.fragment;
      const deps = fragment.$internal?.deps as
        | {
            schema?: AnySchema;
            namespace?: string | null;
          }
        | undefined;

      if (!deps?.schema) {
        throw new Error(
          `Fragment '${name}' does not have a database schema in deps. ` +
            `Make sure you're using defineFragment().extend(withDatabase(schema)).`,
        );
      }

      schemaConfigs.push({
        schema: deps.schema,
        namespace: deps.namespace ?? null,
        migrateToVersion: fragmentConfig.migrateToVersion,
      });

      fragmentPlans.push({
        name,
        kind: "instance",
        schema: deps.schema,
        namespace: deps.namespace ?? null,
        migrateToVersion: fragmentConfig.migrateToVersion,
        fragment,
      });
    }

    const { testContext, adapter } = await createAdapter(adapterConfig, schemaConfigs);

    const resolveDbRoundtripGuardOption = (options: unknown) => {
      if (options && typeof options === "object") {
        if (Object.prototype.hasOwnProperty.call(options, "dbRoundtripGuard")) {
          return (options as { dbRoundtripGuard?: unknown }).dbRoundtripGuard as
            | FragnoPublicConfigWithDatabase["dbRoundtripGuard"]
            | undefined;
        }
      }
      return this.#dbRoundtripGuard;
    };

    const mergeBuilderOptions = (options: unknown) => {
      const resolvedOptions = (options ?? {}) as Record<string, unknown>;
      const merged = {
        ...resolvedOptions,
        databaseAdapter: adapter,
      } as Record<string, unknown>;
      const guardOption = resolveDbRoundtripGuardOption(resolvedOptions);
      if (guardOption !== undefined) {
        merged["dbRoundtripGuard"] = guardOption;
      }
      return merged;
    };

    // Helper to create fragments with service wiring
    const createFragments = () => {
      const resolveBuilderConfig = (builder: AnyFragmentBuilderConfig["builder"]) => ({
        builder,
        definition: builder.definition,
        config: builder.config ?? {},
        routes: builder.routes ?? [],
        options: builder.options ?? {},
      });

      const isBuilder = (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: any,
      ): value is AnyFragmentBuilderConfig["builder"] =>
        Boolean(value) && typeof value === "object" && "build" in value && "definition" in value;

      // First pass: create fragments without service dependencies to extract provided services
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providedServicesByName: Record<string, { service: any; orm: any }> = {};
      const instanceResults = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
      const builderConfigs = new Map<string, ReturnType<typeof resolveBuilderConfig>>();

      for (const plan of fragmentPlans) {
        const orm = testContext.getOrm(plan.namespace);
        let fragment: AnyFragnoInstantiatedFragment | undefined;
        let builderConfig = plan.builderConfig;

        if (plan.kind === "factory") {
          const result =
            plan.cachedFactoryResult ??
            plan.factory!({
              adapter,
              test: testContext,
            });

          if (!plan.cachedFactoryResult) {
            plan.cachedFactoryResult = result;
          }

          if (isBuilder(result)) {
            builderConfig = resolveBuilderConfig(result);
          } else {
            fragment = result;
          }
        }

        const usesBuilder = plan.kind === "builder" || !!builderConfig;

        if (usesBuilder) {
          const resolvedBuilderConfig = builderConfig ?? plan.builderConfig!;
          const mergedOptions = mergeBuilderOptions(resolvedBuilderConfig.options);

          fragment = resolvedBuilderConfig.builder.withOptions(mergedOptions).build();
          builderConfigs.set(plan.name, resolvedBuilderConfig);
        } else {
          fragment = fragment ?? plan.fragment!;

          const deps = fragment.$internal?.deps as
            | { databaseAdapter?: DatabaseAdapter<unknown> }
            | undefined;
          if (deps?.databaseAdapter && deps.databaseAdapter !== adapter) {
            throw new Error(
              `Fragment '${plan.name}' was built with a different database adapter instance. ` +
                `Use withFragment() or ensure the fragment uses the same adapter instance as the test builder.`,
            );
          }
        }

        if (!fragment) {
          throw new Error(
            `Fragment '${plan.name}' did not return a valid fragment instance from its factory.`,
          );
        }

        for (const [serviceName, serviceImpl] of Object.entries(fragment.services)) {
          providedServicesByName[serviceName] = {
            service: serviceImpl,
            orm,
          };
        }

        if (!usesBuilder) {
          const deps = fragment.$internal?.deps;
          instanceResults.set(plan.name, {
            fragment,
            services: fragment.services,
            deps: deps || {},
            callRoute: fragment.callRoute.bind(fragment),
            get db() {
              return orm;
            },
            _orm: orm,
            _schema: plan.schema,
          });
        }
      }

      // Second pass: rebuild fragments with service dependencies wired up
      const fragmentResults: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

      for (const plan of fragmentPlans) {
        const orm = testContext.getOrm(plan.namespace);

        if (instanceResults.has(plan.name)) {
          fragmentResults.push(instanceResults.get(plan.name));
          continue;
        }

        const builderConfig = builderConfigs.get(plan.name);
        if (!builderConfig) {
          throw new Error(
            `Fragment '${plan.name}' was expected to produce a builder for service wiring.`,
          );
        }
        const definition = builderConfig.definition;

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
        const mergedOptions = mergeBuilderOptions(builderConfig.options);

        // Rebuild the fragment with service implementations using the builder
        const fragment = builderConfig.builder
          .withOptions(mergedOptions)
          .withServices(serviceImplementations as any) // eslint-disable-line @typescript-eslint/no-explicit-any
          .build();

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
          _schema: plan.schema,
        });
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
