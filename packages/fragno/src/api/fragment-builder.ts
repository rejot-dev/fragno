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
  TServices extends Record<string, unknown> = {},
  TAdditionalContext extends Record<string, unknown> = {},
  TUsedServices extends Record<string, unknown> = {},
  TProvidedServices extends Record<string, unknown> = {},
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
  /** Services that this fragment provides to other fragments */
  providedServices?: {
    [K in keyof TProvidedServices]: TProvidedServices[K];
  };
}

export class FragmentBuilder<
  const TConfig,
  const TDeps = {},
  const TServices extends Record<string, unknown> = {},
  const TAdditionalContext extends Record<string, unknown> = {},
  const TUsedServices extends Record<string, unknown> = {},
  const TProvidedServices extends Record<string, unknown> = {},
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
      providedServices: this.#definition.providedServices,
    });
  }

  withServices<TNewServices extends Record<string, unknown>>(
    fn: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
        deps: TDeps & TUsedServices;
      } & TAdditionalContext,
    ) => TNewServices,
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TNewServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices,
    TThisContext
  > {
    return new FragmentBuilder<
      TConfig,
      TDeps,
      TNewServices,
      TAdditionalContext,
      TUsedServices,
      TProvidedServices,
      TThisContext
    >({
      name: this.#definition.name,
      dependencies: this.#definition.dependencies,
      services: (config: TConfig, options: FragnoPublicConfig, deps: TDeps & TUsedServices) => {
        return fn({ config, fragnoConfig: options, deps } as {
          config: TConfig;
          fragnoConfig: FragnoPublicConfig;
          deps: TDeps & TUsedServices;
        } & TAdditionalContext);
      },
      additionalContext: this.#definition.additionalContext,
      usedServices: this.#definition.usedServices,
      providedServices: this.#definition.providedServices,
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
   *   .withServices(({ deps }) => ({
   *     sendWelcome: () => deps.email.send(...)
   *   }))
   *
   * // Optional service
   * defineFragment("my-fragment")
   *   .usesService<"email", IEmailService>("email", { optional: true })
   *   .withServices(({ deps }) => ({
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
   * Provide a named service that other fragments can use.
   *
   * @example
   * ```ts
   * interface IEmailService {
   *   send(to: string, subject: string, body: string): Promise<void>;
   * }
   *
   * defineFragment("email-fragment")
   *   .providesService<"email", IEmailService>("email", {
   *     send: async (to, subject, body) => {
   *       // implementation
   *     }
   *   })
   * ```
   */
  providesService<TServiceName extends string, TService>(
    serviceName: TServiceName,
    implementation: TService,
  ): FragmentBuilder<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TUsedServices,
    TProvidedServices & { [K in TServiceName]: TService },
    TThisContext
  > {
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
      providedServices: {
        ...this.#definition.providedServices,
        [serviceName]: implementation,
      } as {
        [K in keyof (TProvidedServices & { [K in TServiceName]: TService })]: (TProvidedServices & {
          [K in TServiceName]: TService;
        })[K];
      },
    });
  }
}
export function defineFragment<TConfig = {}>(
  name: string,
): FragmentBuilder<TConfig, {}, {}, {}, {}, {}, RequestThisContext> {
  return new FragmentBuilder({
    name,
  });
}
