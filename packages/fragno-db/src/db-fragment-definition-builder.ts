import type { AnySchema } from "./schema/create";
import type { SimpleQueryInterface } from "./query/simple-query-interface";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { IUnitOfWork } from "./query/unit-of-work/unit-of-work";
import { TypedUnitOfWork, UnitOfWork } from "./query/unit-of-work/unit-of-work";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  AnyFragnoInstantiatedFragment,
} from "@fragno-dev/core";
import {
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceConstructorFn,
} from "@fragno-dev/core";
import {
  executeRestrictedUnitOfWork,
  executeTxArray,
  executeTxCallbacks,
  executeTxWithDeps,
  executeServiceTx,
  executeServiceTxWithDeps,
  createServiceTx,
  executeTx,
  type AwaitedPromisesInObject,
  type ExecuteRestrictedUnitOfWorkOptions,
  type ExecuteTxOptions,
  type LegacyHandlerTxCallbacks,
  type HandlerTxWithDepsCallbacks,
  type LegacyServiceTxCallbacks,
  type ServiceTxResult,
  type TxResult,
  type ServiceTxCallbacksWithSuccessAndMutate,
  type ServiceTxCallbacksWithSuccessNoMutate,
  type ServiceTxCallbacksWithMutateAndRetrieveSuccess,
  type ServiceTxCallbacksWithMutateNoRetrieveSuccess,
  type ServiceTxCallbacksWithMutateOnly,
  type ServiceTxCallbacksWithRetrieveSuccess,
  type ServiceTxCallbacksWithRetrieveOnly,
  type HandlerTxCallbacksWithSuccessMutateDeps,
  type HandlerTxCallbacksWithSuccessMutateNoDeps,
  type HandlerTxCallbacksWithSuccessDepsNoMutate,
  type HandlerTxCallbacksWithSuccessNoDepsNoMutate,
  type HandlerTxCallbacksWithMutate,
  type HandlerTxCallbacksWithRetrieveSuccess,
  type HandlerTxCallbacksWithDepsOnly,
} from "./query/unit-of-work/execute-unit-of-work";
import {
  prepareHookMutations,
  processHooks,
  type HooksMap,
  type HookFn,
  type HookContext,
} from "./hooks/hooks";
import type { InternalFragmentInstance } from "./fragments/internal-fragment";

/**
 * Extended FragnoPublicConfig that includes a database adapter.
 * Use this type when creating fragments with database support.
 */
export type FragnoPublicConfigWithDatabase = FragnoPublicConfig & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter: DatabaseAdapter<any>;
};

/**
 * Implicit dependencies that database fragments get automatically.
 * These are injected without requiring explicit configuration.
 */
export type ImplicitDatabaseDependencies<TSchema extends AnySchema> = {
  /**
   * Database query engine for the fragment's schema.
   */
  db: SimpleQueryInterface<TSchema>;
  /**
   * The schema definition for this fragment.
   */
  schema: TSchema;
  /**
   * The database namespace for this fragment.
   */
  namespace: string;
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
   * Get a typed, restricted Unit of Work for the given schema.
   * @param schema - Schema to get a typed view for
   * @returns TypedUnitOfWork (restricted version without execute methods)
   */
  uow<TSchema extends AnySchema>(schema: TSchema): TypedUnitOfWork<TSchema, [], unknown, THooks>;

  /**
   * Execute a transaction with two-phase callbacks (retrieve + mutate).
   *
   * @param schema - Schema to use for the transaction
   * @param callbacks - Object containing retrieve and mutate callbacks
   * @returns Promise resolving to retrieval results (if no mutate) or mutation result (if mutate provided)
   *
   * @example
   * ```ts
   * // With mutate - returns mutation result
   * return this.tx(schema, {
   *   retrieve: (uow) => uow.findFirst("users", ...),
   *   mutate: async (uow, [user]) => {
   *     await validateUser(user);
   *     uow.update("users", user.id, ...).check();
   *     return { ok: true };
   *   }
   * });
   *
   * // Without mutate - returns retrieval results
   * const [user] = await this.tx(schema, {
   *   retrieve: (uow) => uow.findFirst("users", ...),
   * });
   * ```
   */
  // Overload 1: with mutate callback - returns mutation result
  tx<TSchema extends AnySchema, TRetrievalResults extends unknown[], TMutationResult>(
    schema: TSchema,
    callbacks: {
      retrieve?: (
        uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
      ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
      mutate: (
        uow: TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>,
        results: TRetrievalResults,
      ) => TMutationResult | Promise<TMutationResult>;
    },
  ): ServiceTxResult<AwaitedPromisesInObject<TMutationResult>>;
  // Overload 2: without mutate callback - returns retrieval results
  tx<TSchema extends AnySchema, TRetrievalResults extends unknown[]>(
    schema: TSchema,
    callbacks: {
      retrieve: (
        uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
      ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
      mutate?: undefined;
    },
  ): ServiceTxResult<TRetrievalResults>;
  // Overload 3: Dependencies + mutation syntax (service-to-service composition)
  // Call other services as dependencies, then use their results in mutate
  tx<TDeps extends readonly unknown[], TMutationResult>(
    depsFactory: () => readonly [
      ...{ [K in keyof TDeps]: ServiceTxResult<TDeps[K]> | PromiseLike<TDeps[K]> },
    ],
    callbacks: HandlerTxWithDepsCallbacks<TDeps, TMutationResult, THooks>,
  ): ServiceTxResult<AwaitedPromisesInObject<TMutationResult>>;

  /**
   * Create a service-level transaction using the unified TxResult API.
   * Returns a TxResult that can be composed with other service calls.
   *
   * @example
   * ```ts
   * // Simple retrieve + transform
   * return this.serviceTx(schema, {
   *   retrieve: (uow) => uow.find("users", ...),
   *   retrieveSuccess: ([users]) => users[0] ?? null,
   * });
   *
   * // With deps (service composition)
   * return this.serviceTx(schema, {
   *   deps: () => [otherService.getData()],
   *   mutate: ({ uow, depsRetrieveResult: [data] }) => {
   *     return uow.create("records", { data });
   *   },
   * });
   * ```
   */
  // Overload 1a: With success AND mutate - returns TSuccessResult, mutateResult is NOT undefined
  serviceTx<
    TSchema extends AnySchema,
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TMutateResult,
    TSuccessResult,
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithSuccessAndMutate<
      TSchema,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      TMutateResult,
      TSuccessResult,
      THooks
    >,
  ): TxResult<TSuccessResult, TRetrieveSuccessResult>;
  // Overload 1b: With success but NO mutate - returns TSuccessResult, mutateResult IS undefined
  serviceTx<
    TSchema extends AnySchema,
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TSuccessResult,
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithSuccessNoMutate<
      TSchema,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      TSuccessResult,
      THooks
    >,
  ): TxResult<TSuccessResult, TRetrieveSuccessResult>;
  // Overload 2a: With mutate AND retrieveSuccess but no success - returns TMutateResult
  serviceTx<
    TSchema extends AnySchema,
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TMutateResult,
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithMutateAndRetrieveSuccess<
      TSchema,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      TMutateResult,
      THooks
    >,
  ): TxResult<TMutateResult, TRetrieveSuccessResult>;
  // Overload 2b: With mutate only (no retrieve/retrieveSuccess) - returns TMutateResult
  serviceTx<
    TSchema extends AnySchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TMutateResult,
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithMutateOnly<TSchema, TDeps, TMutateResult, THooks>,
  ): TxResult<TMutateResult, TMutateResult>;
  // Overload 2c: With mutate and retrieve but NO retrieveSuccess (and no success) - returns TMutateResult
  // retrieveResult in mutate is TRetrieveResults (raw array)
  serviceTx<
    TSchema extends AnySchema,
    TRetrieveResults extends unknown[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TMutateResult,
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithMutateNoRetrieveSuccess<
      TSchema,
      TRetrieveResults,
      TDeps,
      TMutateResult,
      THooks
    >,
  ): TxResult<TMutateResult, TRetrieveResults>;
  // Overload 3: With retrieveSuccess but no mutate/success - returns TRetrieveSuccessResult
  serviceTx<
    TSchema extends AnySchema,
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithRetrieveSuccess<
      TSchema,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      THooks
    >,
  ): TxResult<TRetrieveSuccessResult, TRetrieveSuccessResult>;
  // Overload 4: With retrieve only - returns TRetrieveResults
  serviceTx<
    TSchema extends AnySchema,
    TRetrieveResults extends unknown[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
  >(
    schema: TSchema,
    callbacks: ServiceTxCallbacksWithRetrieveOnly<TSchema, TRetrieveResults, TDeps, THooks>,
  ): TxResult<TRetrieveResults, TRetrieveResults>;
};

/**
 * Handler context for database fragments - provides UOW execution with automatic retry support.
 */
export type DatabaseHandlerContext<THooks extends HooksMap = {}> = RequestThisContext & {
  /**
   * Execute a Unit of Work with explicit phase control and automatic retry support.
   * This method provides an API where users call forSchema to create a schema-specific
   * UOW, then call executeRetrieve() and executeMutate() to execute the phases. The entire
   * callback is re-executed on optimistic concurrency conflicts, ensuring retries work properly.
   * Automatically provides the UOW factory from context.
   * Promises in the returned object are awaited 1 level deep.
   *
   * @param callback - Async function that receives a context with forSchema, executeRetrieve, executeMutate, nonce, and currentAttempt
   * @param options - Optional configuration for retry policy and abort signal
   * @returns Promise resolving to the callback's return value with promises awaited 1 level deep
   * @throws Error if retries are exhausted or callback throws an error
   *
   * @example
   * ```ts
   * const result = await this.uow(async ({ forSchema, executeRetrieve, executeMutate, nonce, currentAttempt }) => {
   *   const uow = forSchema(schema);
   *   const userId = uow.create("users", { name: "John" });
   *
   *   // Execute retrieval phase
   *   await executeRetrieve();
   *
   *   const profileId = uow.create("profiles", { userId });
   *
   *   // Execute mutation phase
   *   await executeMutate();
   *
   *   return { userId, profileId };
   * });
   * ```
   */
  uow<TResult>(
    callback: (context: {
      forSchema: <TSchema extends AnySchema, H extends HooksMap = THooks>(
        schema: TSchema,
        hooks?: H,
      ) => TypedUnitOfWork<TSchema, [], unknown, H>;
      executeRetrieve: () => Promise<void>;
      executeMutate: () => Promise<void>;
      nonce: string;
      currentAttempt: number;
    }) => Promise<TResult> | TResult,
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TResult>>;

  /**
   * Execute a transaction with automatic retry support.
   * Provides two overloads: array syntax (common case) and callback syntax (advanced).
   *
   * Array syntax - pass a factory function that returns service calls:
   * ```ts
   * const [transfer, notify] = await this.tx(
   *   () => [
   *     services.transfer({ from, to, amount }),
   *     services.notify({ userId, message })
   *   ]
   * );
   * ```
   *
   * Callback syntax - for handlers that need direct UOW access:
   * ```ts
   * const result = await this.tx({
   *   retrieve: ({ forSchema }) => {
   *     const uow = forSchema(schema);
   *     uow.find("users", ...);
   *     return services.transfer({ ... });
   *   },
   *   mutate: ({ forSchema }, transferPromise) => {
   *     const uow = forSchema(schema);
   *     uow.create("auditLog", { ... });
   *     return transferPromise;
   *   }
   * });
   * ```
   *
   * Note: Handler callbacks are synchronous only to prevent accidentally awaiting services in wrong place.
   */
  // Overload 1: Array syntax (common case) - accepts a factory
  tx<T extends readonly unknown[]>(
    servicesFactory: () => readonly [...{ [K in keyof T]: Promise<T[K]> }],
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<{ [K in keyof T]: T[K] }>;
  // Overload 2: Callback syntax (advanced, sync callbacks only)
  tx<TSchema extends AnySchema, TRetrievalResults extends unknown[], TMutationResult>(
    callbacks: LegacyHandlerTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>,
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TMutationResult>>;
  // Overload 3: Dependencies + mutation syntax (service-to-service composition)
  tx<TDeps extends readonly unknown[], TMutationResult>(
    depsFactory: () => readonly [
      ...{ [K in keyof TDeps]: ServiceTxResult<TDeps[K]> | PromiseLike<TDeps[K]> },
    ],
    callbacks: HandlerTxWithDepsCallbacks<TDeps, TMutationResult, THooks>,
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TMutationResult>>;

  /**
   * Execute a handler-level transaction using the unified TxResult API.
   * Supports multiple callback configurations with proper type inference.
   *
   * @example
   * ```ts
   * // Simple deps-only - execute service calls
   * const [user, orders] = await this.handlerTx({
   *   deps: () => [userService.getUser(id), orderService.getOrders(id)],
   * });
   *
   * // With success callback
   * const result = await this.handlerTx({
   *   deps: () => [userService.getUser(id)],
   *   mutate: ({ forSchema, depsRetrieveResult: [user] }) => {
   *     return forSchema(ordersSchema).create("orders", { userId: user.id });
   *   },
   *   success: ({ mutateResult, depsResult: [user] }) => ({
   *     orderId: mutateResult,
   *     userName: user.name,
   *   }),
   * });
   * ```
   */
  // Overload 1a: With success, mutate, AND deps
  handlerTx<
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TMutateResult,
    TSuccessResult,
  >(
    callbacks: HandlerTxCallbacksWithSuccessMutateDeps<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      TMutateResult,
      TSuccessResult,
      THooks
    >,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TSuccessResult>>;
  // Overload 1b: With success AND mutate, but NO deps
  handlerTx<
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    TMutateResult,
    TSuccessResult,
  >(
    callbacks: HandlerTxCallbacksWithSuccessMutateNoDeps<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TMutateResult,
      TSuccessResult,
      THooks
    >,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TSuccessResult>>;
  // Overload 1c: With success AND deps, but NO mutate
  handlerTx<
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TSuccessResult,
  >(
    callbacks: HandlerTxCallbacksWithSuccessDepsNoMutate<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      TSuccessResult,
      THooks
    >,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TSuccessResult>>;
  // Overload 1d: With success but NO deps and NO mutate
  handlerTx<TRetrieveResults extends unknown[], TRetrieveSuccessResult, TSuccessResult>(
    callbacks: HandlerTxCallbacksWithSuccessNoDepsNoMutate<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TSuccessResult,
      THooks
    >,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TSuccessResult>>;
  // Overload 2: With mutate but no success
  handlerTx<
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
    TMutateResult,
  >(
    callbacks: HandlerTxCallbacksWithMutate<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      TMutateResult,
      THooks
    >,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TMutateResult>>;
  // Overload 3: With retrieveSuccess but no mutate/success
  handlerTx<
    TRetrieveResults extends unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TDeps extends readonly (TxResult<any, any> | undefined)[],
  >(
    callbacks: HandlerTxCallbacksWithRetrieveSuccess<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TDeps,
      THooks
    >,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<TRetrieveSuccessResult>;
  // Overload 4: With deps only
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlerTx<TDeps extends readonly (TxResult<any, any> | undefined)[]>(
    callbacks: HandlerTxCallbacksWithDepsOnly<TDeps>,
    options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<{ [K in keyof TDeps]: Awaited<TDeps[K]> }>>;
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
  namespace: string,
): DatabaseFragmentContext<TSchema> {
  const databaseAdapter = options.databaseAdapter;

  if (!databaseAdapter) {
    throw new Error(
      "Database fragment requires a database adapter to be provided in options.databaseAdapter",
    );
  }

  const db = databaseAdapter.createQueryEngine(schema, namespace);

  return { databaseAdapter, db };
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
 * Database fragments always require FragnoPublicConfigWithDatabase (which includes databaseAdapter).
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
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment> = {},
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
    TLinkedFragments
  >;
  #schema: TSchema;
  #namespace: string;
  #hooksFactory?: (context: { config: TConfig; options: FragnoPublicConfigWithDatabase }) => THooks;

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
      TLinkedFragments
    >,
    schema: TSchema,
    namespace?: string,
    hooksFactory?: (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }) => THooks,
  ) {
    this.#baseBuilder = baseBuilder;
    this.#schema = schema;
    this.#namespace = namespace ?? baseBuilder.name;
    this.#hooksFactory = hooksFactory;
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
    TLinkedFragments
  > {
    // Wrap user function to inject DB context
    const wrappedFn = (context: { config: TConfig; options: FragnoPublicConfigWithDatabase }) => {
      const dbContext = createDatabaseContext(context.options, this.#schema, this.#namespace);

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
        db: dbContext.db,
        schema: this.#schema,
        namespace: this.#namespace,
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
      this.#namespace,
      this.#hooksFactory,
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
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.providesBaseService<TNewService>(fn);

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#namespace,
      this.#hooksFactory,
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
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.providesService<TServiceName, TService>(
      serviceName,
      fn,
    );

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#namespace,
      this.#hooksFactory,
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
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.providesPrivateService<TServiceName, TService>(
      serviceName,
      fn,
    );

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#namespace,
      this.#hooksFactory,
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
   *     // 'this' context available (HookServiceContext with nonce)
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
    TLinkedFragments
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
      this.#namespace,
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
      TLinkedFragments
    >;

    newBuilder.#hooksFactory = hooksFactory;

    return newBuilder;
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
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.usesService<TServiceName, TService>(serviceName);

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#namespace,
      this.#hooksFactory,
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
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.usesOptionalService<TServiceName, TService>(
      serviceName,
    );

    return new DatabaseFragmentDefinitionBuilder(
      newBaseBuilder,
      this.#schema,
      this.#namespace,
      this.#hooksFactory,
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
    TLinkedFragments
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

      const { db } = createDatabaseContext(context.options, this.#schema, this.#namespace);

      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        db,
        schema: this.#schema,
        namespace: this.#namespace,
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
        const dbContext = createDatabaseContext(options, this.#schema, this.#namespace);
        return dbContext.databaseAdapter.contextStorage;
      },
    );

    // Set up request storage to initialize the Unit of Work
    const builderWithStorage = builderWithExternalStorage.withRequestStorage(
      ({ options }): DatabaseRequestStorage => {
        // Create database context - needed here to create the UOW
        const dbContextForStorage = createDatabaseContext(options, this.#schema, this.#namespace);

        // Create a new Unit of Work for this request
        const uow: IUnitOfWork = dbContextForStorage.db.createUnitOfWork();

        return { uow };
      },
    );

    // Get the internal fragment factory from linked fragments (added by withDatabase)
    // Cast is safe: withDatabase() guarantees this fragment exists and has the correct type
    const internalFragmentFactory = baseDef.linkedFragments?.["_fragno_internal"] as (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }) => InternalFragmentInstance;

    const builderWithContext = builderWithStorage.withThisContext<
      DatabaseServiceContext<THooks>,
      DatabaseHandlerContext<THooks>
    >(({ storage, config, options }) => {
      // Create hooks config if hooks factory is defined
      const hooksConfig = this.#hooksFactory
        ? {
            hooks: this.#hooksFactory({ config, options }),
            namespace: this.#namespace,
            internalFragment: internalFragmentFactory({ config, options }),
          }
        : undefined;

      function forSchema<TSchema extends AnySchema>(
        schema: TSchema,
      ): TypedUnitOfWork<TSchema, [], unknown, THooks> {
        const uow = storage.getStore()?.uow;
        if (!uow) {
          throw new Error(
            "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
          );
        }

        return uow.restrict().forSchema<TSchema, THooks>(schema);
      }

      // Overload 1: with mutate callback - returns mutation result
      function serviceTx<
        TSchema extends AnySchema,
        TRetrievalResults extends unknown[],
        TMutationResult,
      >(
        schema: TSchema,
        callbacks: {
          retrieve?: (
            uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
          ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
          mutate: (
            uow: TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>,
            results: TRetrievalResults,
          ) => TMutationResult | Promise<TMutationResult>;
        },
      ): ServiceTxResult<AwaitedPromisesInObject<TMutationResult>>;
      // Overload 2: without mutate callback - returns retrieval results
      function serviceTx<TSchema extends AnySchema, TRetrievalResults extends unknown[]>(
        schema: TSchema,
        callbacks: {
          retrieve: (
            uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
          ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
          mutate?: undefined;
        },
      ): ServiceTxResult<TRetrievalResults>;
      // Overload 3: Dependencies + mutation syntax (service-to-service composition)
      function serviceTx<TDeps extends readonly unknown[], TMutationResult>(
        depsFactory: () => readonly [
          ...{ [K in keyof TDeps]: ServiceTxResult<TDeps[K]> | PromiseLike<TDeps[K]> },
        ],
        callbacks: HandlerTxWithDepsCallbacks<TDeps, TMutationResult, THooks>,
      ): ServiceTxResult<AwaitedPromisesInObject<TMutationResult>>;
      // Implementation
      function serviceTx<
        TSchema extends AnySchema,
        TDeps extends readonly unknown[],
        TRetrievalResults extends unknown[],
        TMutationResult = void,
      >(
        schemaOrDepsFactory:
          | TSchema
          | (() => readonly [
              ...{ [K in keyof TDeps]: ServiceTxResult<TDeps[K]> | PromiseLike<TDeps[K]> },
            ]),
        callbacks:
          | LegacyServiceTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>
          | HandlerTxWithDepsCallbacks<TDeps, TMutationResult, THooks>,
      ): ServiceTxResult<AwaitedPromisesInObject<TMutationResult> | TRetrievalResults> {
        const uow = storage.getStore()?.uow;
        if (!uow) {
          throw new Error(
            "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
          );
        }

        // Check if using deps pattern (first arg is a function, not a schema)
        if (typeof schemaOrDepsFactory === "function") {
          // Deps pattern: schemaOrDepsFactory is a factory function
          // Type assertion needed: internal implementation extracts retrievalResult from ServiceTxResult
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return executeServiceTxWithDeps(schemaOrDepsFactory, callbacks as any, uow) as any;
        }

        // Schema pattern: schemaOrDepsFactory is a schema
        // Type assertion: overloads handle correct return type based on callbacks shape
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return executeServiceTx(schemaOrDepsFactory, callbacks as any, uow) as any;
      }

      // New unified API: serviceTx using createServiceTx
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function newServiceTx(schema: AnySchema, callbacks: any): TxResult<any, any> {
        const uow = storage.getStore()?.uow;
        if (!uow) {
          throw new Error(
            "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
          );
        }
        return createServiceTx(schema, callbacks, uow);
      }

      const serviceContext: DatabaseServiceContext<THooks> = {
        uow: forSchema,
        tx: serviceTx,
        serviceTx: newServiceTx,
      };

      async function uow<TResult>(
        callback: (context: {
          forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
            schema: S,
            hooks?: H,
          ) => TypedUnitOfWork<S, [], unknown, H>;
          executeRetrieve: () => Promise<void>;
          executeMutate: () => Promise<void>;
          nonce: string;
          currentAttempt: number;
        }) => Promise<TResult> | TResult,
        execOptions?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
      ): Promise<AwaitedPromisesInObject<TResult>> {
        const currentStorage = storage.getStore();
        if (!currentStorage) {
          throw new Error(
            "No storage in context. Handler must be called within a request context.",
          );
        }

        const wrappedCallback = async (context: {
          forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
            schema: S,
            hooks?: H,
          ) => TypedUnitOfWork<S, [], unknown, H>;
          executeRetrieve: () => Promise<void>;
          executeMutate: () => Promise<void>;
          nonce: string;
          currentAttempt: number;
        }): Promise<TResult> => {
          return callback(context);
        };

        const userOnBeforeMutate = execOptions?.onBeforeMutate;
        const userOnSuccess = execOptions?.onSuccess;

        return executeRestrictedUnitOfWork(wrappedCallback, {
          ...execOptions,
          createUnitOfWork: () => {
            currentStorage.uow.reset();
            if (hooksConfig) {
              currentStorage.uow.registerSchema(
                hooksConfig.internalFragment.$internal.deps.schema,
                hooksConfig.internalFragment.$internal.deps.namespace,
              );
            }
            // Safe cast: currentStorage.uow is always a UnitOfWork instance
            return currentStorage.uow as UnitOfWork;
          },
          onBeforeMutate: (uow) => {
            if (hooksConfig) {
              prepareHookMutations(uow, hooksConfig);
            }
            if (userOnBeforeMutate) {
              userOnBeforeMutate(uow);
            }
          },
          onSuccess: async (uow) => {
            if (hooksConfig) {
              await processHooks(hooksConfig);
            }
            if (userOnSuccess) {
              await userOnSuccess(uow);
            }
          },
        });
      }

      // Handler tx method with three overloads
      // Overload 1: Array syntax (common case)
      function handlerTx<T extends readonly unknown[]>(
        servicesFactory: () => readonly [...{ [K in keyof T]: Promise<T[K]> }],
        execOptions?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
      ): Promise<{ [K in keyof T]: T[K] }>;
      // Overload 2: Callback syntax (advanced, sync callbacks only)
      function handlerTx<
        TSchema extends AnySchema,
        TRetrievalResults extends unknown[],
        TMutationResult,
      >(
        callbacks: LegacyHandlerTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>,
        execOptions?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
      ): Promise<AwaitedPromisesInObject<TMutationResult>>;
      // Overload 3: Dependencies + mutation syntax (service-to-service composition)
      function handlerTx<TDeps extends readonly unknown[], TMutationResult>(
        depsFactory: () => readonly [...{ [K in keyof TDeps]: Promise<TDeps[K]> }],
        callbacks: HandlerTxWithDepsCallbacks<TDeps, TMutationResult, THooks>,
        execOptions?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
      ): Promise<AwaitedPromisesInObject<TMutationResult>>;
      // Implementation
      async function handlerTx<
        T extends readonly unknown[],
        TDeps extends readonly unknown[],
        TSchema extends AnySchema,
        TRetrievalResults extends unknown[],
        TMutationResult,
      >(
        factoryOrCallbacks:
          | (() => readonly [...{ [K in keyof T]: Promise<T[K]> }])
          | LegacyHandlerTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>,
        callbacksOrOptions?:
          | HandlerTxWithDepsCallbacks<TDeps, TMutationResult, THooks>
          | Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
        execOptions?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
      ): Promise<{ [K in keyof T]: T[K] } | AwaitedPromisesInObject<TMutationResult>> {
        const currentStorage = storage.getStore();
        if (!currentStorage) {
          throw new Error(
            "No storage in context. Handler must be called within a request context.",
          );
        }

        // Determine which overload was used
        const isThreeArgOverload =
          typeof factoryOrCallbacks === "function" &&
          callbacksOrOptions !== undefined &&
          typeof callbacksOrOptions === "object" &&
          "mutate" in callbacksOrOptions;

        const resolvedExecOptions = isThreeArgOverload
          ? execOptions
          : (callbacksOrOptions as
              | Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">
              | undefined);

        const userOnBeforeMutate = resolvedExecOptions?.onBeforeMutate;
        const userOnSuccess = resolvedExecOptions?.onSuccess;

        const createUow = () => {
          currentStorage.uow.reset();

          if (hooksConfig) {
            currentStorage.uow.registerSchema(
              hooksConfig.internalFragment.$internal.deps.schema,
              hooksConfig.internalFragment.$internal.deps.namespace,
            );
          }
          // Safe cast: currentStorage.uow is always a UnitOfWork instance
          return currentStorage.uow as UnitOfWork;
        };

        const options: ExecuteRestrictedUnitOfWorkOptions = {
          ...resolvedExecOptions,
          createUnitOfWork: createUow,
          onBeforeMutate: (uow) => {
            if (hooksConfig) {
              prepareHookMutations(uow, hooksConfig);
            }
            if (userOnBeforeMutate) {
              userOnBeforeMutate(uow);
            }
          },
          onSuccess: async (uow) => {
            if (hooksConfig) {
              await processHooks(hooksConfig);
            }
            if (userOnSuccess) {
              await userOnSuccess(uow);
            }
          },
        };

        // Check which overload was used
        if (isThreeArgOverload) {
          // Overload 3: Dependencies + mutation syntax
          // Type assertion needed: internal implementation extracts retrievalResult from ServiceTxResult
          return executeTxWithDeps(
            factoryOrCallbacks,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callbacksOrOptions as any,
            options,
          ) as unknown as ServiceTxResult<AwaitedPromisesInObject<TMutationResult>>;
        } else if (typeof factoryOrCallbacks === "function") {
          // Overload 1: Array syntax
          return executeTxArray(
            factoryOrCallbacks as () => readonly [...{ [K in keyof T]: Promise<T[K]> }],
            options,
          ) as Promise<{ [K in keyof T]: T[K] }>;
        } else {
          // Overload 2: Callback syntax
          return executeTxCallbacks(
            factoryOrCallbacks as LegacyHandlerTxCallbacks<
              TSchema,
              TRetrievalResults,
              TMutationResult,
              THooks
            >,
            options,
          );
        }
      }

      // New unified API: handlerTx using executeTx
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function newHandlerTx(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks: any,
        execOptions?: Omit<ExecuteTxOptions, "createUnitOfWork">,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): Promise<any> {
        const currentStorage = storage.getStore();
        if (!currentStorage) {
          throw new Error(
            "No storage in context. Handler must be called within a request context.",
          );
        }

        const userOnBeforeMutate = execOptions?.onBeforeMutate;
        const userOnAfterMutate = execOptions?.onAfterMutate;

        return executeTx(callbacks, {
          ...execOptions,
          createUnitOfWork: () => {
            currentStorage.uow.reset();
            if (hooksConfig) {
              currentStorage.uow.registerSchema(
                hooksConfig.internalFragment.$internal.deps.schema,
                hooksConfig.internalFragment.$internal.deps.namespace,
              );
            }
            // Safe cast: currentStorage.uow is always a UnitOfWork instance
            return currentStorage.uow as UnitOfWork;
          },
          onBeforeMutate: (uow) => {
            if (hooksConfig) {
              prepareHookMutations(uow, hooksConfig);
            }
            if (userOnBeforeMutate) {
              userOnBeforeMutate(uow);
            }
          },
          onAfterMutate: async (uow) => {
            if (hooksConfig) {
              await processHooks(hooksConfig);
            }
            if (userOnAfterMutate) {
              await userOnAfterMutate(uow);
            }
          },
        });
      }

      const handlerContext: DatabaseHandlerContext<THooks> = {
        uow,
        tx: handlerTx,
        handlerTx: newHandlerTx,
      };

      return { serviceContext, handlerContext };
    });

    // Build the final definition
    const finalDef = builderWithContext.build();

    // Return the complete definition with proper typing and dependencies
    return {
      ...finalDef,
      dependencies,
    };
  }
}
