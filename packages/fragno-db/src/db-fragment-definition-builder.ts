import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { IUnitOfWorkBase, UnitOfWorkSchemaView } from "./query/unit-of-work";
import type { RequestThisContext, FragnoPublicConfig } from "@fragno-dev/core";
import {
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceConstructorFn,
} from "@fragno-dev/core";
import { AsyncLocalStorage } from "node:async_hooks";

// AsyncLocalStorage for Unit of Work
export const uowStorage = new AsyncLocalStorage<IUnitOfWorkBase>();

// Overload for synchronous callbacks
export function withUnitOfWork<T>(uow: IUnitOfWorkBase, callback: () => T): T;
// Overload for asynchronous callbacks
export function withUnitOfWork<T>(uow: IUnitOfWorkBase, callback: () => Promise<T>): Promise<T>;
// Implementation
export function withUnitOfWork<T>(
  uow: IUnitOfWorkBase,
  callback: () => T | Promise<T>,
): T | Promise<T> {
  return uowStorage.run(uow, callback);
}

/**
 * Service context for database fragments, providing access to the Unit of Work.
 * This reads from AsyncLocalStorage.
 */
export interface DatabaseRequestThisContext extends RequestThisContext {
  getUnitOfWork(): IUnitOfWorkBase;
  getUnitOfWork<TSchema extends AnySchema>(schema: TSchema): UnitOfWorkSchemaView<TSchema>;
}

/**
 * Implementation function for getUnitOfWork
 */
function getUnitOfWorkImpl(): IUnitOfWorkBase;
function getUnitOfWorkImpl<TSchema extends AnySchema>(
  schema: TSchema,
): UnitOfWorkSchemaView<TSchema>;
function getUnitOfWorkImpl<TSchema extends AnySchema>(
  schema?: TSchema,
): IUnitOfWorkBase | UnitOfWorkSchemaView<TSchema> {
  const uow = uowStorage.getStore();
  if (!uow) {
    throw new Error(
      "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
    );
  }
  if (schema) {
    return uow.forSchema(schema);
  }
  return uow;
}

/**
 * Global service context that reads from AsyncLocalStorage.
 */
export const serviceContext: DatabaseRequestThisContext = {
  getUnitOfWork: getUnitOfWorkImpl,
};

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
   * Create a new Unit of Work for database operations.
   */
  createUnitOfWork: () => IUnitOfWorkBase;
};

/**
 * Extended request context for database fragments with access to Unit of Work.
 */
export type DatabaseRequestContext = RequestThisContext & {
  /**
   * Get the Unit of Work from the current context.
   * @param schema - Optional schema to get a typed view. If not provided, returns the base UOW.
   * @returns IUnitOfWorkBase if no schema provided, or typed UnitOfWorkSchemaView if schema provided.
   */
  getUnitOfWork(): IUnitOfWorkBase;
  getUnitOfWork<TSchema extends AnySchema>(schema: TSchema): UnitOfWorkSchemaView<TSchema>;
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
  uow: IUnitOfWorkBase;
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
  TThisContext extends RequestThisContext = DatabaseRequestContext,
> {
  // Store the base builder - we'll replace its storage and context setup when building
  #baseBuilder: FragmentDefinitionBuilder<
    TConfig,
    FragnoPublicConfigWithDatabase,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    DatabaseRequestStorage
  >;
  #schema: TSchema;
  #namespace: string;

  constructor(
    baseBuilder: FragmentDefinitionBuilder<
      TConfig,
      FragnoPublicConfigWithDatabase,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TThisContext,
      DatabaseRequestStorage
    >,
    schema: TSchema,
    namespace?: string,
  ) {
    this.#baseBuilder = baseBuilder;
    this.#schema = schema;
    this.#namespace = namespace ?? baseBuilder.name + "-db";
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
    TThisContext
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
        createUnitOfWork: createUow,
      };

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
      TNewService,
      TThisContext
    >,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TNewService,
    TServices,
    TServiceDependencies,
    TThisContext
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
      TService,
      TThisContext
    >,
  ): DatabaseFragmentDefinitionBuilder<
    TSchema,
    TConfig,
    TDeps,
    TBaseServices,
    TServices & { [K in TServiceName]: TService },
    TServiceDependencies,
    TThisContext
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
    TThisContext
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
    TThisContext
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
    DatabaseRequestContext,
    DatabaseRequestStorage
  > {
    // Ensure dependencies callback always exists for database fragments
    // If no user dependencies were defined, create a minimal one that only adds implicit deps
    const dependencies = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }): TDeps => {
      const baseDef = this.#baseBuilder.build();
      const userDeps = baseDef.dependencies?.(context);

      const { db } = createDatabaseContext(context.options, this.#schema, this.#namespace);

      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        db,
        schema: this.#schema,
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
        const uow: IUnitOfWorkBase = dbContextForStorage.db.createUnitOfWork();

        return { uow };
      },
    );

    // Set up request context with getUnitOfWork method
    const builderWithContext = builderWithStorage.withRequestThisContext(
      ({ storage }): DatabaseRequestContext => {
        // Define getUnitOfWork with proper overload signatures
        function getUnitOfWork(): IUnitOfWorkBase;
        function getUnitOfWork<TSchema extends AnySchema>(
          schema: TSchema,
        ): UnitOfWorkSchemaView<TSchema>;
        function getUnitOfWork<TSchema extends AnySchema>(
          schema?: TSchema,
        ): IUnitOfWorkBase | UnitOfWorkSchemaView<TSchema> {
          const uow = storage.getStore()?.uow;

          if (!uow) {
            throw new Error(
              "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
            );
          }

          if (schema) {
            return uow.forSchema(schema);
          }
          return uow;
        }

        return { getUnitOfWork };
      },
    );

    // Build the final definition
    const finalDef = builderWithContext.build();

    // Return the complete definition with proper typing and dependencies
    return {
      ...finalDef,
      dependencies,
    };
  }
}

/**
 * Helper to add database support to a fragment builder.
 * Automatically adds ImplicitDatabaseDependencies to the TDeps type.
 *
 * @example
 * ```typescript
 * // With .extend() - recommended
 * const def = defineFragment("my-frag")
 *   .extend(withDatabase(mySchema))
 *   .withDependencies(...)
 *   .build();
 *
 * // Or as a function wrapper
 * const def = withDatabase(mySchema)(defineFragment("my-frag"))
 *   .withDependencies(...)
 *   .build();
 * ```
 */
export function withDatabase<TSchema extends AnySchema>(
  schema: TSchema,
  namespace?: string,
): <TConfig, TDeps, TBaseServices, TServices, TServiceDeps, TRequestStorage>(
  builder: FragmentDefinitionBuilder<
    TConfig,
    FragnoPublicConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDeps,
    RequestThisContext,
    TRequestStorage
  >,
) => DatabaseFragmentDefinitionBuilder<
  TSchema,
  TConfig,
  TDeps & ImplicitDatabaseDependencies<TSchema>,
  TBaseServices,
  TServices,
  TServiceDeps,
  DatabaseRequestContext
> {
  return <TConfig, TDeps, TBaseServices, TServices, TServiceDeps, TRequestStorage>(
    builder: FragmentDefinitionBuilder<
      TConfig,
      FragnoPublicConfig,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDeps,
      RequestThisContext,
      TRequestStorage
    >,
  ) => {
    // Cast is safe: we're creating a DatabaseFragmentDefinitionBuilder which internally uses
    // FragnoPublicConfigWithDatabase, but the input builder uses FragnoPublicConfig.
    // The database builder's build() method will enforce FragnoPublicConfigWithDatabase at the end.
    // We also add ImplicitDatabaseDependencies to TDeps so they're available in service constructors.
    // Note: We discard TRequestStorage here because database fragments manage their own storage (DatabaseRequestStorage).
    // We also set TThisContext to DatabaseRequestContext so services have access to getUnitOfWork.
    return new DatabaseFragmentDefinitionBuilder<
      TSchema,
      TConfig,
      TDeps & ImplicitDatabaseDependencies<TSchema>,
      TBaseServices,
      TServices,
      TServiceDeps,
      DatabaseRequestContext
    >(
      builder as unknown as FragmentDefinitionBuilder<
        TConfig,
        FragnoPublicConfigWithDatabase,
        TDeps & ImplicitDatabaseDependencies<TSchema>,
        TBaseServices,
        TServices,
        TServiceDeps,
        DatabaseRequestContext,
        DatabaseRequestStorage
      >,
      schema,
      namespace,
    );
  };
}
