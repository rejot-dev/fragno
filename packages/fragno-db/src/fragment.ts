import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";
import { bindServicesToContext, type BoundServices } from "./bind-services";
import { AsyncLocalStorage } from "node:async_hooks";
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
  getUnitOfWork<TSchema extends AnySchema>(schema: TSchema): UnitOfWorkSchemaView<TSchema>;
}

// Create overloaded function implementation
function getUnitOfWork(): IUnitOfWorkBase;
function getUnitOfWork<TSchema extends AnySchema>(schema: TSchema): UnitOfWorkSchemaView<TSchema>;
function getUnitOfWork<TSchema extends AnySchema>(
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

export const serviceContext: DatabaseRequestThisContext = {
  getUnitOfWork,
};

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
 * Identity function that preserves WithDatabaseThis wrapper for type inference.
 * Used in service definitions to ensure proper 'this' typing.
 */
const defineService = <T extends Record<string, unknown>>(
  services: WithDatabaseThis<T>,
): WithDatabaseThis<T> => services;

/**
 * Context type for service callbacks with database access.
 */
type ServiceContext<TConfig, TDeps, TUsedServices, TSchema extends AnySchema> = {
  config: TConfig;
  fragnoConfig: FragnoPublicConfig;
  deps: TDeps & TUsedServices;
  db: AbstractQuery<TSchema>;
  defineService: <T extends Record<string, unknown>>(
    services: WithDatabaseThis<T>,
  ) => WithDatabaseThis<T>;
};

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

/**
 * Implicit dependencies that are automatically available in all database fragments.
 * These are injected without requiring explicit configuration.
 */
export type ImplicitDependencies<TSchema extends AnySchema> = {
  /**
   * Create a new Unit of Work for database operations.
   */
  createUnitOfWork: () => IUnitOfWorkBase;
  /**
   * Database query engine for the fragment's schema.
   */
  db: AbstractQuery<TSchema>;
  /**
   * Execute a callback within a Unit of Work context.
   * The UnitOfWork is automatically created and made available via AsyncLocalStorage.
   * Supports both synchronous and asynchronous callbacks.
   */
  withUnitOfWork: {
    <T>(callback: () => T): T;
    <T>(callback: () => Promise<T>): Promise<T>;
  };
};

export class DatabaseFragmentBuilder<
  const TSchema extends AnySchema,
  const TConfig,
  const TDeps = {},
  const TServices = {},
  const TUsedServices = {},
  const TProvidedServices = {},
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
      defineService: <T extends Record<string, unknown>>(
        services: WithDatabaseThis<T>,
      ) => WithDatabaseThis<T>;
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
        defineService: <T extends Record<string, unknown>>(
          services: WithDatabaseThis<T>,
        ) => WithDatabaseThis<T>;
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
    TDeps & ImplicitDependencies<TSchema>,
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
    const providedServices = this.#providedServices;

    return {
      name,
      dependencies: (config: TConfig, options: FragnoPublicConfig) => {
        const dbContext = this.#createDatabaseContext(options, schema, namespace, name);

        // Create implicit dependencies
        const createUow = () => dbContext.orm.createUnitOfWork();
        const implicitDeps: ImplicitDependencies<TSchema> = {
          createUnitOfWork: createUow,
          db: dbContext.orm,
          withUnitOfWork: (<T>(callback: () => T | Promise<T>) => {
            const uow = createUow();
            return withUnitOfWork(uow, callback);
          }) as ImplicitDependencies<TSchema>["withUnitOfWork"],
        };

        // Get user-defined dependencies
        const userDeps =
          dependencies?.({
            config,
            fragnoConfig: options,
            ...dbContext,
          }) ?? {};

        // Merge user deps with implicit deps
        return {
          ...userDeps,
          ...implicitDeps,
        } as TDeps & ImplicitDependencies<TSchema>;
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
            defineService,
            ...dbContext,
          }) ?? ({} as TServices);

        // Bind all service methods to serviceContext
        return bindServicesToContext(
          rawServices as Record<string, unknown>,
        ) as BoundServices<TServices>;
      },
      additionalContext: {
        databaseSchema: schema,
        databaseNamespace: namespace,
      },
      /**
       * Handler wrapper: Binds route handlers to serviceContext
       *
       * Purpose: Allows route handlers to use `this.getUnitOfWork()` directly
       * in their function body by binding them to the DatabaseRequestThisContext.
       *
       * Example:
       * ```ts
       * handler: async function(ctx, { json }) {
       *   const uow = this.getUnitOfWork();  // ✓ Works because handler is bound
       *   // ...
       * }
       * ```
       *
       * Note: This only handles the `this` binding. The actual UnitOfWork instance
       * is created and made available by createRequestContextWrapper.
       */
      createHandlerWrapper: schema
        ? (_options: FragnoPublicConfig) => {
            // Return handler wrapper function
            return (handler: DatabaseRouteHandler): RouteHandler => {
              return async (inputContext, outputContext) => {
                // Bind handler to serviceContext so it has access to getUnitOfWork via 'this'
                const boundHandler = handler.bind(serviceContext);
                return boundHandler(inputContext, outputContext);
              };
            };
          }
        : undefined,
      /**
       * Request context wrapper: Creates and manages the UnitOfWork lifecycle
       *
       * Purpose: Creates a UnitOfWork at the start of each request and makes it
       * available throughout the entire request lifecycle (both middleware and handler)
       * via AsyncLocalStorage. This ensures:
       *
       * 1. The same transaction spans middleware and handler execution
       * 2. Services called from middleware can access the UnitOfWork
       * 3. The UnitOfWork is properly scoped to the request
       *
       * Example flow:
       * ```
       * Request arrives
       *   ↓
       * createRequestContextWrapper creates UnitOfWork
       *   ↓
       * withUnitOfWork() stores it in AsyncLocalStorage
       *   ↓
       * Middleware executes (services can call this.getUnitOfWork())
       *   ↓
       * Handler executes (can call this.getUnitOfWork())
       *   ↓
       * Response returned, UnitOfWork context cleaned up
       * ```
       *
       * This works together with createHandlerWrapper:
       * - createRequestContextWrapper: Makes UnitOfWork available (AsyncLocalStorage)
       * - createHandlerWrapper: Binds handlers so `this.getUnitOfWork()` works
       */
      createRequestContextWrapper: schema
        ? (options: FragnoPublicConfig) => {
            const dbContext = this.#createDatabaseContext(options, schema, namespace, name);
            const { orm } = dbContext;

            // Return wrapper function that creates UnitOfWork and wraps execution
            return async <T>(callback: () => Promise<T>): Promise<T> => {
              const uow = orm.createUnitOfWork();
              return withUnitOfWork(uow, callback);
            };
          }
        : undefined,
      usedServices: this.#usedServices as
        | {
            [K in keyof TUsedServices]: { name: string; required: boolean };
          }
        | undefined,
      // Pass providedServices as-is - let fragment-instantiation.ts handle resolution
      // The factory functions will be called by createFragment
      providedServices: providedServices as
        | {
            [K in keyof BoundServices<TProvidedServices>]: BoundServices<TProvidedServices>[K];
          }
        | ((
            config: TConfig,
            options: FragnoPublicConfig,
            deps: TDeps & BoundServices<TUsedServices>,
          ) => BoundServices<TProvidedServices>)
        | undefined,
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

    const orm = databaseAdapter.createQueryEngine(schema, namespace);

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
              defineService: <T extends Record<string, unknown>>(
                services: WithDatabaseThis<T>,
              ) => WithDatabaseThis<T>;
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
    TUsedServices & { [K in TServiceName]: TService | undefined },
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
   * Define services for this fragment (unnamed).
   * Functions in the service will have access to DatabaseRequestThisContext via `this` if using `defineService`.
   *
   * @example
   * With `this` context:
   * ```ts
   * .providesService(({ defineService }) => defineService({
   *   createUser: function(name: string) {
   *     const uow = this.getUnitOfWork(mySchema);
   *     return uow.create('user', { name });
   *   }
   * }))
   * ```
   *
   * Without `this` context:
   * ```ts
   * .providesService(({ db }) => ({
   *   createUser: async (name: string) => {
   *     return db.create('user', { name });
   *   }
   * }))
   * ```
   */
  providesService<TNewServices>(
    fn: (context: ServiceContext<TConfig, TDeps, TUsedServices, TSchema>) => TNewServices,
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TNewServices,
    TUsedServices,
    TProvidedServices
  >;

  /**
   * Provide a named service that other fragments can use.
   * Functions in the service will have access to DatabaseRequestThisContext via `this` if using `defineService`.
   * You can also pass a service object directly instead of a callback.
   *
   * @example
   * With callback and `this` context:
   * ```ts
   * .providesService("myService", ({ defineService }) => defineService({
   *   createUser: function(name: string) {
   *     const uow = this.getUnitOfWork(mySchema);
   *     return uow.create('user', { name });
   *   }
   * }))
   * ```
   *
   * With callback, no `this` context:
   * ```ts
   * .providesService("myService", ({ db }) => ({
   *   createUser: async (name: string) => {
   *     return db.create('user', { name });
   *   }
   * }))
   * ```
   *
   * With direct object:
   * ```ts
   * .providesService("myService", {
   *   createUser: async (name: string) => { ... }
   * })
   * ```
   */
  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    fnOrService:
      | ((context: ServiceContext<TConfig, TDeps, TUsedServices, TSchema>) => TService)
      | TService,
  ): DatabaseFragmentBuilder<
    TSchema,
    TConfig,
    TDeps,
    TServices,
    TUsedServices,
    TProvidedServices & { [K in TServiceName]: BoundServices<TService> }
  >;

  providesService<TServiceName extends string, TService>(
    ...args:
      | [fn: (context: ServiceContext<TConfig, TDeps, TUsedServices, TSchema>) => TService]
      | [
          serviceName: TServiceName,
          fnOrService:
            | ((context: ServiceContext<TConfig, TDeps, TUsedServices, TSchema>) => TService)
            | TService,
        ]
  ):
    | DatabaseFragmentBuilder<TSchema, TConfig, TDeps, TService, TUsedServices, TProvidedServices>
    | DatabaseFragmentBuilder<
        TSchema,
        TConfig,
        TDeps,
        TServices,
        TUsedServices,
        TProvidedServices & { [K in TServiceName]: BoundServices<TService> }
      > {
    if (args.length === 1) {
      // Unnamed service - replaces withServices
      const [fn] = args;

      // Create a callback that takes a single context object (matching #services signature)
      const servicesCallback = (
        context: {
          config: TConfig;
          fragnoConfig: FragnoPublicConfig;
          deps: TDeps & TUsedServices;
        } & DatabaseFragmentContext<TSchema>,
      ) => {
        return fn({
          config: context.config,
          fragnoConfig: context.fragnoConfig,
          deps: context.deps,
          db: context.orm,
          defineService,
        });
      };

      return new DatabaseFragmentBuilder<
        TSchema,
        TConfig,
        TDeps,
        TService,
        TUsedServices,
        TProvidedServices
      >({
        name: this.#name,
        schema: this.#schema,
        namespace: this.#namespace,
        dependencies: this.#dependencies,
        // Safe cast: servicesCallback returns WithDatabaseThis<TService> but we store it as TService.
        // At runtime, bindServicesToContext will handle the 'this' binding properly.
        services: servicesCallback as (
          context: {
            config: TConfig;
            fragnoConfig: FragnoPublicConfig;
            deps: TDeps & TUsedServices;
            defineService: <T extends Record<string, unknown>>(
              services: WithDatabaseThis<T>,
            ) => WithDatabaseThis<T>;
          } & DatabaseFragmentContext<TSchema>,
        ) => TService,
        usedServices: this.#usedServices,
        providedServices: this.#providedServices,
      });
    } else {
      // Named service
      const [serviceName, fnOrService] = args;

      // Create a factory function that will be called during fragment instantiation
      const createService = (
        config: TConfig,
        options: FragnoPublicConfig,
        deps: TDeps & TUsedServices,
      ): BoundServices<TService> => {
        const dbContext = this.#createDatabaseContext(
          options,
          this.#schema,
          this.#namespace ?? "",
          this.#name,
        );

        // Check if fnOrService is a function or a direct object
        let implementation: TService;
        if (typeof fnOrService === "function") {
          // It's a callback - call it with context
          // Safe cast: we checked that fnOrService is a function
          implementation = (
            fnOrService as (
              context: ServiceContext<TConfig, TDeps, TUsedServices, TSchema>,
            ) => TService
          )({
            config,
            fragnoConfig: options,
            deps,
            db: dbContext.orm,
            defineService,
          });
        } else {
          // It's a direct object
          implementation = fnOrService;
        }

        // Bind the service implementation so methods have access to serviceContext
        return bindServicesToContext(
          implementation as Record<string, unknown>,
        ) as BoundServices<TService>;
      };

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
          [serviceName]: createService,
        } as Record<string, unknown>,
      });
    }
  }
}

export function defineFragmentWithDatabase<TConfig = {}>(
  name: string,
): DatabaseFragmentBuilder<never, TConfig, {}, {}, {}, {}> {
  return new DatabaseFragmentBuilder<never, TConfig, {}, {}, {}, {}>({
    name,
  });
}
