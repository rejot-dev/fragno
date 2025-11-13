import type { RequestThisContext } from "./api";
import type { FragnoPublicConfig } from "./fragment-instantiation";

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

  // Request context creation
  createRequestContext?: (options: TOptions) => {
    thisContext: TThisContext;
    wrapRequest: <T>(callback: () => Promise<T>) => Promise<T>;
  };
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
  #createRequestContext?: (options: TOptions) => {
    thisContext: TThisContext;
    wrapRequest: <T>(cb: () => Promise<T>) => Promise<T>;
  };

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
      createRequestContext?: (options: TOptions) => {
        thisContext: TThisContext;
        wrapRequest: <T>(cb: () => Promise<T>) => Promise<T>;
      };
    },
  ) {
    this.#name = name;
    if (state) {
      this.#dependencies = state.dependencies;
      this.#baseServices = state.baseServices;
      this.#namedServices = state.namedServices;
      this.#serviceDependencies = state.serviceDependencies;
      this.#createRequestContext = state.createRequestContext;
    }
  }

  get name(): string {
    return this.#name;
  }

  /**
   * Define dependencies for this fragment.
   * Dependencies are available to services and handlers.
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
    TThisContext
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TNewDeps,
      {},
      {},
      TServiceDependencies,
      TThisContext
    >(this.#name, {
      dependencies: fn,
      baseServices: undefined,
      namedServices: undefined,
      serviceDependencies: this.#serviceDependencies,
      createRequestContext: this.#createRequestContext,
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
    TThisContext
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TNewService,
      TServices,
      TServiceDependencies,
      TThisContext
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: fn,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
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
    TThisContext
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
      TThisContext
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: newNamedServices,
      serviceDependencies: this.#serviceDependencies,
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
    TThisContext
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
      TThisContext
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: newServiceDependencies,
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
    TThisContext
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
      TThisContext
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: newServiceDependencies,
      createRequestContext: this.#createRequestContext,
    });
  }

  /**
   * Set the request context factory for this fragment.
   * The request context provides the `this` context for route handlers and services.
   */
  withRequestContext<TNewThisContext extends RequestThisContext>(
    fn: (options: TOptions) => {
      thisContext: TNewThisContext;
      wrapRequest: <T>(cb: () => Promise<T>) => Promise<T>;
    },
  ): FragmentDefinitionBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TNewThisContext
  > {
    return new FragmentDefinitionBuilder<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TNewThisContext
    >(this.#name, {
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestContext: fn,
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
    TThisContext
  > {
    return {
      name: this.#name,
      dependencies: this.#dependencies,
      baseServices: this.#baseServices,
      namedServices: this.#namedServices,
      serviceDependencies: this.#serviceDependencies,
      createRequestContext: this.#createRequestContext,
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
>(name: string): FragmentDefinitionBuilder<TConfig, TOptions, {}, {}, {}, {}, TThisContext> {
  return new FragmentDefinitionBuilder(name);
}
