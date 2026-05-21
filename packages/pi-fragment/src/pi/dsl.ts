import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiFragmentConfig,
  PiToolFactory,
  PiToolRegistry,
} from "./types";
import { createPiWorkflows, type PiWorkflowsRegistry } from "./workflow/workflow";

export type PiAgentDefinitionInput<TToolName extends string = string> = Omit<
  PiAgentDefinition,
  "name" | "tools"
> & {
  tools?: readonly TToolName[];
};

export type PiNamedAgentDefinition<
  TName extends string = string,
  TDefinition extends PiAgentDefinitionInput = PiAgentDefinitionInput,
> = TDefinition & { name: TName };

export type PiRuntime<
  TAgents extends PiAgentRegistry = PiAgentRegistry,
  TTools extends PiToolRegistry = PiToolRegistry,
> = {
  config: Omit<PiFragmentConfig, "agents" | "tools"> & {
    agents: TAgents;
    tools: TTools;
  };
  workflows: PiWorkflowsRegistry;
};

type ReplaceRegistryEntry<TRegistry, TName extends string, TValue> = Omit<TRegistry, TName> &
  Record<TName, TValue>;

export class PiBuilder<TAgents extends PiAgentRegistry = {}, TTools extends PiToolRegistry = {}> {
  readonly #agents: PiAgentRegistry = {};
  readonly #tools: PiToolRegistry = {};
  #logging: PiFragmentConfig["logging"];

  withAgent<
    TName extends string,
    const TDefinition extends PiAgentDefinitionInput<Extract<keyof TTools, string>>,
  >(
    name: TName,
    definition: TDefinition,
  ): PiBuilder<
    ReplaceRegistryEntry<TAgents, TName, PiNamedAgentDefinition<TName, TDefinition>>,
    TTools
  > {
    this.#agents[name] = { ...definition, name };
    return this as unknown as PiBuilder<
      ReplaceRegistryEntry<TAgents, TName, PiNamedAgentDefinition<TName, TDefinition>>,
      TTools
    >;
  }

  withTool<TName extends string, TTool extends PiToolFactory>(
    name: TName,
    tool: TTool,
  ): PiBuilder<TAgents, ReplaceRegistryEntry<TTools, TName, TTool>> {
    this.#tools[name] = tool;
    return this as unknown as PiBuilder<TAgents, ReplaceRegistryEntry<TTools, TName, TTool>>;
  }

  logging(config: PiFragmentConfig["logging"]): PiBuilder<TAgents, TTools> {
    this.#logging = config;
    return this;
  }

  build(): PiRuntime<TAgents, TTools> {
    const agents = { ...this.#agents } as TAgents;
    const tools = { ...this.#tools } as TTools;
    const config = {
      agents,
      tools,
      logging: this.#logging,
    };

    return {
      config,
      workflows: createPiWorkflows({
        agents,
        tools,
        logging: this.#logging,
      }),
    };
  }
}

export const createPi = (): PiBuilder => new PiBuilder();
