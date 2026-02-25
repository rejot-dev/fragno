import type { AnySchema } from "./schema/create";
import type { SimpleQueryInterface } from "./query/simple-query-interface";
import type { DatabaseAdapter, DatabaseContextStorage } from "./adapters/adapters";
import type { IUnitOfWork } from "./query/unit-of-work/unit-of-work";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  AnyRouteOrFactory,
  FragnoRouteConfig,
  BoundServices,
} from "@fragno-dev/core";
import {
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceConstructorFn,
} from "@fragno-dev/core";
import {
  createServiceTxBuilder,
  createHandlerTxBuilder,
  ServiceTxBuilder,
  HandlerTxBuilder,
  type AwaitedPromisesInObject,
  type ExtractServiceFinalResults,
  type ExecuteTxOptions,
  type TxResult,
} from "./query/unit-of-work/execute-unit-of-work";
import {
  prepareHookMutations,
  type HooksMap,
  type HookFn,
  type HookContext,
  type HookProcessorConfig,
  type DurableHooksProcessingOptions,
  createHookScheduler,
} from "./hooks/hooks";
import {
  getDurableHooksRuntimeByConfig,
  registerDurableHooksRuntime,
} from "./hooks/durable-hooks-runtime";
import type { SyncCommandRegistry, SyncCommandTargetRegistration } from "./sync/types";
import { resolveDatabaseAdapter } from "./util/default-database-adapter";
import { sanitizeNamespace } from "./naming/sql-naming";
import type { InternalFragmentInstance } from "./fragments/internal-fragment";
type RegistrySchemaInfo = {
  name: string;
  namespace: string | null;
  version: number;
  tables: string[];
};

type RegistryFragmentMeta = {
  name: string;
  mountRoute: string;
};

type ExtractServiceFinalResultOrSingle<T> = T extends readonly (
  | TxResult<unknown, unknown>
  | undefined
)[]
  ? AwaitedPromisesInObject<ExtractServiceFinalResults<T>>
  : T extends undefined
    ? undefined
    : AwaitedPromisesInObject<ExtractServiceFinalResults<readonly [T]>>[0];

type RegistryResolver = {
  getRegistryForAdapterSync: <TUOWConfig>(adapter: DatabaseAdapter<TUOWConfig>) => {
    registerSchema: (
      schema: RegistrySchemaInfo,
      fragment: RegistryFragmentMeta,
      options?: { outboxEnabled?: boolean },
    ) => void;
    registerSyncCommands: (registration: SyncCommandTargetRegistration) => void;
  };
  getInternalFragment: <TUOWConfig>(
    adapter: DatabaseAdapter<TUOWConfig>,
  ) => InternalFragmentInstance;
};

type HooksFactoryContext<TConfig> = {
  config: TConfig;
  options: FragnoPublicConfigWithDatabase;
  deps: unknown;
  services: unknown;
  serviceDeps: unknown;
};

type AnyHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

type AnyFragnoRouteConfig = FragnoRouteConfig<
  AnyHttpMethod,
  string,
  undefined,
  undefined,
  string,
  string,
  RequestThisContext
>;

/**
 * Extended FragnoPublicConfig for database fragments.
 * If databaseAdapter is omitted and better-sqlite3 is available, a default SQLite adapter is used.
 */
export type FragnoPublicConfigWithDatabase = FragnoPublicConfig & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter?: DatabaseAdapter<any>;
  /**
   * Optional outbox configuration for this fragment.
   */
  outbox?: {
    enabled?: boolean;
  };
  /**
   * Optional durable hooks processing configuration.
   */
  durableHooks?: DurableHooksProcessingOptions;
  /**
   * Optional override for database namespace. If provided (including null), it is used as-is
   * without sanitization — the caller is responsible for providing a valid namespace.
   * When omitted, defaults to a sanitized version of schema.name.
   */
  databaseNamespace?: string | null;
};

/**
 * Implicit dependencies that database fragments get automatically.
 * These are injected without requiring explicit configuration.
 */
export type ImplicitDatabaseDependencies<TSchema extends AnySchema> = {
  /**
   * Database adapter instance.
   */
  databaseAdapter: DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * The schema definition for this fragment.
   */
  schema: TSchema;
  /**
   * The database namespace for this fragment.
   */
  namespace: string | null;
  /**
   * Create a new Unit of Work for database operations.
   */
  createUnitOfWork: () => IUnitOfWork;
};

/**
 * Service context for database fragments - provides restricted UOW access without execute methods.
 */
export type DatabaseServiceContext<THooks extends HooksMap> = RequestThisContext & {
  /**
   * Create a service-level transaction builder using the fluent API.
   * Returns a builder that can be chained with withServiceCalls, retrieve,
   * transformRetrieve, mutate, transform, and build.
   *
   * @example
   * ```ts
   * return this.serviceTx(schema)
   *   .withServiceCalls(() => [otherService.getData()])
   *   .retrieve((uow) => uow.find("users", ...))
   *   .transformRetrieve(([users]) => users[0])
   *   .mutate(({ uow, retrieveResult, serviceIntermediateResult }) =>
   *     uow.create("records", { ... })
   *   )
   *   .transform(({ mutateResult, serviceResult }) => ({ id: mutateResult }))
   *   .build();
   * ```
   */
  serviceTx<TSchema extends AnySchema>(
    schema: TSchema,
  ): ServiceTxBuilder<
    TSchema,
    readonly [],
    [],
    [],
    unknown,
    unknown,
    false,
    false,
    false,
    false,
    THooks
  >;
};

/**
 * Handler context for database fragments - provides UOW execution with automatic retry support.
 */
export type DatabaseHandlerContext<THooks extends HooksMap = {}> = RequestThisContext & {
  /**
   * Create a handler-level transaction builder using the fluent API.
   * Returns a builder that can be chained with withServiceCalls, retrieve,
   * transformRetrieve, mutate, transform, and execute.
   *
   * @example
   * ```ts
   * const result = await this.handlerTx()
   *   .withServiceCalls(() => [userService.getUser(id)])
   *   .mutate(({ forSchema, idempotencyKey, currentAttempt, serviceIntermediateResult }) => {
   *     return forSchema(ordersSchema).create("orders", { ... });
   *   })
   *   .transform(({ mutateResult, serviceResult }) => ({ ... }))
   *   .execute();
   * ```
   */
  handlerTx(
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, THooks>;

  /**
   * Execute multiple service calls in a handler context and return their final results.
   */
  callServices<
    TServiceCalls extends
      | TxResult<unknown, unknown>
      | undefined
      | readonly (TxResult<unknown, unknown> | undefined)[],
  >(
    /**
     * Factory to create service calls inside the active context.
     */
    serviceCalls: () => TServiceCalls,
  ): Promise<ExtractServiceFinalResultOrSingle<TServiceCalls>>;
};

/**
 * Database fragment context provided to user callbacks.
 */
export type DatabaseFragmentContext = {
  /**
   * Database adapter instance.
   */
  databaseAdapter: DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type DatabaseFragmentContextInternal<TSchema extends AnySchema> = DatabaseFragmentContext & {
  db: SimpleQueryInterface<TSchema>;
};

/**
 * Create database context from options.
 * This extracts the database adapter and creates the ORM instance.
 */
function createDatabaseContext<TSchema extends AnySchema>(
  options: FragnoPublicConfigWithDatabase,
  schema: TSchema,
): DatabaseFragmentContextInternal<TSchema> {
  const databaseAdapter = resolveDatabaseAdapter(options, schema);

  const namespace = resolveDatabaseNamespace(options, schema);
  const db = databaseAdapter.createQueryEngine(schema, namespace);

  return { databaseAdapter, db };
}

function resolveDatabaseNamespace<TSchema extends AnySchema>(
  options: FragnoPublicConfigWithDatabase,
  schema: TSchema,
): string | null {
  const hasOverride = options.databaseNamespace !== undefined;
  return hasOverride ? (options.databaseNamespace ?? null) : sanitizeNamespace(schema.name);
}

function resolveMountRoute(name: string, mountRoute?: string): string {
  const resolved = mountRoute ?? `/api/${name}`;
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

/**
 * Storage type for database fragments - stores the Unit of Work.
 */
export type DatabaseRequestStorage = {
  uow: IUnitOfWork;
};

/**
 * Builder for database fragments that wraps the core fragment builder
 * and provides database-specific functionality.
 *
 * Database fragments use FragnoPublicConfigWithDatabase and default the adapter when possible.
 */
export class DatabaseFragmentDefinitionBuilder<
  TSchema extends AnySchema,
  TConfig,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TPrivateServices,
  THooks extends HooksMap = {},
  TServiceThisContext extends RequestThisContext = DatabaseHandlerContext,
  THandlerThisContext extends RequestThisContext = DatabaseHandlerContext,
  TInternalRoutes extends readonly AnyRouteOrFactory[] = readonly [],
> {
  // Store the base builder - we'll replace its storage and context setup when building
  #baseBuilder: FragmentDefinitionBuilder<
    TConfig,
    FragnoPublicConfigWithDatabase,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    DatabaseRequestStorage,
    TInternalRoutes
  >;
  #schema: TSchema;
  #hooksFactory?: (context: HooksFactoryContext<TConfig>) => THooks;
  #syncRegistry?: SyncCommandRegistry;
  #registryResolver?: RegistryResolver;

  constructor(
    baseBuilder: FragmentDefinitionBuilder<
      TConfig,
      FragnoPublicConfigWithDatabase,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      DatabaseRequestStorage,
      TInternalRoutes
    >,
    schema: TSchema,
    hooksFactory?: (context: HooksFactoryContext<TConfig>) => THooks,
    syncRegistry?: SyncCommandRegistry,
    registryResolver?: RegistryResolver,
  ) {
    this.#baseBuilder = baseBuilder;
    this.#schema = schema;
    this.#hooksFactory = hooksFactory;
    this.#syncRegistry = syncRegistry;
    this.#registryResolver = registryResolver;
  }

  /**
   * Define dependencies for this database fragment.
   * The context includes the database adapter.
   */
  withDependencies<TNewDeps>(
    fn: (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
      databaseAdapter: DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    }) => TNewDeps,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TNewDeps & ImplicitDatabaseDependencies<TSchema>,
    {},
    {},
    TServiceDependencies,
    {},
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    // Wrap user function to inject DB context
    const wrappedFn = (context: { config: TConfig; options: FragnoPublicConfigWithDatabase }) => {
      const dbContext = createDatabaseContext(context.options, this.#schema);
      const namespace = resolveDatabaseNamespace(context.options, this.#schema);

      // Call user function with enriched context
      const userDeps = fn({
        config: context.config,
        options: context.options,
        databaseAdapter: dbContext.databaseAdapter,
      });

      // Create implicit dependencies
      const createUow = () => dbContext.db.createUnitOfWork();
      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        databaseAdapter: dbContext.databaseAdapter,
        schema: this.#schema,
        namespace,
        createUnitOfWork: createUow,
      };

      return {
        ...userDeps,
        ...implicitDeps,
      };
    };

    // Create new base builder with wrapped function
    const newBaseBuilder = this.#baseBuilder.withDependencies(wrappedFn);

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    );
  }

  providesBaseService<TNewService>(
    fn: ServiceConstructorFn<
      TConfig,
      FragnoPublicConfigWithDatabase,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TNewService,
      TServiceThisContext
    >,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TNewService,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    const newBaseBuilder = this.#baseBuilder.providesBaseService<TNewService>(fn);

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    );
  }

  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    fn: ServiceConstructorFn<
      TConfig,
      FragnoPublicConfigWithDatabase,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TService,
      TServiceThisContext
    >,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices & { [K in TServiceName]: TService },
    TServiceDependencies,
    TPrivateServices,
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    const newBaseBuilder = this.#baseBuilder.providesService<TServiceName, TService>(
      serviceName,
      fn,
    );

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    );
  }

  /**
   * Provide a private service that is only accessible to the fragment author.
   * Private services are NOT exposed on the fragment instance, but can be used
   * when defining other services (baseServices, namedServices, and other privateServices).
   * Private services are instantiated in order, so earlier private services are available
   * to later ones.
   */
  providesPrivateService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    fn: ServiceConstructorFn<
      TConfig,
      FragnoPublicConfigWithDatabase,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TService,
      TServiceThisContext
    >,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices & { [K in TServiceName]: TService },
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    const newBaseBuilder = this.#baseBuilder.providesPrivateService<TServiceName, TService>(
      serviceName,
      fn,
    );

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    );
  }

  /**
   * Define durable hooks for this fragment.
   * Hooks are automatically persisted and retried on failure.
   *
   * @param fn - Function that receives defineHook helper and returns a hooks map
   * @returns Builder with hooks type set
   *
   * @example
   * ```ts
   * .provideHooks(({ defineHook, config }) => ({
   *   onSubscribe: defineHook(async function (payload: { email: string }) {
   *     // 'this' context available (HookServiceContext with idempotencyKey)
   *     await config.onSubscribe?.(payload.email);
   *   }),
   * }))
   * ```
   */
  provideHooks<TNewHooks extends HooksMap>(
    fn: (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
      deps: TDeps;
      services: BoundServices<TBaseServices & TServices>;
      serviceDeps: TServiceDependencies;
      defineHook: <TPayload>(
        hook: (this: HookContext, payload: TPayload) => void | Promise<void>,
      ) => HookFn<TPayload>;
    }) => TNewHooks,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TNewHooks,
    DatabaseServiceContext<TNewHooks>,
    THandlerThisContext,
    TInternalRoutes
  > {
    const defineHook = <TPayload>(
      hook: (this: HookContext, payload: TPayload) => void | Promise<void>,
    ): HookFn<TPayload> => {
      return hook;
    };

    // Store the hooks factory - it will be called in build() with config/options
    const hooksFactory = (context: HooksFactoryContext<TConfig>) => {
      return fn({
        config: context.config,
        options: context.options,
        deps: context.deps as TDeps,
        services: context.services as BoundServices<TBaseServices & TServices>,
        serviceDeps: context.serviceDeps as TServiceDependencies,
        defineHook,
      });
    };

    // Create new builder with hooks factory stored
    // Cast is safe: we're only changing THooks and TServiceThisContext type parameters
    const newBuilder = new DatabaseFragmentDefinitionBuilder(
      this.#baseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    ) as unknown as DatabaseFragmentDefinitionBuilder<
      TSchema,
      TConfig,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TPrivateServices,
      TNewHooks,
      DatabaseServiceContext<TNewHooks>,
      THandlerThisContext,
      TInternalRoutes
    >;

    newBuilder.#hooksFactory = hooksFactory;

    return newBuilder;
  }

  /**
   * Register sync command definitions for this fragment.
   */
  withSyncCommands(
    registry: SyncCommandRegistry,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    if (registry.schemaName !== this.#schema.name) {
      throw new Error(
        `Sync command registry schema name "${registry.schemaName}" does not match fragment schema "${this.#schema.name}".`,
      );
    }

    return new DatabaseFragmentDefinitionBuilder(
      this.#baseBuilder,
      this.#schema,
      this.#hooksFactory,
      registry,
      this.#registryResolver,
    );
  }

  /**
   * Declare that this fragment uses a required service provided by the runtime.
   * Delegates to the base builder.
   */
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies & { [K in TServiceName]: TService },
    TPrivateServices,
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    const newBaseBuilder = this.#baseBuilder.usesService<TServiceName, TService>(serviceName);

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    );
  }

  /**
   * Declare that this fragment uses an optional service provided by the runtime.
   * Delegates to the base builder.
   */
  usesOptionalService<TServiceName extends string, TService>(
    serviceName: TServiceName,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies & { [K in TServiceName]: TService | undefined },
    TPrivateServices,
    THooks,
    TServiceThisContext,
    THandlerThisContext,
    TInternalRoutes
  > {
    const newBaseBuilder = this.#baseBuilder.usesOptionalService<TServiceName, TService>(
      serviceName,
    );

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#hooksFactory,
      this.#syncRegistry,
      this.#registryResolver,
    );
  }

  /**
   * Build the final database fragment definition.
   * This includes the request context setup for UnitOfWork management.
   * Note: TDeps already includes ImplicitDatabaseDependencies from withDatabase().
   */
  build(): FragmentDefinition<
    TConfig,
    FragnoPublicConfigWithDatabase,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    DatabaseServiceContext<THooks>,
    DatabaseHandlerContext<THooks>,
    DatabaseRequestStorage,
    TInternalRoutes
  > {
    const baseDef = this.#baseBuilder.build();

    // Ensure dependencies callback always exists for database fragments
    // If no user dependencies were defined, create a minimal one that only adds implicit deps
    const dependencies = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }): TDeps => {
      // In dry run mode, allow user deps to fail gracefully.
      // This is critical for database fragments because the CLI needs access to the schema
      // even when user dependencies (like API clients) can't be initialized.
      // Without this, if user deps fail, we'd lose the implicit database dependencies
      // (including schema), and the CLI couldn't extract schema information.
      let userDeps;
      try {
        userDeps = baseDef.dependencies?.(context);
      } catch (error) {
        if (process.env["FRAGNO_INIT_DRY_RUN"] === "true") {
          console.warn(
            "Warning: Failed to initialize user dependencies in dry run mode:",
            error instanceof Error ? error.message : String(error),
          );
          userDeps = {};
        } else {
          throw error;
        }
      }

      const dbContext = createDatabaseContext(context.options, this.#schema);
      const { db } = dbContext;
      const namespace = resolveDatabaseNamespace(context.options, this.#schema);
      const dryRun = process.env["FRAGNO_INIT_DRY_RUN"] === "true";
      const isInternalFragment = baseDef.name === "$fragno-internal-fragment";

      if (!dryRun && !isInternalFragment && this.#registryResolver) {
        const registry = this.#registryResolver.getRegistryForAdapterSync(
          dbContext.databaseAdapter,
        );
        const outboxEnabled = context.options.outbox?.enabled ?? false;
        registry.registerSchema(
          {
            name: this.#schema.name,
            namespace,
            version: this.#schema.version,
            tables: Object.keys(this.#schema.tables).sort(),
          },
          {
            name: baseDef.name,
            mountRoute: resolveMountRoute(baseDef.name, context.options.mountRoute),
          },
          { outboxEnabled },
        );
        if (this.#syncRegistry) {
          registry.registerSyncCommands({
            fragmentName: baseDef.name,
            schemaName: this.#syncRegistry.schemaName,
            namespace,
            commands: this.#syncRegistry.commands,
          });
        }
      }

      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        databaseAdapter: dbContext.databaseAdapter,
        schema: this.#schema,
        namespace,
        createUnitOfWork: () => db.createUnitOfWork(),
      };

      return {
        ...userDeps,
        ...implicitDeps,
      } as TDeps;
    };

    // Use the adapter's shared context storage (all fragments using the same adapter share this storage)
    const builderWithExternalStorage = this.#baseBuilder.withExternalRequestStorage(
      ({ options }) => {
        const dbContext = createDatabaseContext(options, this.#schema);
        return dbContext.databaseAdapter.contextStorage;
      },
    );

    // Set up request storage to initialize the Unit of Work
    const builderWithStorage = builderWithExternalStorage.withRequestStorage(
      ({ options }): DatabaseRequestStorage => {
        // Create database context - needed here to create the UOW
        const dbContextForStorage = createDatabaseContext(options, this.#schema);

        const uow = dbContextForStorage.db.createBaseUnitOfWork();

        return { uow };
      },
    );

    // Cache per instantiated fragment (deps object is unique per instantiation).
    const hooksConfigCache = new WeakMap<object, HookProcessorConfig<THooks>>();

    const createHooksConfig = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
      deps: TDeps;
      services?: BoundServices<TBaseServices & TServices>;
      serviceDeps?: TServiceDependencies;
    }) => {
      if (!this.#hooksFactory) {
        return undefined;
      }
      const depsKey =
        typeof context.deps === "object" && context.deps !== null
          ? (context.deps as object)
          : undefined;
      const cachedHooksConfig = depsKey ? hooksConfigCache.get(depsKey) : undefined;
      if (cachedHooksConfig) {
        if (!cachedHooksConfig.hooks && context.services) {
          cachedHooksConfig.hooks = this.#hooksFactory({
            config: context.config,
            options: context.options,
            deps: context.deps,
            services: context.services,
            serviceDeps: context.serviceDeps ?? ({} as TServiceDependencies),
          });
        }
        return cachedHooksConfig;
      }

      const namespace = resolveDatabaseNamespace(context.options, this.#schema);
      const namespaceKey = namespace ?? this.#schema.name;
      const durableHooksOptions = context.options.durableHooks;
      const baseAdapter = resolveDatabaseAdapter(context.options, this.#schema);
      const hookAdapter = baseAdapter.getHookProcessingAdapter?.() ?? baseAdapter;
      const hookOptions =
        hookAdapter === baseAdapter
          ? context.options
          : { ...context.options, databaseAdapter: hookAdapter };
      const registryResolver = this.#registryResolver;
      if (!registryResolver) {
        throw new Error("Adapter registry resolver is missing for durable hooks.");
      }
      const dbContextForHooks = createDatabaseContext(hookOptions, this.#schema);
      const hookContextStorage = dbContextForHooks.databaseAdapter.contextStorage;
      const hooksConfig: HookProcessorConfig<THooks> = {
        hooks: context.services
          ? this.#hooksFactory({
              config: context.config,
              options: context.options,
              deps: context.deps,
              services: context.services,
              serviceDeps: context.serviceDeps ?? ({} as TServiceDependencies),
            })
          : undefined,
        namespace: namespaceKey,
        internalFragment: registryResolver.getInternalFragment(hookAdapter),
        handlerTx: (execOptions?: Omit<ExecuteTxOptions, "createUnitOfWork">) => {
          const userOnBeforeMutate = execOptions?.onBeforeMutate;
          const userOnAfterMutate = execOptions?.onAfterMutate;
          const planMode = execOptions?.planMode ?? false;
          let storageRef: DatabaseContextStorage | null = null;
          const builder = createHandlerTxBuilder<THooks>({
            ...execOptions,
            createUnitOfWork: () => {
              const baseUow = dbContextForHooks.db.createBaseUnitOfWork();
              baseUow.registerSchema(
                hooksConfig.internalFragment.$internal.deps.schema,
                hooksConfig.internalFragment.$internal.deps.namespace,
              );
              if (storageRef) {
                storageRef.uow = baseUow;
              }
              return baseUow;
            },
            onBeforeMutate: (uow) => {
              if (!planMode) {
                prepareHookMutations(
                  uow,
                  hooksConfig.internalFragment,
                  hooksConfig.defaultRetryPolicy,
                );
              }
              if (userOnBeforeMutate) {
                userOnBeforeMutate(uow);
              }
            },
            onAfterMutate: async (uow) => {
              if (!planMode) {
                void hooksConfig.scheduler?.schedule().catch((error) => {
                  console.error("Durable hooks processing failed", error);
                });
              }
              if (userOnAfterMutate) {
                await userOnAfterMutate(uow);
              }
            },
          });
          const execute = builder.execute.bind(builder);
          builder.execute = () =>
            hookContextStorage.runWithInitializer(
              () => {
                storageRef = { uow: null as unknown as DatabaseContextStorage["uow"] };
                return storageRef;
              },
              () => execute(),
            );
          return builder;
        },
        stuckProcessingTimeoutMinutes: durableHooksOptions?.stuckProcessingTimeoutMinutes,
        onStuckProcessingHooks: durableHooksOptions?.onStuckProcessingHooks,
      };
      hooksConfig.scheduler = createHookScheduler(hooksConfig);
      registerDurableHooksRuntime(hooksConfig);
      if (depsKey) {
        hooksConfigCache.set(depsKey, hooksConfig);
      }
      return hooksConfig;
    };

    const isInternalFragment = baseDef.name === "$fragno-internal-fragment";

    const builderWithContext = builderWithStorage.withThisContext<
      DatabaseServiceContext<THooks>,
      DatabaseHandlerContext<THooks>
    >(({ storage, config, options, deps }) => {
      // Create hooks config if hooks factory is defined
      const hooksConfig = createHooksConfig({ config, options, deps });
      const registryResolver = this.#registryResolver;
      const databaseAdapter =
        (deps as ImplicitDatabaseDependencies<TSchema>).databaseAdapter ??
        resolveDatabaseAdapter(options, this.#schema);
      const internalFragment = isInternalFragment
        ? undefined
        : (hooksConfig?.internalFragment ?? registryResolver?.getInternalFragment(databaseAdapter));

      // Builder API: serviceTx using createServiceTxBuilder
      function serviceTx<TSchema extends AnySchema>(schema: TSchema) {
        const uow = storage.getStore()?.uow;
        if (!uow) {
          throw new Error(
            "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
          );
        }
        return createServiceTxBuilder<TSchema, THooks>(schema, uow, hooksConfig?.hooks);
      }

      const serviceContext: DatabaseServiceContext<THooks> = {
        serviceTx,
      };

      // Builder API: handlerTx using createHandlerTxBuilder
      function handlerTx(execOptions?: Omit<ExecuteTxOptions, "createUnitOfWork">) {
        const currentStorage = storage.getStore();
        if (!currentStorage) {
          throw new Error(
            "No storage in context. Handler must be called within a request context.",
          );
        }

        const userOnBeforeMutate = execOptions?.onBeforeMutate;
        const userOnAfterMutate = execOptions?.onAfterMutate;
        const planMode = execOptions?.planMode ?? false;

        return createHandlerTxBuilder<THooks>({
          ...execOptions,
          createUnitOfWork: () => {
            currentStorage.uow.reset();
            if (internalFragment) {
              currentStorage.uow.registerSchema(
                internalFragment.$internal.deps.schema,
                internalFragment.$internal.deps.namespace,
              );
            }
            return currentStorage.uow;
          },
          onBeforeMutate: (uow) => {
            if (internalFragment && !planMode) {
              prepareHookMutations(uow, internalFragment, hooksConfig?.defaultRetryPolicy);
            }
            if (userOnBeforeMutate) {
              userOnBeforeMutate(uow);
            }
          },
          onAfterMutate: async (uow) => {
            if (hooksConfig?.scheduler && !planMode) {
              void hooksConfig.scheduler.schedule().catch((error) => {
                console.error("Durable hooks processing failed", error);
              });
            }
            if (hooksConfig && !planMode) {
              const runtimeState = getDurableHooksRuntimeByConfig(hooksConfig);
              if (
                runtimeState &&
                !runtimeState.dispatcherRegistered &&
                !runtimeState.dispatcherWarningEmitted
              ) {
                const hasHooks = uow
                  .getTriggeredHooks()
                  .some((hook) => hook.namespace === hooksConfig.namespace);
                if (hasHooks) {
                  runtimeState.dispatcherWarningEmitted = true;
                  console.warn(
                    [
                      "[fragno-db] Durable hooks dispatcher not configured for fragment",
                      `"${hooksConfig.namespace}".`,
                      "Hooks will only run during requests; scheduled/retry hooks may stall.",
                      "Create a dispatcher with createDurableHooksProcessor([...]) from",
                      "`@fragno-dev/db/dispatchers/node` or `@fragno-dev/db/dispatchers/cloudflare-do`.",
                    ].join(" "),
                  );
                }
              }
            }
            if (userOnAfterMutate) {
              await userOnAfterMutate(uow);
            }
          },
        });
      }

      function callServices<
        TServiceCalls extends
          | TxResult<unknown, unknown>
          | undefined
          | readonly (TxResult<unknown, unknown> | undefined)[],
      >(
        serviceCalls: () => TServiceCalls,
      ): Promise<ExtractServiceFinalResultOrSingle<TServiceCalls>> {
        let callWasArray = false;
        const resultPromise = handlerTx()
          .withServiceCalls(() => {
            const calls = serviceCalls();
            callWasArray = Array.isArray(calls);
            return (callWasArray ? calls : [calls]) as readonly (
              | TxResult<unknown, unknown>
              | undefined
            )[];
          })
          .execute();

        return resultPromise.then((result) =>
          callWasArray
            ? (result as ExtractServiceFinalResultOrSingle<TServiceCalls>)
            : (
                result as AwaitedPromisesInObject<
                  ExtractServiceFinalResults<readonly [TServiceCalls]>
                >
              )[0],
        ) as Promise<ExtractServiceFinalResultOrSingle<TServiceCalls>>;
      }

      const handlerContext: DatabaseHandlerContext<THooks> = {
        handlerTx,
        callServices,
      };

      return { serviceContext, handlerContext };
    });

    // Build the final definition
    const finalDef = builderWithContext.build();
    if (this.#hooksFactory) {
      finalDef.internalDataFactory = ({ config, options, deps, services, serviceDeps }) => {
        const hooksConfig = createHooksConfig({
          config: config as TConfig,
          options: options as FragnoPublicConfigWithDatabase,
          deps: deps as TDeps,
          services: services as BoundServices<TBaseServices & TServices>,
          serviceDeps: serviceDeps as TServiceDependencies,
        });
        if (!hooksConfig) {
          return {};
        }
        return {
          durableHooksToken: registerDurableHooksRuntime(hooksConfig),
        };
      };
    }
    if (this.#registryResolver) {
      const registryInternalRoutes = ({ deps }: { deps: TDeps }) => {
        const databaseAdapter = (deps as ImplicitDatabaseDependencies<TSchema>).databaseAdapter;
        if (!databaseAdapter) {
          throw new Error("Database adapter is missing for internal routes.");
        }
        const internalFragment = this.#registryResolver!.getInternalFragment(databaseAdapter);
        if (!internalFragment) {
          return [];
        }
        return (internalFragment.routes ?? []) as readonly AnyFragnoRouteConfig[];
      };
      const mergedInternalRoutes = [
        ...(finalDef.internalRoutes ?? []),
        registryInternalRoutes,
      ] as readonly AnyRouteOrFactory[];
      finalDef.internalRoutes = mergedInternalRoutes as TInternalRoutes;
    }

    // Return the complete definition with proper typing and dependencies
    return {
      ...finalDef,
      dependencies,
    };
  }
}
