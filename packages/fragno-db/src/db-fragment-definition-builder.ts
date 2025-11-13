import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { IUnitOfWorkBase, UnitOfWorkSchemaView } from "./query/unit-of-work";
import type { RequestThisContext } from "@fragno-dev/core/api";
import type { FragnoPublicConfig } from "@fragno-dev/core/api/fragment-instantiation";
import {
  FragmentDefinitionBuilder,
  type NewFragmentDefinition,
  type ServiceConstructorFn,
} from "@fragno-dev/core/api/fragment-definition-builder";
import { withUnitOfWork, serviceContext, type FragnoPublicConfigWithDatabase } from "./fragment";

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
  /**
   * Execute a callback within a Unit of Work context.
   * The UnitOfWork is automatically created and made available via AsyncLocalStorage.
   */
  withUnitOfWork: {
    <T>(callback: () => T): T;
    <T>(callback: () => Promise<T>): Promise<T>;
  };
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
  TThisContext extends RequestThisContext = RequestThisContext,
> {
  // Store the base builder - we'll replace its createRequestContext when building
  #baseBuilder: FragmentDefinitionBuilder<
    TConfig,
    FragnoPublicConfigWithDatabase,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext
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
      TThisContext
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
        withUnitOfWork: <T>(callback: () => T | Promise<T>) => {
          const uow = createUow();
          return withUnitOfWork(uow, callback);
        },
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
  build(): NewFragmentDefinition<
    TConfig,
    FragnoPublicConfigWithDatabase,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    DatabaseRequestContext
  > {
    const baseDef = this.#baseBuilder.build();

    // Ensure dependencies callback always exists for database fragments
    // If no user dependencies were defined, create a minimal one that only adds implicit deps
    const dependencies = (context: {
      config: TConfig;
      options: FragnoPublicConfigWithDatabase;
    }) => {
      const userDeps = baseDef.dependencies?.(context);

      const { db } = createDatabaseContext(context.options, this.#schema, this.#namespace);

      const implicitDeps: ImplicitDatabaseDependencies<TSchema> = {
        db,
        schema: this.#schema,
        createUnitOfWork: () => db.createUnitOfWork(),
        withUnitOfWork: <T>(callback: () => T | Promise<T>) => {
          const uow = db.createUnitOfWork();
          return withUnitOfWork(uow, callback);
        },
      };

      return {
        ...userDeps,
        ...implicitDeps,
      } as TDeps;
    };

    return {
      ...baseDef,
      dependencies,
      // Add database-specific request context management
      createRequestContext: (options: FragnoPublicConfigWithDatabase) => {
        const dbContext = createDatabaseContext(options, this.#schema, this.#namespace);

        return {
          // Provide the database service context with getUnitOfWork
          thisContext: serviceContext as DatabaseRequestContext,
          // Wrap request execution to create and manage UnitOfWork
          wrapRequest: async <T>(callback: () => Promise<T>): Promise<T> => {
            const uow = dbContext.db.createUnitOfWork();
            return withUnitOfWork(uow, callback);
          },
        };
      },
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
): <TConfig, TDeps, TBaseServices, TServices, TServiceDeps>(
  builder: FragmentDefinitionBuilder<
    TConfig,
    FragnoPublicConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDeps,
    RequestThisContext
  >,
) => DatabaseFragmentDefinitionBuilder<
  TSchema,
  TConfig,
  TDeps & ImplicitDatabaseDependencies<TSchema>,
  TBaseServices,
  TServices,
  TServiceDeps,
  RequestThisContext
> {
  return <TConfig, TDeps, TBaseServices, TServices, TServiceDeps>(
    builder: FragmentDefinitionBuilder<
      TConfig,
      FragnoPublicConfig,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDeps,
      RequestThisContext
    >,
  ) => {
    // Cast is safe: we're creating a DatabaseFragmentDefinitionBuilder which internally uses
    // FragnoPublicConfigWithDatabase, but the input builder uses FragnoPublicConfig.
    // The database builder's build() method will enforce FragnoPublicConfigWithDatabase at the end.
    // We also add ImplicitDatabaseDependencies to TDeps so they're available in service constructors.
    return new DatabaseFragmentDefinitionBuilder<
      TSchema,
      TConfig,
      TDeps & ImplicitDatabaseDependencies<TSchema>,
      TBaseServices,
      TServices,
      TServiceDeps,
      RequestThisContext
    >(
      builder as unknown as FragmentDefinitionBuilder<
        TConfig,
        FragnoPublicConfigWithDatabase,
        TDeps & ImplicitDatabaseDependencies<TSchema>,
        TBaseServices,
        TServices,
        TServiceDeps,
        RequestThisContext
      >,
      schema,
      namespace,
    );
  };
}
