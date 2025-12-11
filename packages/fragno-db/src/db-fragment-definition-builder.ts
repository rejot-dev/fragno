import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { IUnitOfWork } from "./query/unit-of-work";
import { TypedUnitOfWork, UnitOfWork } from "./query/unit-of-work";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  AnyFragnoInstantiatedFragment,
  ServiceContext,
} from "@fragno-dev/core";
import {
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceConstructorFn,
} from "@fragno-dev/core";
import {
  executeRestrictedUnitOfWork,
  type AwaitedPromisesInObject,
  type ExecuteRestrictedUnitOfWorkOptions,
} from "./query/execute-unit-of-work";
import {
  databaseFragnoInstantiatedFragmentCreator,
  type DatabaseFragnoInstantiatedFragment,
} from "./db-fragment-instantiator";
import type { AnyFragnoRouteConfig } from "@fragno-dev/core/route";

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
  db: AbstractQuery<TSchema>;
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
 * Implicit base service that database fragments get automatically.
 * This provides a UOW execution method directly on the fragment instance.
 */
export type ImplicitDatabaseBaseService = {
  uow<TResult>(
    callback: (context: {
      forSchema: <S extends AnySchema>(schema: S) => TypedUnitOfWork<S, [], unknown>;
      executeRetrieve: () => Promise<void>;
      executeMutate: () => Promise<void>;
      nonce: string;
      currentAttempt: number;
    }) => Promise<TResult> | TResult,
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TResult>>;
};

/**
 * Service context for database fragments - provides restricted UOW access without execute methods.
 */
export type DatabaseServiceContext = RequestThisContext & {
  /**
   * Get a typed, restricted Unit of Work for the given schema.
   * @param schema - Schema to get a typed view for
   * @returns TypedUnitOfWork (restricted version without execute methods)
   */
  uow<TSchema extends AnySchema>(schema: TSchema): TypedUnitOfWork<TSchema, [], unknown>;
};

/**
 * Handler context for database fragments - provides UOW execution with automatic retry support.
 */
export type DatabaseHandlerContext = RequestThisContext & {
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
      forSchema: <S extends AnySchema>(schema: S) => TypedUnitOfWork<S, [], unknown>;
      executeRetrieve: () => Promise<void>;
      executeMutate: () => Promise<void>;
      nonce: string;
      currentAttempt: number;
    }) => Promise<TResult> | TResult,
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TResult>>;
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
  db: AbstractQuery<TSchema>;
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
  TServices extends Record<string, unknown>,
  TServiceDependencies,
  TPrivateServices,
  TServiceThisContext extends DatabaseServiceContext = DatabaseServiceContext,
  THandlerThisContext extends DatabaseHandlerContext = DatabaseHandlerContext,
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

  #databaseDependencies?: ImplicitDatabaseDependencies<TSchema>;

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
  ) {
    this.#baseBuilder = baseBuilder;
    this.#schema = schema;
    this.#namespace = namespace ?? baseBuilder.name;
  }

  #setDatabaseDependencies(dependencies: ImplicitDatabaseDependencies<TSchema>): void {
    this.#databaseDependencies = dependencies;
  }

  get databaseDependencies(): ImplicitDatabaseDependencies<TSchema> {
    if (!this.#databaseDependencies) {
      throw new Error("Database dependencies not set");
    }

    return this.#databaseDependencies;
  }

  /**
   * Create the uow function that provides UOW execution with retry support.
   * This is centralized so it can be reused in both base services and handler context.
   */
  #createUowFunction(storage: { getStore: () => DatabaseRequestStorage | undefined }) {
    return async <TResult>(
      callback: (context: {
        forSchema: <S extends AnySchema>(schema: S) => TypedUnitOfWork<S, [], unknown>;
        executeRetrieve: () => Promise<void>;
        executeMutate: () => Promise<void>;
        nonce: string;
        currentAttempt: number;
      }) => Promise<TResult> | TResult,
      options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
    ): Promise<AwaitedPromisesInObject<TResult>> => {
      const currentStorage = storage.getStore();
      if (!currentStorage) {
        throw new Error("No storage in context. Handler must be called within a request context.");
      }

      // Wrap callback to ensure it always returns a Promise
      const wrappedCallback = async (context: {
        forSchema: <S extends AnySchema>(schema: S) => TypedUnitOfWork<S, [], unknown>;
        executeRetrieve: () => Promise<void>;
        executeMutate: () => Promise<void>;
        nonce: string;
        currentAttempt: number;
      }): Promise<TResult> => {
        return await callback(context);
      };

      // Use the UOW from storage - reset it before each attempt for retry support
      // Cast is safe because IUnitOfWork is actually implemented by UnitOfWork
      return executeRestrictedUnitOfWork(wrappedCallback, {
        ...options,
        createUnitOfWork: () => {
          currentStorage.uow.reset();
          return currentStorage.uow as UnitOfWork;
        },
      });
    };
  }

  /**
   * Define dependencies for this database fragment.
   * The context includes database adapter and ORM instance.
   */
  withDependencies<TNewDeps>(
    fn: (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
      db: AbstractQuery<TSchema>;
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
    TServiceThisContext,
    THandlerThisContext,
    TLinkedFragments
  > {
    // Wrap user function to inject DB context. We need to do this here so that the user has access
    // to `db` when creating their own dependencies.
    const wrappedFn = (context: { config: TConfig; options: FragnoPublicConfigWithDatabase }) => {
      const dbContext = createDatabaseContext(context.options, this.#schema, this.#namespace);

      const userDeps = fn({
        config: context.config,
        options: context.options,
        db: dbContext.db,
        databaseAdapter: dbContext.databaseAdapter,
      });

      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        db: dbContext.db,
        schema: this.#schema,
        namespace: this.#namespace,
        createUnitOfWork: () => dbContext.db.createUnitOfWork(),
      };

      this.#setDatabaseDependencies(implicitDeps);

      return {
        ...userDeps,
        ...implicitDeps,
      };
    };

    // Create new base builder with wrapped function
    const newBaseBuilder = this.#baseBuilder.withDependencies(wrappedFn);

    // Return new database builder with updated base
    return new DatabaseFragmentDefinitionBuilder(newBaseBuilder, this.#schema, this.#namespace);
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
    TServiceThisContext,
    THandlerThisContext,
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.providesBaseService<TNewService>(fn);

    return new DatabaseFragmentDefinitionBuilder(newBaseBuilder, this.#schema, this.#namespace);
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
    TServiceThisContext,
    THandlerThisContext,
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.providesService<TServiceName, TService>(
      serviceName,
      fn,
    );

    return new DatabaseFragmentDefinitionBuilder(newBaseBuilder, this.#schema, this.#namespace);
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
    TServiceThisContext,
    THandlerThisContext,
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.usesService<TServiceName, TService>(serviceName);

    return new DatabaseFragmentDefinitionBuilder(newBaseBuilder, this.#schema, this.#namespace);
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
    TServiceThisContext,
    THandlerThisContext,
    TLinkedFragments
  > {
    const newBaseBuilder = this.#baseBuilder.usesOptionalService<TServiceName, TService>(
      serviceName,
    );

    return new DatabaseFragmentDefinitionBuilder(newBaseBuilder, this.#schema, this.#namespace);
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
    DatabaseServiceContext,
    DatabaseHandlerContext,
    DatabaseRequestStorage,
    TLinkedFragments,
    DatabaseFragnoInstantiatedFragment<
      readonly AnyFragnoRouteConfig[],
      TDeps,
      TServices,
      TServiceThisContext,
      THandlerThisContext,
      DatabaseRequestStorage,
      FragnoPublicConfigWithDatabase,
      TLinkedFragments
    >
  > {
    // Ensure dependencies callback always exists for database fragments
    // If no user dependencies were defined, create a minimal one that only adds implicit deps
    const dependencies = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }): TDeps => {
      const baseDef = this.#baseBuilder.build();

      let userDeps;
      try {
        userDeps = baseDef.dependencies?.(context);
      } catch (error) {
        // In dry run mode, allow user deps to fail gracefully.
        // This is critical for database fragments because the CLI needs access to the schema
        // even when user dependencies (like API clients) can't be initialized.
        // Without this, if user deps fail, we'd lose the implicit database dependencies
        // (including schema), and the CLI couldn't extract schema information.
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

    // Services get restricted context (no execute methods), handlers get execution context
    const builderWithContext = builderWithStorage.withThisContext<
      DatabaseServiceContext,
      DatabaseHandlerContext
    >(({ storage }) => {
      // Service context - forSchema method to get restricted typed UOW
      function forSchema<TSchema extends AnySchema>(
        schema: TSchema,
      ): TypedUnitOfWork<TSchema, [], unknown> {
        const uow = storage.getStore()?.uow;
        if (!uow) {
          throw new Error(
            "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
          );
        }

        // Return typed view of restricted UOW
        return uow.restrict().forSchema(schema);
      }

      const serviceContext: DatabaseServiceContext = {
        uow: forSchema,
      };

      // Handler context - use centralized uow function
      const handlerContext: DatabaseHandlerContext = {
        uow: this.#createUowFunction(storage),
      };

      return { serviceContext, handlerContext };
    });

    // Build the final definition
    const finalDef = builderWithContext.build();

    // Wrap base service to inject ImplicitDatabaseBaseService (uow method)
    let wrappedBaseServices = finalDef.baseServices;
    if (finalDef.baseServices) {
      const originalBaseServices = finalDef.baseServices;

      wrappedBaseServices = (
        context: ServiceContext<
          TConfig,
          FragnoPublicConfigWithDatabase,
          TDeps,
          TServiceDependencies,
          TPrivateServices,
          TServiceThisContext
        >,
      ) => {
        const service = originalBaseServices(context);

        // Get storage from the database adapter's context storage
        // This is the same storage used in withExternalRequestStorage
        const dbContext = createDatabaseContext(context.options, this.#schema, this.#namespace);
        const storage = dbContext.databaseAdapter.contextStorage;

        // Inject the uow method using our centralized function
        return {
          ...service,
          uow: this.#createUowFunction(storage),
        } as TBaseServices & ImplicitDatabaseBaseService;
      };
    }

    // Return the complete definition with proper typing and dependencies
    return {
      ...finalDef,
      dependencies,
      baseServices: wrappedBaseServices,
      creator: databaseFragnoInstantiatedFragmentCreator,
      // Phantom type to carry the instantiated fragment type (undefined at runtime)
      $instantiatedFragmentType: undefined as unknown as DatabaseFragnoInstantiatedFragment<
        readonly AnyFragnoRouteConfig[],
        TDeps,
        TServices,
        TServiceThisContext,
        THandlerThisContext,
        DatabaseRequestStorage,
        FragnoPublicConfigWithDatabase,
        TLinkedFragments
      >,
    };
  }
}
