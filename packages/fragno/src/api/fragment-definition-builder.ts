import type { RequestThisContext } from "./api";
import type { FragnoPublicConfig } from "./shared-types";
import type { RequestContextStorage } from "./request-context-storage";
import type { AnyRouteOrFactory } from "./route";

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
  TPrivateServices,
  TServiceThisContext extends RequestThisContext,
> = {
  config: TConfig;
  options: TOptions;
  deps: TDeps;
  serviceDeps: TServiceDependencies;
  privateServices: TPrivateServices;
  /**
   * Helper to define services with proper `this` context typing.
   * Use this to wrap your service methods when they need access to `this`.
   */
  defineService: <T>(svc: T & ThisType<TServiceThisContext>) => T;
};

/**
 * Service constructor function type
 */
export type ServiceConstructorFn<
  TConfig,
  TOptions,
  TDeps,
  TServiceDependencies,
  TPrivateServices,
  TService,
  TServiceThisContext extends RequestThisContext,
> = (
  context: ServiceContext<
    TConfig,
    TOptions,
    TDeps,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext
  >,
) => TService;

/**
 * Fragment definition interface that supports both regular and database fragments.
 * This is the core definition that will be used for fragment instantiation.
 */
export interface FragmentDefinition<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TPrivateServices,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage = {},
  TInternalRoutes extends readonly AnyRouteOrFactory[] = readonly [],
> {
  name: string;

  // Core callbacks - all take context objects with separate deps and serviceDeps
  dependencies?: (context: { config: TConfig; options: TOptions }) => TDeps;

  baseServices?: ServiceConstructorFn<
    TConfig,
    TOptions,
    TDeps,
    TServiceDependencies,
    TPrivateServices,
    TBaseServices,
    TServiceThisContext
  >;

  // Named services stored as factory functions
  namedServices?: {
    [K in keyof TServices]: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TServices[K],
      TServiceThisContext
    >;
  };

  // Private services - only accessible internally when defining other services
  privateServices?: {
    [K in keyof TPrivateServices]: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TPrivateServices, // Private services can access other private services
      TPrivateServices[K],
      TServiceThisContext
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
   * Optional factory function to create the this contexts for services and handlers.
   * Returns separate contexts: serviceContext (may be restricted) and handlerContext (full access).
   * Both contexts should contain only methods or getters that read from storage.
   *
   * @example
   * ```ts
   * createThisContext: ({ storage }) => ({
   *   serviceContext: {
   *     getUnitOfWork: () => restrictedUOW  // Without execute methods
   *   },
   *   handlerContext: {
   *     getUnitOfWork: () => fullUOW  // With execute methods
   *   }
   * })
   * ```
   */
  createThisContext?: (
    context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
  ) => {
    serviceContext: TServiceThisContext;
    handlerContext: THandlerThisContext;
  };

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

  /**
   * Optional factory for internal data attached to fragment.$internal.
   */
  internalDataFactory?: (context: {
    config: TConfig;
    options: TOptions;
    deps: TDeps;
  }) => Record<string, unknown> | void;

  internalRoutes?: TInternalRoutes;

  $serviceThisContext?: TServiceThisContext;
  $handlerThisContext?: THandlerThisContext;
  $requestStorage?: TRequestStorage;
  $internalRoutes?: TInternalRoutes;
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
  TPrivateServices,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage = {},
  TInternalRoutes extends readonly AnyRouteOrFactory[] = readonly [],
> {
  #name: string;
  #dependencies?: (context: { config: TConfig; options: TOptions }) => TDeps;
  #baseServices?: ServiceConstructorFn<
    TConfig,
    TOptions,
    TDeps,
    TServiceDependencies,
    TPrivateServices,
    TBaseServices,
    TServiceThisContext
  >;
  #namedServices?: {
    [K in keyof TServices]: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TServices[K],
      TServiceThisContext
    >;
  };
  #privateServices?: {
    [K in keyof TPrivateServices]: ServiceConstructorFn<
      TConfig,
      TOptions,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TPrivateServices[K],
      TServiceThisContext
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
  #createThisContext?: (
    context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
  ) => {
    serviceContext: TServiceThisContext;
    handlerContext: THandlerThisContext;
  };
  #getExternalStorage?: (context: {
    config: TConfig;
    options: TOptions;
    deps: TDeps;
  }) => RequestContextStorage<TRequestStorage>;
  #internalRoutes?: TInternalRoutes;

  constructor(
    name: string,
    state?: {
      dependencies?: (context: { config: TConfig; options: TOptions }) => TDeps;
      baseServices?: ServiceConstructorFn<
        TConfig,
        TOptions,
        TDeps,
        TServiceDependencies,
        TPrivateServices,
        TBaseServices,
        TServiceThisContext
      >;
      namedServices?: {
        [K in keyof TServices]: ServiceConstructorFn<
          TConfig,
          TOptions,
          TDeps,
          TServiceDependencies,
          TPrivateServices,
          TServices[K],
          TServiceThisContext
        >;
      };
      privateServices?: {
        [K in keyof TPrivateServices]: ServiceConstructorFn<
          TConfig,
          TOptions,
          TDeps,
          TServiceDependencies,
          TPrivateServices,
          TPrivateServices[K],
          TServiceThisContext
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
      createThisContext?: (
        context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>,
      ) => {
        serviceContext: TServiceThisContext;
        handlerContext: THandlerThisContext;
      };
      getExternalStorage?: (context: {
        config: TConfig;
        options: TOptions;
        deps: TDeps;
      }) => RequestContextStorage<TRequestStorage>;
      internalRoutes?: TInternalRoutes;
    },
  ) {
    this.#name = name;
    if (state) {
      this.#dependencies = state.dependencies;
      this.#baseServices = state.baseServices;
      this.#namedServices = state.namedServices;
      this.#privateServices = state.privateServices;
      this.#serviceDependencies = state.serviceDependencies;
      this.#createRequestStorage = state.createRequestStorage;
      this.#createThisContext = state.createThisContext;
      this.#getExternalStorage = state.getExternalStorage;
      this.#internalRoutes = state.internalRoutes;
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
    {},
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TInternalRoutes
  > {
    // Warn if we're discarding existing configuration
    if (
      this.#baseServices ||
      this.#namedServices ||
      this.#privateServices ||
      this.#createRequestStorage ||
      this.#createThisContext ||
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
      {},
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: fn,
      baseServices: undefined,
      namedServices: undefined,
      privateServices: undefined,
      serviceDependencies: this.#serviceDependencies,
      // Reset storage/context functions since deps type changed - they must be reconfigured
      createRequestStorage: undefined,
      createThisContext: undefined,
      getExternalStorage: undefined,
      internalRoutes: this.#internalRoutes,
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
      TPrivateServices,
      TNewService,
      TServiceThisContext
    >,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TNewService,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TInternalRoutes
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TNewService,
      TServices,
      TServiceDependencies,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: fn,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      getExternalStorage: this.#getExternalStorage,
      internalRoutes: this.#internalRoutes,
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
      TPrivateServices,
      TService,
      TServiceThisContext
    >,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices & { [K in TServiceName]: TService },
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TInternalRoutes
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
        TPrivateServices,
        (TServices & { [K in TServiceName]: TService })[K],
        TServiceThisContext
      >;
    };

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices & { [K in TServiceName]: TService },
      TServiceDependencies,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: newNamedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      getExternalStorage: this.#getExternalStorage,
      internalRoutes: this.#internalRoutes,
    });
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
      TOptions,
      TDeps,
      TServiceDependencies,
      TPrivateServices,
      TService,
      TServiceThisContext
    >,
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices & { [K in TServiceName]: TService },
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TInternalRoutes
  > {
    // Type assertion needed because TypeScript can't verify object spread with mapped types
    const newPrivateServices = {
      ...this.#privateServices,
      [serviceName]: fn,
    } as {
      [K in keyof (TPrivateServices & { [K in TServiceName]: TService })]: ServiceConstructorFn<
        TConfig,
        TOptions,
        TDeps,
        TServiceDependencies,
        TPrivateServices & { [K in TServiceName]: TService },
        (TPrivateServices & { [K in TServiceName]: TService })[K],
        TServiceThisContext
      >;
    };

    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TPrivateServices & { [K in TServiceName]: TService },
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: newPrivateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      internalRoutes: this.#internalRoutes,
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
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TInternalRoutes
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
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: newServiceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      internalRoutes: this.#internalRoutes,
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
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TInternalRoutes
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
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: newServiceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      internalRoutes: this.#internalRoutes,
    });
  }

  /**
   * Define the type and initial data stored in AsyncLocalStorage for per-request isolation.
   * This should be called before withThisContext if you need to store request-specific data.
   *
   * @param initializer Function that returns the initial storage data for each request
   *
   * @example
   * ```typescript
   * .withRequestStorage(({ config, options, deps }) => ({
   *   counter: 0,
   *   userId: deps.currentUserId
   * }))
   * .withThisContext(({ storage }) => ({
   *   serviceContext: {
   *     get counter() { return storage.getStore()!.counter; }
   *   },
   *   handlerContext: {
   *     get counter() { return storage.getStore()!.counter; }
   *   }
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
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TNewRequestStorage,
    TInternalRoutes
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
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TNewRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: initializer,
      // Reset context function since storage type changed - it must be reconfigured
      createThisContext: undefined,
      getExternalStorage: preservedExternalStorage,
      internalRoutes: this.#internalRoutes,
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
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TNewStorage,
    TInternalRoutes
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TNewStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      // Reset storage/context functions since storage type changed - they must be reconfigured
      createRequestStorage: undefined,
      createThisContext: undefined,
      getExternalStorage: getStorage,
      internalRoutes: this.#internalRoutes,
    });
  }

  /**
   * Set the this contexts for services and handlers in this fragment.
   * Both contexts should contain only methods or getters that read from storage.
   * This ensures proper per-request isolation via AsyncLocalStorage.
   *
   * @example
   * ```ts
   * .withThisContext(({ storage }) => ({
   *   serviceContext: {
   *     get myNumber() { return storage.getStore()?.myNumber ?? 0; }
   *   },
   *   handlerContext: {
   *     get myNumber() { return storage.getStore()?.myNumber ?? 0; }
   *   }
   * }))
   * ```
   */
  withThisContext<
    TNewServiceThisContext extends RequestThisContext,
    TNewHandlerThisContext extends RequestThisContext,
  >(
    fn: (context: RequestContextFactoryContext<TConfig, TOptions, TDeps, TRequestStorage>) => {
      serviceContext: TNewServiceThisContext;
      handlerContext: TNewHandlerThisContext;
    },
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TNewServiceThisContext,
    TNewHandlerThisContext,
    TRequestStorage,
    TInternalRoutes
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TPrivateServices,
      TNewServiceThisContext,
      TNewHandlerThisContext,
      TRequestStorage,
      TInternalRoutes
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: fn,
      getExternalStorage: this.#getExternalStorage,
      internalRoutes: this.#internalRoutes,
    });
  }

  /**
   * Define internal routes that will be mounted under /_internal.
   */
  withInternalRoutes<const TNewInternalRoutes extends readonly AnyRouteOrFactory[]>(
    routes: TNewInternalRoutes,
  ): FragmentDefinitionBuilder<
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
    TNewInternalRoutes
  > {
    return new FragmentDefinitionBuilder(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      getExternalStorage: this.#getExternalStorage,
      internalRoutes: routes,
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
  build(): FragmentDefinition<
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
  > {
    return {
      name: this.#name,
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      privateServices: this.#privateServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestStorage: this.#createRequestStorage,
      createThisContext: this.#createThisContext,
      getExternalStorage: this.#getExternalStorage,
      internalRoutes: this.#internalRoutes,
    };
  }
}

/**
 * Create a new fragment definition builder
 */
export function defineFragment<
  TConfig = {},
  TOptions extends FragnoPublicConfig = FragnoPublicConfig,
  TServiceThisContext extends RequestThisContext = RequestThisContext,
  THandlerThisContext extends RequestThisContext = RequestThisContext,
  TRequestStorage = {},
>(
  name: string,
): FragmentDefinitionBuilder<
  TConfig,
  TOptions,
  {},
  {},
  {},
  {},
  {},
  TServiceThisContext,
  THandlerThisContext,
  TRequestStorage,
  []
> {
  return new FragmentDefinitionBuilder(name);
}
