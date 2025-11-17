import type { RequestThisContext } from "./api";
import type { FragnoPublicConfig } from "./shared-types";
import type { RequestContextStorage } from "./request-context-storage";

/**
 * Metadata for a service dependency
 */
interface ServiceMetadata {
  /** Name of the service */
  name: string;
  /** Whether this service is required (false means optional) */
  required: boolean;
}

/**
 * Context passed to the request context factory function.
 */
export type RequestContextFactoryContext<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TRequestStorage,
> = {
  config: TConfig;
  options: TOptions;
  deps: TDeps;
  storage: RequestContextStorage<TRequestStorage>;
};

/**
 * Context object passed to service constructor functions
 */
export type ServiceContext<
  TConfig,
  TOptions,
  TDeps,
  TServiceDependencies,
  TThisContext extends RequestThisContext,
> = {
  config: TConfig;
  options: TOptions;
  deps: TDeps;
  serviceDeps: TServiceDependencies;
  /**
   * Helper to define services with proper `this` context typing.
   * Use this to wrap your service methods when they need access to `this`.
   */
  defineService: <T>(svc: T & ThisType<TThisContext>) => T;
};

/**
 * Service constructor function type
 */
export type ServiceConstructorFn<
  TConfig,
  TOptions,
  TDeps,
  TServiceDependencies,
  TService,
  TThisContext extends RequestThisContext,
> = (
  context: ServiceContext<TConfig, TOptions, TDeps, TServiceDependencies, TThisContext>,
) => TService;

/**
 * New fragment definition interface that supports both regular and database fragments.
 * This is the core definition that will be used for fragment instantiation.
 */
export interface NewFragmentDefinition<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TThisContext extends RequestThisContext,
  TRequestStorage = {},
> {
  name: string;

  // Core callbacks - all take context objects with separate deps and serviceDeps
  dependencies?: (context: { config: TConfig; options: TOptions }) => TDeps;

  baseServices?: ServiceConstructorFn<
    TConfig,
    TOptions,
    TDeps,
    TServiceDependencies,
    TBaseServices,
    TThisContext
  >;

  // Named services stored as factory functions
  namedServices?: {
    [K in keyof TServices]: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TServices[K],
      TThisContext
    >;
  };

  // Service dependency metadata
  serviceDependencies?: {
    [K in keyof TServiceDependencies]: ServiceMetadata;
  };

  /**
   * Optional factory function to create the initial request storage data.
   * This is called at the start of each request to initialize the storage.
   * The returned object can be mutated throughout the request lifecycle.
   *
   * @example
   * ```ts
   * createRequestStorage: ({ config, options, deps }) => ({
   *   counter: 0,
   *   userId: deps.currentUserId
   * })
   * ```
   */
  createRequestStorage?: (context: {
    config: TConfig;
    options: TOptions;
    deps: TDeps;
  }) => TRequestStorage;

  /**
   * Optional factory function to create the request context object.
   * This object should contain only methods or getters that read from storage.
   * The context is created once at instantiation and bound to services.
   *
   * @example
   * ```ts
   * createRequestContext: ({ storage }) => ({
   *   get myNumber() { return storage.getStore()?.myNumber; },
   *   getMyString() { return storage.getStore()?.myString; }
   * })
   * ```
   */
  createRequestContext?: (
    context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
  ) => TThisContext;

  /**
   * Optional factory function to get an external RequestContextStorage instance.
   * When provided, this storage will be used instead of creating a new one.
   * This allows multiple fragments to share the same storage (e.g., database fragments sharing adapter storage).
   *
   * @example
   * ```ts
   * getExternalStorage: ({ options }) => options.databaseAdapter.contextStorage
   * ```
   */
  getExternalStorage?: (context: {
    config: TConfig;
    options: TOptions;
    deps: TDeps;
  }) => RequestContextStorage<TRequestStorage>;

  $thisContext?: TThisContext;
  $requestStorage?: TRequestStorage;
}

/**
 * Builder class for creating fragment definitions.
 * This provides a fluent API for defining fragments with type safety.
 */
export class FragmentDefinitionBuilder<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TThisContext extends RequestThisContext,
  TRequestStorage = {},
> {
  #name: string;
  #dependencies?: (context: { config: TConfig; options: TOptions }) => TDeps;
  #baseServices?: ServiceConstructorFn<
    TConfig,
    TOptions,
    TDeps,
    TServiceDependencies,
    TBaseServices,
    TThisContext
  >;
  #namedServices?: {
    [K in keyof TServices]: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TServices[K],
      TThisContext
    >;
  };
  #serviceDependencies?: {
    [K in keyof TServiceDependencies]: ServiceMetadata;
  };
  #createRequestStorage?: (context: {
    config: TConfig;
    options: TOptions;
    deps: TDeps;
  }) => TRequestStorage;
  #createRequestContext?: (
    context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
  ) => TThisContext;
  #getExternalStorage?: (context: {
    config: TConfig;
    options: TOptions;
    deps: TDeps;
  }) => RequestContextStorage<TRequestStorage>;

  constructor(
    name: string,
    state?: {
      dependencies?: (context: { config: TConfig; options: TOptions }) => TDeps;
      baseServices?: ServiceConstructorFn<
        TConfig,
        TOptions,
        TDeps,
        TServiceDependencies,
        TBaseServices,
        TThisContext
      >;
      namedServices?: {
        [K in keyof TServices]: ServiceConstructorFn<
          TConfig,
          TOptions,
          TDeps,
          TServiceDependencies,
          TServices[K],
          TThisContext
        >;
      };
      serviceDependencies?: {
        [K in keyof TServiceDependencies]: ServiceMetadata;
      };
      createRequestStorage?: (context: {
        config: TConfig;
        options: TOptions;
        deps: TDeps;
      }) => TRequestStorage;
      createRequestContext?: (
        context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
      ) => TThisContext;
      getExternalStorage?: (context: {
        config: TConfig;
        options: TOptions;
        deps: TDeps;
      }) => RequestContextStorage<TRequestStorage>;
    },
  ) {
    this.#name = name;
    if (state) {
      this.#dependencies = state.dependencies;
      this.#baseServices = state.baseServices;
      this.#namedServices = state.namedServices;
      this.#serviceDependencies = state.serviceDependencies;
      this.#createRequestStorage = state.createRequestStorage;
      this.#createRequestContext = state.createRequestContext;
      this.#getExternalStorage = state.getExternalStorage;
    }
  }

  get name(): string {
    return this.#name;
  }

  /**
   * Define dependencies for this fragment.
   * Dependencies are available to services and handlers.
   *
   * **IMPORTANT**: This method resets all services, storage, and context configurations.
   * Always call `withDependencies` early in the builder chain, before defining services
   * or request storage/context.
   *
   * @example
   * ```typescript
   * // ✅ GOOD: Dependencies set first
   * defineFragment("my-fragment")
   *   .withDependencies(() => ({ apiKey: "..." }))
   *   .withRequestStorage(({ deps }) => ({ userId: deps.apiKey }))
   *   .providesService("myService", ...)
   *
   * // ❌ BAD: Dependencies set late (erases storage setup)
   * defineFragment("my-fragment")
   *   .withRequestStorage(() => ({ userId: "..." }))  // This gets erased!
   *   .withDependencies(() => ({ apiKey: "..." }))
   * ```
   */
  withDependencies<TNewDeps>(
    fn: (context: { config: TConfig; options: TOptions }) => TNewDeps,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TNewDeps,
    {},
    {},
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  > {
    // Warn if we're discarding existing configuration
    if (
      this.#baseServices ||
      this.#namedServices ||
      this.#createRequestStorage ||
      this.#createRequestContext ||
      this.#getExternalStorage
    ) {
      console.warn(
        `[Fragno] Warning: withDependencies() on fragment "${this.#name}" is resetting previously configured services, request storage, or request context. ` +
          `To avoid this, call withDependencies() earlier in the builder chain, before configuring services or storage.`,
      );
    }

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TNewDeps,
      {},
      {},
      TServiceDependencies,
      TThisContext,
      TRequestStorage
    >(this.#name, {
      dependencies: fn,
      baseServices: undefined,
      namedServices: undefined,
      serviceDependencies: this.#serviceDependencies,
      // Reset storage/context functions since deps type changed - they must be reconfigured
      createRequestStorage: undefined,
      createRequestContext: undefined,
      getExternalStorage: undefined,
    });
  }

  /**
   * Define base (unnamed) services for this fragment.
   * Base services are accessible directly on the fragment instance.
   */
  providesBaseService<TNewService>(
    fn: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TNewService,
      TThisContext
    >,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TNewService,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TNewService,
      TServices,
      TServiceDependencies,
      TThisContext,
      TRequestStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: fn,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createRequestContext: this.#createRequestContext,
    });
  }

  /**
   * Provide a named service that other fragments or users can use.
   * Named services are accessible as fragment.serviceName.method()
   */
  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    fn: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TService,
      TThisContext
    >,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices & { [K in TServiceName]: TService },
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  > {
    // Type assertion needed because TypeScript can't verify object spread with mapped types
    const newNamedServices = {
      ...this.#namedServices,
      [serviceName]: fn,
    } as {
      [K in keyof (TServices & { [K in TServiceName]: TService })]: ServiceConstructorFn<
        TConfig,
        TOptions,
        TDeps,
        TServiceDependencies,
        (TServices & { [K in TServiceName]: TService })[K],
        TThisContext
      >;
    };

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices & { [K in TServiceName]: TService },
      TServiceDependencies,
      TThisContext,
      TRequestStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: newNamedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createRequestContext: this.#createRequestContext,
    });
  }

  /**
   * Declare that this fragment uses a required service provided by the runtime.
   */
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies & { [K in TServiceName]: TService },
    TThisContext,
    TRequestStorage
  > {
    // Type assertion needed because TypeScript can't verify object spread with mapped types
    const newServiceDependencies = {
      ...this.#serviceDependencies,
      [serviceName]: { name: serviceName, required: true },
    } as {
      [K in keyof (TServiceDependencies & { [K in TServiceName]: TService })]: ServiceMetadata;
    };

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies & { [K in TServiceName]: TService },
      TThisContext,
      TRequestStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: newServiceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createRequestContext: this.#createRequestContext,
    });
  }

  /**
   * Declare that this fragment uses an optional service provided by the runtime.
   */
  usesOptionalService<TServiceName extends string, TService>(
    serviceName: TServiceName,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies & { [K in TServiceName]: TService | undefined },
    TThisContext,
    TRequestStorage
  > {
    // Type assertion needed because TypeScript can't verify object spread with mapped types
    const newServiceDependencies = {
      ...this.#serviceDependencies,
      [serviceName]: { name: serviceName, required: false },
    } as {
      [K in keyof (TServiceDependencies & {
        [K in TServiceName]: TService | undefined;
      })]: ServiceMetadata;
    };

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies & { [K in TServiceName]: TService | undefined },
      TThisContext,
      TRequestStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: newServiceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createRequestContext: this.#createRequestContext,
    });
  }

  /**
   * Define the type and initial data stored in AsyncLocalStorage for per-request isolation.
   * This should be called before withRequestThisContext if you need to store request-specific data.
   *
   * @param initializer Function that returns the initial storage data for each request
   *
   * @example
   * ```typescript
   * .withRequestStorage(({ config, options, deps }) => ({
   *   counter: 0,
   *   userId: deps.currentUserId
   * }))
   * .withRequestThisContext(({ storage }) => ({
   *   get counter() { return storage.getStore()!.counter; }
   * }))
   * ```
   */
  withRequestStorage<TNewRequestStorage>(
    initializer: (context: {
      config: TConfig;
      options: TOptions;
      deps: TDeps;
    }) => TNewRequestStorage,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TNewRequestStorage
  > {
    // getExternalStorage can coexist with createRequestStorage (they work together)
    // Cast is safe when storage type changes: the external storage container adapts to hold the new type
    const preservedExternalStorage = this.#getExternalStorage
      ? (this.#getExternalStorage as unknown as (context: {
          config: TConfig;
          options: TOptions;
          deps: TDeps;
        }) => RequestContextStorage<TNewRequestStorage>)
      : undefined;

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TThisContext,
      TNewRequestStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: initializer,
      // Reset context function since storage type changed - it must be reconfigured
      createRequestContext: undefined,
      getExternalStorage: preservedExternalStorage,
    });
  }

  /**
   * Use an externally-provided RequestContextStorage instance.
   * This allows multiple fragments to share the same storage instance.
   * Useful when fragments need to coordinate (e.g., database fragments sharing adapter storage).
   * Note: You must still call withRequestStorage to provide the initial storage data.
   *
   * @example
   * ```typescript
   * .withExternalRequestStorage(({ options }) =>
   *   options.databaseAdapter.contextStorage
   * )
   * .withRequestStorage(({ options }) => ({
   *   uow: options.databaseAdapter.db.createUnitOfWork()
   * }))
   * ```
   */
  withExternalRequestStorage<TNewStorage>(
    getStorage: (context: {
      config: TConfig;
      options: TOptions;
      deps: TDeps;
    }) => RequestContextStorage<TNewStorage>,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TNewStorage
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TThisContext,
      TNewStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      // Reset storage/context functions since storage type changed - they must be reconfigured
      createRequestStorage: undefined,
      createRequestContext: undefined,
      getExternalStorage: getStorage,
    });
  }

  /**
   * Set a request context for this fragment.
   * The context object should contain only methods or getters that read from storage.
   * This ensures proper per-request isolation via AsyncLocalStorage.
   *
   * @example
   * ```typescript
   * .withRequestThisContext(({ storage, options }) => ({
   *   get myNumber() { return storage.getStore()?.myNumber ?? 0; },
   *   getMyString() { return storage.getStore()?.myString ?? "default"; }
   * }))
   * ```
   */
  withRequestThisContext<TNewThisContext extends RequestThisContext>(
    fn: (
      context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
    ) => TNewThisContext,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TNewThisContext,
    TRequestStorage
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TNewThisContext,
      TRequestStorage
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createRequestContext: fn,
      getExternalStorage: this.#getExternalStorage,
    });
  }

  /**
   * Extend this builder with a transformation function.
   * This enables fluent API extensions like `.extend(withDatabase(schema))`.
   */
  extend<const TNewBuilder>(transformer: (builder: this) => TNewBuilder): TNewBuilder {
    return transformer(this);
  }

  /**
   * Build the final fragment definition
   */
  build(): NewFragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  > {
    return {
      name: this.#name,
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createRequestContext: this.#createRequestContext,
      getExternalStorage: this.#getExternalStorage,
    };
  }
}

/**
 * Create a new fragment definition builder
 */
export function defineFragment<
  TConfig = {},
  TOptions extends FragnoPublicConfig = FragnoPublicConfig,
  TThisContext extends RequestThisContext = RequestThisContext,
  TRequestStorage = {},
>(
  name: string,
): FragmentDefinitionBuilder<TConfig, TOptions, {}, {}, {}, {}, TThisContext, TRequestStorage> {
  return new FragmentDefinitionBuilder(name);
}
