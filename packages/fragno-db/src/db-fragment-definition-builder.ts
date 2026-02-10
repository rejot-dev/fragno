import type { AnySchema } from "./schema/create";
import type { SimpleQueryInterface } from "./query/simple-query-interface";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { IUnitOfWork } from "./query/unit-of-work/unit-of-work";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  AnyRouteOrFactory,
  FragnoRouteConfig,
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
  type ExecuteTxOptions,
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
   * Database query engine for the fragment's schema.
   * @deprecated Prefer handlerTx/serviceTx instead of direct db usage.
   */
  db: SimpleQueryInterface<TSchema>;
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
};

/**
 * Database fragment context provided to user callbacks.
 */
export type DatabaseFragmentContext<TSchema extends AnySchema> = {
  /**
   * Database adapter instance.
   */
  databaseAdapter: DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * ORM query engine for the fragment's schema.
   */
  db: SimpleQueryInterface<TSchema>;
};

/**
 * Create database context from options.
 * This extracts the database adapter and creates the ORM instance.
 */
function createDatabaseContext<TSchema extends AnySchema>(
  options: FragnoPublicConfigWithDatabase,
  schema: TSchema,
): DatabaseFragmentContext<TSchema> {
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
  #hooksFactory?: (context: { config: TConfig; options: FragnoPublicConfigWithDatabase }) => THooks;
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
    hooksFactory?: (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }) => THooks,
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
   * The context includes database adapter and ORM instance.
   */
  withDependencies<TNewDeps>(
    fn: (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
      db: SimpleQueryInterface<TSchema>;
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
        db: dbContext.db,
        databaseAdapter: dbContext.databaseAdapter,
      });

      // Create implicit dependencies
      const createUow = () => dbContext.db.createUnitOfWork();
      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        databaseAdapter: dbContext.databaseAdapter,
        db: dbContext.db,
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
    const hooksFactory = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }) => {
      return fn({
        config: context.config,
        options: context.options,
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
        db,
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

        // Create a new Unit of Work for this request
        const uow: IUnitOfWork = dbContextForStorage.db.createUnitOfWork();

        return { uow };
      },
    );

    // Cache per instantiated fragment (deps object is unique per instantiation).
    const hooksConfigCache = new WeakMap<object, HookProcessorConfig<THooks>>();

    const createHooksConfig = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
      deps: TDeps;
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
      const hooksConfig: HookProcessorConfig<THooks> = {
        hooks: this.#hooksFactory(context),
        namespace: namespaceKey,
        internalFragment: registryResolver.getInternalFragment(hookAdapter),
        handlerTx: (execOptions?: Omit<ExecuteTxOptions, "createUnitOfWork">) => {
          const userOnBeforeMutate = execOptions?.onBeforeMutate;
          const userOnAfterMutate = execOptions?.onAfterMutate;
          const planMode = execOptions?.planMode ?? false;
          return createHandlerTxBuilder<THooks>({
            ...execOptions,
            createUnitOfWork: () => {
              const uow = dbContextForHooks.db.createUnitOfWork();
              uow.registerSchema(
                hooksConfig.internalFragment.$internal.deps.schema,
                hooksConfig.internalFragment.$internal.deps.namespace,
              );
              return uow;
            },
            onBeforeMutate: (uow) => {
              if (!planMode) {
                prepareHookMutations(uow, hooksConfig);
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
        },
        stuckProcessingTimeoutMinutes: durableHooksOptions?.stuckProcessingTimeoutMinutes,
        onStuckProcessingHooks: durableHooksOptions?.onStuckProcessingHooks,
      };
      hooksConfig.scheduler = createHookScheduler(hooksConfig);
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
            if (hooksConfig && !planMode) {
              prepareHookMutations(uow, hooksConfig);
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
            if (userOnAfterMutate) {
              await userOnAfterMutate(uow);
            }
          },
        });
      }

      const handlerContext: DatabaseHandlerContext<THooks> = {
        handlerTx,
      };

      return { serviceContext, handlerContext };
    });

    // Build the final definition
    const finalDef = builderWithContext.build();
    if (this.#hooksFactory) {
      finalDef.internalDataFactory = ({ config, options, deps }) => ({
        durableHooks: createHooksConfig({
          config: config as TConfig,
          options: options as FragnoPublicConfigWithDatabase,
          deps: deps as TDeps,
        }),
      });
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
