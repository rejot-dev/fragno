import type { RequestThisContext } from "./api";
import type { FragnoPublicConfig } from "./fragment-instantiation";
import type { RequestInputContext } from "./request-input-context";
import type { RequestOutputContext } from "./request-output-context";

/**
 * Metadata for a service dependency
 */
interface ServiceMetadata {
  /** Name of the service */
  name: string;
  /** Whether this service is required (false means optional) */
  required: boolean;
}

export type RouteHandler = (
  this: RequestThisContext,
  inputContext: RequestInputContext,
  outputContext: RequestOutputContext,
) => Promise<Response>;

export interface FragmentDefinition<
  TConfig,
  TDeps = {},
  TServices = {},
  TAdditionalContext extends Record<string, unknown> = {},
  TUsedServices = {},
  TProvidedServices = {},
  TThisContext extends RequestThisContext = RequestThisContext,
> {
  name: string;
  dependencies?: (config: TConfig, options: FragnoPublicConfig) => TDeps;
  services?: (
    config: TConfig,
    options: FragnoPublicConfig,
    deps: TDeps & TUsedServices,
  ) => TServices;
  additionalContext?: TAdditionalContext;
  createHandlerWrapper?: (
    options: FragnoPublicConfig,
  ) => (
    handler: (this: TThisContext, ...args: Parameters<RouteHandler>) => ReturnType<RouteHandler>,
  ) => RouteHandler;
  /** Services that this fragment uses (can be required or optional) */
  usedServices?: {
    [K in keyof TUsedServices]: ServiceMetadata;
  };
  /** Services that this fragment provides to other fragments (can be a factory function or direct object) */
  providedServices?:
    | {
        [K in keyof TProvidedServices]: TProvidedServices[K];
      }
    | ((
        config: TConfig,
        options: FragnoPublicConfig,
        deps: TDeps & TUsedServices,
      ) => TProvidedServices);
}

export class FragmentBuilder<
  const TConfig,
  const TDeps = {},
  const TServices = {},
  const TAdditionalContext extends Record<string, unknown> = {},
  const TUsedServices = {},
  const TProvidedServices = {},
  const TThisContext extends RequestThisContext = RequestThisContext,
> {
  #definition: FragmentDefinition<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices,
    TThisContext
  >;

  constructor(
    definition: FragmentDefinition<
      TConfig,
      TDeps,
      TServices,
      TAdditionalContext,
      TUsedServices,
      TProvidedServices,
      TThisContext
    >,
  ) {
    this.#definition = definition;
  }

  get definition() {
    return this.#definition;
  }

  get $requiredOptions(): FragnoPublicConfig {
    throw new Error("Type only method. Do not call.");
  }

  withDependencies<TNewDeps>(
    fn: (
      context: { config: TConfig; fragnoConfig: FragnoPublicConfig } & TAdditionalContext,
    ) => TNewDeps,
  ): FragmentBuilder<
    TConfig,
    TNewDeps,
    {},
    TAdditionalContext,
    TUsedServices,
    TProvidedServices,
    TThisContext
  > {
    // Safe cast: If providedServices is a function, we need to update its signature to use TNewDeps.
    // This is safe because the function will be called with the new deps at runtime.
    const providedServices = this.#definition.providedServices;
    const recastProvidedServices =
      typeof providedServices === "function"
        ? (providedServices as unknown as (
            config: TConfig,
            options: FragnoPublicConfig,
            deps: TNewDeps & TUsedServices,
          ) => TProvidedServices)
        : providedServices;

    return new FragmentBuilder<
      TConfig,
      TNewDeps,
      {},
      TAdditionalContext,
      TUsedServices,
      TProvidedServices,
      TThisContext
    >({
      name: this.#definition.name,
      dependencies: (config: TConfig, options: FragnoPublicConfig) => {
        return fn({ config, fragnoConfig: options } as {
          config: TConfig;
          fragnoConfig: FragnoPublicConfig;
        } & TAdditionalContext);
      },
      services: undefined,
      additionalContext: this.#definition.additionalContext,
      usedServices: this.#definition.usedServices,
      providedServices: recastProvidedServices,
    });
  }

  /**
   * Declare that this fragment uses a service.
   * By default, the service is required. Pass { optional: true } to make it optional.
   *
   * @example
   * ```ts
   * // Required service
   * defineFragment("my-fragment")
   *   .usesService<"email", IEmailService>("email")
   *   .providesService(({ deps, define }) => define({
   *     sendWelcome: () => deps.email.send(...)
   *   }))
   *
   * // Optional service
   * defineFragment("my-fragment")
   *   .usesService<"email", IEmailService>("email", { optional: true })
   *   .providesService(({ deps, define }) => define({
   *     sendWelcome: () => {
   *       if (deps.email) {
   *         deps.email.send(...)
   *       }
   *     }
   *   }))
   * ```
   */
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    options?: { optional?: false },
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices & { [K in TServiceName]: TService },
    TProvidedServices,
    TThisContext
  >;
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    options: { optional: true },
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices & { [K in TServiceName]: TService | undefined },
    TProvidedServices,
    TThisContext
  >;
  usesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    options?: { optional?: boolean },
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices & { [K in TServiceName]: TService | TService | undefined },
    TProvidedServices,
    TThisContext
  > {
    const isOptional = options?.optional ?? false;
    return new FragmentBuilder<
      TConfig,
      TDeps,
      TServices,
      TAdditionalContext,
      TUsedServices & { [K in TServiceName]: TService | (TService | undefined) },
      TProvidedServices,
      TThisContext
    >({
      name: this.#definition.name,
      dependencies: this.#definition.dependencies,
      services: this.#definition.services as
        | ((
            config: TConfig,
            options: FragnoPublicConfig,
            deps: TDeps &
              (TUsedServices & { [K in TServiceName]: TService | (TService | undefined) }),
          ) => TServices)
        | undefined,
      additionalContext: this.#definition.additionalContext,
      usedServices: {
        ...this.#definition.usedServices,
        [serviceName]: { name: serviceName, required: !isOptional },
      } as {
        [K in keyof (TUsedServices & {
          [K in TServiceName]: TService | (TService | undefined);
        })]: ServiceMetadata;
      },
      providedServices: this.#definition.providedServices,
    });
  }

  /**
   * Define services for this fragment (unnamed) using a callback.
   * Use the `defineService` function from the callback context for proper typing (optional).
   */
  providesService<TNewServices>(
    fn: (context: {
      config: TConfig;
      fragnoConfig: FragnoPublicConfig;
      deps: TDeps & TUsedServices;
      defineService: <T>(services: T) => T;
    }) => TNewServices,
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TNewServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices,
    TThisContext
  >;

  /**
   * Define services for this fragment (unnamed) using a direct object.
   */
  providesService<TNewServices>(
    services: TNewServices,
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TNewServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices,
    TThisContext
  >;

  /**
   * Provide a named service using a callback.
   * Use the `defineService` function from the callback context for proper typing (optional).
   *
   * @example
   * ```ts
   * interface IEmailService {
   *   send(to: string, subject: string, body: string): Promise<void>;
   * }
   *
   * defineFragment("email-fragment")
   *   .providesService<"email", IEmailService>("email", ({ defineService }) => defineService({
   *     send: async (to, subject, body) => {
   *       // implementation
   *     }
   *   }))
   * ```
   */
  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    fn: (context: {
      config: TConfig;
      fragnoConfig: FragnoPublicConfig;
      deps: TDeps & TUsedServices;
      defineService: <T>(services: T) => T;
    }) => TService,
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices & { [K in TServiceName]: TService },
    TThisContext
  >;

  /**
   * Provide a named service using a direct object.
   */
  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    service: TService,
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices & { [K in TServiceName]: TService },
    TThisContext
  >;

  providesService<TServiceName extends string, TService>(
    ...args:
      | [
          fnOrServices:
            | ((context: {
                config: TConfig;
                fragnoConfig: FragnoPublicConfig;
                deps: TDeps & TUsedServices;
                defineService: <T>(services: T) => T;
              }) => TService)
            | TService,
        ]
      | [
          serviceName: TServiceName,
          fnOrService:
            | ((context: {
                config: TConfig;
                fragnoConfig: FragnoPublicConfig;
                deps: TDeps & TUsedServices;
                defineService: <T>(services: T) => T;
              }) => TService)
            | TService,
        ]
  ):
    | FragmentBuilder<
        TConfig,
        TDeps,
        TService,
        TAdditionalContext,
        TUsedServices,
        TProvidedServices,
        TThisContext
      >
    | FragmentBuilder<
        TConfig,
        TDeps,
        TServices,
        TAdditionalContext,
        TUsedServices,
        TProvidedServices & { [K in TServiceName]: TService },
        TThisContext
      > {
    // The defineService function is just an identity function at runtime
    const defineService = <T>(services: T) => services;

    if (args.length === 1) {
      // Unnamed service
      const [fnOrServices] = args;

      // Create a callback that provides the full context including defineService
      const servicesCallback = (
        config: TConfig,
        options: FragnoPublicConfig,
        deps: TDeps & TUsedServices,
      ): TService => {
        if (typeof fnOrServices === "function") {
          // It's a factory function - call it with context
          const fn = fnOrServices as (context: {
            config: TConfig;
            fragnoConfig: FragnoPublicConfig;
            deps: TDeps & TUsedServices;
            defineService: <T>(services: T) => T;
          }) => TService;
          return fn({
            config,
            fragnoConfig: options,
            deps,
            defineService,
          });
        } else {
          // It's a direct service object
          return fnOrServices;
        }
      };

      return new FragmentBuilder<
        TConfig,
        TDeps,
        TService,
        TAdditionalContext,
        TUsedServices,
        TProvidedServices,
        TThisContext
      >({
        name: this.#definition.name,
        dependencies: this.#definition.dependencies,
        services: servicesCallback as (
          config: TConfig,
          options: FragnoPublicConfig,
          deps: TDeps & TUsedServices,
        ) => TService,
        additionalContext: this.#definition.additionalContext,
        usedServices: this.#definition.usedServices,
        providedServices: this.#definition.providedServices,
      });
    } else {
      // Named service
      const [serviceName, fnOrService] = args;

      // Create a callback that provides the full context including defineService
      const createService = (
        config: TConfig,
        options: FragnoPublicConfig,
        deps: TDeps & TUsedServices,
      ): TService => {
        if (typeof fnOrService === "function") {
          // It's a factory function - call it with context
          const fn = fnOrService as (context: {
            config: TConfig;
            fragnoConfig: FragnoPublicConfig;
            deps: TDeps & TUsedServices;
            defineService: <T>(services: T) => T;
          }) => TService;
          return fn({
            config,
            fragnoConfig: options,
            deps,
            defineService,
          });
        } else {
          // It's a direct service object
          return fnOrService;
        }
      };

      // We need to handle both function and object forms of providedServices
      const existingProvidedServices = this.#definition.providedServices;
      const newProvidedServices:
        | {
            [K in keyof (TProvidedServices & {
              [K in TServiceName]: TService;
            })]: (TProvidedServices & {
              [K in TServiceName]: TService;
            })[K];
          }
        | ((
            config: TConfig,
            options: FragnoPublicConfig,
            deps: TDeps & TUsedServices,
          ) => TProvidedServices & { [K in TServiceName]: TService }) =
        typeof existingProvidedServices === "function"
          ? // If existing is a function, create a new function that calls both
            (config: TConfig, options: FragnoPublicConfig, deps: TDeps & TUsedServices) => {
              const existing = existingProvidedServices(config, options, deps);
              const newService = createService(config, options, deps);
              return {
                ...existing,
                [serviceName]: newService,
              } as TProvidedServices & { [K in TServiceName]: TService };
            }
          : // If existing is an object or undefined, spread it
            ({
              ...existingProvidedServices,
              [serviceName]: createService,
            } as {
              [K in keyof (TProvidedServices & {
                [K in TServiceName]: TService;
              })]: (TProvidedServices & {
                [K in TServiceName]: TService;
              })[K];
            });

      return new FragmentBuilder<
        TConfig,
        TDeps,
        TServices,
        TAdditionalContext,
        TUsedServices,
        TProvidedServices & { [K in TServiceName]: TService },
        TThisContext
      >({
        name: this.#definition.name,
        dependencies: this.#definition.dependencies,
        services: this.#definition.services,
        additionalContext: this.#definition.additionalContext,
        usedServices: this.#definition.usedServices,
        providedServices: newProvidedServices,
      });
    }
  }
}
export function defineFragment<TConfig = {}>(
  name: string,
): FragmentBuilder<TConfig, {}, {}, {}, {}, {}, RequestThisContext> {
  return new FragmentBuilder({
    name,
  });
}
