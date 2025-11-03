import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";
import { bindServicesToContext, type BoundServices } from "./bind-services";
import { AsyncLocalStorage } from "async_hooks";
import type { IUnitOfWorkBase, UnitOfWorkSchemaView } from "./query/unit-of-work";
import type { RequestThisContext } from "@fragno-dev/core/api";

export const uowStorage = new AsyncLocalStorage<IUnitOfWorkBase>();

/**
 * Service context for database fragments, providing access to the Unit of Work.
 */
export interface DatabaseRequestThisContext extends RequestThisContext {
  /**
   * Get the Unit of Work from the current context.
   * @param schema - Optional schema to get a typed view. If not provided, returns the base UOW.
   * @returns IUnitOfWorkBase if no schema provided, or typed UnitOfWorkSchemaView if schema provided.
   */
  getUnitOfWork(): IUnitOfWorkBase;
  getUnitOfWork<TSchema extends AnySchema>(
    schema: TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): UnitOfWorkSchemaView<TSchema, [], any>;
}

export const serviceContext: DatabaseRequestThisContext = {
  getUnitOfWork<TSchema extends AnySchema>(
    schema?: TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    const uow = uowStorage.getStore();
    if (!uow) {
      throw new Error("No UnitOfWork in context. Service must be called within a route handler.");
    }
    if (schema) {
      return uow.forSchema(schema);
    }
    return uow;
  },
};

export function withUnitOfWork<T>(uow: IUnitOfWorkBase, callback: () => T): Promise<T> {
  return Promise.resolve(uowStorage.run(uow, callback));
}

/**
 * Type helper that enforces DatabaseRequestThisContext on all functions in a service object
 */
type WithDatabaseThis<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (this: DatabaseRequestThisContext, ...args: A) => R
    : T[K] extends Record<string, unknown>
      ? WithDatabaseThis<T[K]>
      : T[K];
};

/**
 * Helper function for defining services with proper `this` context.
 * Ensures that all functions have access to DatabaseRequestThisContext.
 */
export function defineServices<T extends Record<string, unknown>>(
  services: WithDatabaseThis<T>,
): WithDatabaseThis<T> {
  return services;
}

// Import types from fragno package
import type {
  FragmentDefinition,
  RouteHandler,
  FragnoPublicConfig,
  RequestInputContext,
  RequestOutputContext,
} from "@fragno-dev/core";

export { bindServicesToContext, type BoundServices };

/**
 * Route handler type for database fragments with access to Unit of Work.
 */
export type DatabaseRouteHandler = (
  this: DatabaseRequestThisContext,
  inputContext: RequestInputContext,
  outputContext: RequestOutputContext,
) => Promise<Response>;

/**
 * Extended FragnoPublicConfig that includes a database adapter.
 * Use this type when creating fragments with database support.
 */
export type FragnoPublicConfigWithDatabase = FragnoPublicConfig & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter: DatabaseAdapter<any>;
};

/**
 * Additional context provided to database fragments containing the database adapter and ORM instance.
 */
export type DatabaseFragmentContext<TSchema extends AnySchema> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter: DatabaseAdapter<any>;
  orm: AbstractQuery<TSchema>;
};

export class DatabaseFragmentBuilder<
  const TSchema extends AnySchema,
  const TConfig,
  const TDeps = {},
  const TServices extends Record<string, unknown> = {},
  const TUsedServices extends Record<string, unknown> = {},
  const TProvidedServices extends Record<string, unknown> = {},
> {
  // Type-only property to expose type parameters for better inference
  readonly $types!: {
    schema: TSchema;
    config: TConfig;
    deps: TDeps;
    services: TServices;
    usedServices: TUsedServices;
    providedServices: TProvidedServices;
  };

  #name: string;
  #schema?: TSchema;
  #namespace?: string;
  #dependencies?: (
    context: {
      config: TConfig;
      fragnoConfig: FragnoPublicConfig;
    } & DatabaseFragmentContext<TSchema>,
  ) => TDeps;
  #services?: (
    context: {
      config: TConfig;
      fragnoConfig: FragnoPublicConfig;
      deps: TDeps & TUsedServices;
    } & DatabaseFragmentContext<TSchema>,
  ) => TServices;
  #usedServices?: Record<string, { name: string; required: boolean }>;
  #providedServices?: Record<string, unknown>;

  constructor(options: {
    name: string;
    schema?: TSchema;
    namespace?: string;
    dependencies?: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
      } & DatabaseFragmentContext<TSchema>,
    ) => TDeps;
    services?: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
        deps: TDeps & TUsedServices;
      } & DatabaseFragmentContext<TSchema>,
    ) => TServices;
    usedServices?: Record<string, { name: string; required: boolean }>;
    providedServices?: Record<string, unknown>;
  }) {
    this.#name = options.name;
    this.#schema = options.schema;
    this.#namespace = options.namespace;
    this.#dependencies = options.dependencies;
    this.#services = options.services;
    this.#usedServices = options.usedServices;
    this.#providedServices = options.providedServices;
  }

  get $requiredOptions(): FragnoPublicConfigWithDatabase {
    throw new Error("Type only method. Do not call.");
  }

  get definition(): FragmentDefinition<
    TConfig,
    TDeps,
    BoundServices<TServices>,
    { databaseSchema?: TSchema; databaseNamespace: string },
    BoundServices<TUsedServices>,
    BoundServices<TProvidedServices>,
    DatabaseRequestThisContext
  > {
    const schema = this.#schema;
    const namespace = this.#namespace ?? "";
    const name = this.#name;
    const dependencies = this.#dependencies;
    const services = this.#services;

    return {
      name,
      dependencies: (config: TConfig, options: FragnoPublicConfig) => {
        const dbContext = this.#createDatabaseContext(options, schema, namespace, name);
        return dependencies?.({ config, fragnoConfig: options, ...dbContext }) ?? ({} as TDeps);
      },
      services: (
        config: TConfig,
        options: FragnoPublicConfig,
        deps: TDeps & BoundServices<TUsedServices>,
      ) => {
        const dbContext = this.#createDatabaseContext(options, schema, namespace, name);
        // Cast deps back to raw type for internal services function.
        // This is safe because:
        // 1. deps are already bound (their 'this' parameters are stripped)
        // 2. The services function expects raw types but only uses the public API
        // 3. BoundServices<T> has the same runtime shape as T (just without 'this')
        const rawServices =
          services?.({
            config,
            fragnoConfig: options,
            deps: deps as TDeps & TUsedServices,
            ...dbContext,
          }) ?? ({} as TServices);

        // Bind all service methods to serviceContext
        return bindServicesToContext(rawServices);
      },
      additionalContext: {
        databaseSchema: schema,
        databaseNamespace: namespace,
      },
      createHandlerWrapper: schema
        ? (options: FragnoPublicConfig) => {
            const dbContext = this.#createDatabaseContext(options, schema, namespace, name);
            const { orm } = dbContext;

            // Return handler wrapper function
            return (handler: DatabaseRouteHandler): RouteHandler => {
              return async (inputContext, outputContext) => {
                // Create UOW for this request
                const uow = orm.createUnitOfWork();

                // Execute handler within AsyncLocalStorage context
                return withUnitOfWork(uow, async () => {
                  // Bind handler to serviceContext so it has access to getUnitOfWork via 'this'
                  const boundHandler = handler.bind(serviceContext);
                  return boundHandler(inputContext, outputContext);
                });
              };
            };
          }
        : undefined,
      usedServices: this.#usedServices as
        | {
            [K in keyof TUsedServices]: { name: string; required: boolean };
          }
        | undefined,
      // providedServices are already bound when added via providesService
      providedServices: this.#providedServices as BoundServices<TProvidedServices> | undefined,
    };
  }

  #createDatabaseContext(
    options: FragnoPublicConfig,
    schema: TSchema | undefined,
    namespace: string,
    name: string,
  ): DatabaseFragmentContext<TSchema> {
    // Safe cast: FragnoPublicConfig is extended with databaseAdapter by the user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const databaseAdapter = (options as any).databaseAdapter as DatabaseAdapter<any> | undefined;

    if (!databaseAdapter) {
      throw new Error(`Fragment '${name}' requires a database adapter in options.databaseAdapter`);
    }
    if (!schema) {
      throw new Error(`Fragment '${name}' requires a schema. Use withDatabase() to provide one.`);
    }

    // Safe cast: we create a query engine for TSchema and know it will be AbstractQuery<TSchema>
    const orm = databaseAdapter.createQueryEngine(
      schema,
      namespace,
    ) as unknown as AbstractQuery<TSchema>;

    return { databaseAdapter, orm };
  }

  withDatabase<TNewSchema extends AnySchema>(
    schema: TNewSchema,
    namespace?: string,
  ): DatabaseFragmentBuilder<
    TNewSchema,
    TConfig,
    TDeps,
    TServices,
    TUsedServices,
    TProvidedServices
  > {
    return new DatabaseFragmentBuilder<
      TNewSchema,
      TConfig,
      TDeps,
      TServices,
      TUsedServices,
      TProvidedServices
    >({
      name: this.#name,
      schema,
      namespace: namespace ?? this.#name + "-db",
      dependencies: this.#dependencies as
        | ((
            context: {
              config: TConfig;
              fragnoConfig: FragnoPublicConfig;
            } & DatabaseFragmentContext<TNewSchema>,
          ) => TDeps)
        | undefined,
      services: this.#services as
        | ((
            context: {
              config: TConfig;
              fragnoConfig: FragnoPublicConfig;
              deps: TDeps & TUsedServices;
            } & DatabaseFragmentContext<TNewSchema>,
          ) => TServices)
        | undefined,
      usedServices: this.#usedServices,
      providedServices: this.#providedServices,
    });
  }

  withDependencies<TNewDeps>(
    fn: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
      } & DatabaseFragmentContext<TSchema>,
    ) => TNewDeps,
  ): DatabaseFragmentBuilder<TSchema, TConfig, TNewDeps, {}, TUsedServices, TProvidedServices> {
    return new DatabaseFragmentBuilder<
      TSchema,
      TConfig,
      TNewDeps,
      {},
      TUsedServices,
      TProvidedServices
    >({
      name: this.#name,
      schema: this.#schema,
      namespace: this.#namespace,
      dependencies: fn,
      services: undefined,
      usedServices: this.#usedServices,
      providedServices: this.#providedServices,
    });
  }

  withServices<TNewServices extends Record<string, unknown>>(
    fn: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
        deps: TDeps & TUsedServices;
      } & DatabaseFragmentContext<TSchema>,
    ) => WithDatabaseThis<TNewServices>,
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TNewServices,
    TUsedServices,
    TProvidedServices
  > {
    return new DatabaseFragmentBuilder<
      TSchema,
      TConfig,
      TDeps,
      TNewServices,
      TUsedServices,
      TProvidedServices
    >({
      name: this.#name,
      schema: this.#schema,
      namespace: this.#namespace,
      dependencies: this.#dependencies,
      // Safe: fn returns services with `this` parameters, but we store them as TNewServices
      // because bindServicesToContext will strip the `this` parameters at runtime
      services: fn as (
        context: {
          config: TConfig;
          fragnoConfig: FragnoPublicConfig;
          deps: TDeps & TUsedServices;
        } & DatabaseFragmentContext<TSchema>,
      ) => TNewServices,
      usedServices: this.#usedServices,
      providedServices: this.#providedServices,
    });
  }

  /**
   * Declare that this fragment uses a service.
   * @param serviceName - The name of the service to use
   * @param options - Optional configuration: { optional: boolean } (defaults to required)
   */
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    options?: { optional?: false },
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TServices,
    TUsedServices & { [K in TServiceName]: TService },
    TProvidedServices
  >;
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    options: { optional: true },
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TServices,
    TUsedServices & { [K in TServiceName]: TService | undefined },
    TProvidedServices
  >;
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    options?: { optional?: boolean },
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TServices,
    TUsedServices & { [K in TServiceName]: TService | TService | undefined },
    TProvidedServices
  > {
    const isOptional = options?.optional ?? false;
    return new DatabaseFragmentBuilder<
      TSchema,
      TConfig,
      TDeps,
      TServices,
      TUsedServices & { [K in TServiceName]: TService | (TService | undefined) },
      TProvidedServices
    >({
      name: this.#name,
      schema: this.#schema,
      namespace: this.#namespace,
      dependencies: this.#dependencies as unknown as
        | ((
            context: {
              config: TConfig;
              fragnoConfig: FragnoPublicConfig;
            } & DatabaseFragmentContext<TSchema>,
          ) => TDeps)
        | undefined,
      services: this.#services as unknown as
        | ((
            context: {
              config: TConfig;
              fragnoConfig: FragnoPublicConfig;
              deps: TDeps &
                (TUsedServices & { [K in TServiceName]: TService | (TService | undefined) });
            } & DatabaseFragmentContext<TSchema>,
          ) => TServices)
        | undefined,
      usedServices: {
        ...this.#usedServices,
        [serviceName]: { name: serviceName, required: !isOptional },
      },
      providedServices: this.#providedServices,
    });
  }

  /**
   * Provide a named service that other fragments can use.
   * Functions in the service will have access to DatabaseRequestThisContext.
   */
  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    implementation: WithDatabaseThis<TService>,
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TServices,
    TUsedServices,
    TProvidedServices & { [K in TServiceName]: BoundServices<TService> }
  > {
    // Bind the service implementation so methods have access to serviceContext
    const boundImplementation = bindServicesToContext(
      implementation as Record<string, unknown>,
    ) as BoundServices<TService>;

    return new DatabaseFragmentBuilder<
      TSchema,
      TConfig,
      TDeps,
      TServices,
      TUsedServices,
      TProvidedServices & { [K in TServiceName]: BoundServices<TService> }
    >({
      name: this.#name,
      schema: this.#schema,
      namespace: this.#namespace,
      dependencies: this.#dependencies,
      services: this.#services,
      usedServices: this.#usedServices,
      providedServices: {
        ...this.#providedServices,
        [serviceName]: boundImplementation,
      },
    });
  }
}

export function defineFragmentWithDatabase<TConfig = {}>(
  name: string,
): DatabaseFragmentBuilder<never, TConfig, {}, {}, {}, {}> {
  return new DatabaseFragmentBuilder<never, TConfig, {}, {}, {}, {}>({
    name,
  });
}
