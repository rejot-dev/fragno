import type { FragnoPublicConfig } from "./fragment-instantiation";

export interface FragmentDefinition<
  TConfig,
  TDeps = {},
  TServices extends Record<string, unknown> = {},
  TAdditionalContext extends Record<string, unknown> = {},
> {
  name: string;
  dependencies?: (config: TConfig, options: FragnoPublicConfig) => TDeps;
  services?: (config: TConfig, options: FragnoPublicConfig, deps: TDeps) => TServices;
  additionalContext?: TAdditionalContext;
}

export class FragmentBuilder<
  const TConfig,
  const TDeps = {},
  const TServices extends Record<string, unknown> = {},
  const TAdditionalContext extends Record<string, unknown> = {},
> {
  #definition: FragmentDefinition<TConfig, TDeps, TServices, TAdditionalContext>;

  constructor(definition: FragmentDefinition<TConfig, TDeps, TServices, TAdditionalContext>) {
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
  ): FragmentBuilder<TConfig, TNewDeps, {}, TAdditionalContext> {
    return new FragmentBuilder<TConfig, TNewDeps, {}, TAdditionalContext>({
      name: this.#definition.name,
      dependencies: (config: TConfig, options: FragnoPublicConfig) => {
        return fn({ config, fragnoConfig: options } as {
          config: TConfig;
          fragnoConfig: FragnoPublicConfig;
        } & TAdditionalContext);
      },
      services: undefined,
      additionalContext: this.#definition.additionalContext,
    });
  }

  withServices<TNewServices extends Record<string, unknown>>(
    fn: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
        deps: TDeps;
      } & TAdditionalContext,
    ) => TNewServices,
  ): FragmentBuilder<TConfig, TDeps, TNewServices, TAdditionalContext> {
    return new FragmentBuilder<TConfig, TDeps, TNewServices, TAdditionalContext>({
      name: this.#definition.name,
      dependencies: this.#definition.dependencies,
      services: (config: TConfig, options: FragnoPublicConfig, deps: TDeps) => {
        return fn({ config, fragnoConfig: options, deps } as {
          config: TConfig;
          fragnoConfig: FragnoPublicConfig;
          deps: TDeps;
        } & TAdditionalContext);
      },
      additionalContext: this.#definition.additionalContext,
    });
  }
}
export function defineFragment<TConfig = {}>(name: string): FragmentBuilder<TConfig, {}, {}, {}> {
  return new FragmentBuilder({
    name,
  });
}
