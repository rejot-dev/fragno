import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiFragmentConfig,
  PiToolFactory,
  PiToolRegistry,
} from "./types";
import { createPiWorkflows, type PiWorkflowsRegistry } from "./workflow/workflow";

export type PiAgentDefinitionInput = Omit<PiAgentDefinition, "name"> & { name?: string };

export type PiRuntime = {
  config: PiFragmentConfig;
  workflows: PiWorkflowsRegistry;
};

export const defineAgent = (
  name: string,
  definition: PiAgentDefinitionInput,
): PiAgentDefinition => {
  if (definition.name && definition.name !== name) {
    throw new Error(`defineAgent name mismatch: expected ${name}, got ${definition.name}`);
  }
  return {
    ...definition,
    name,
  };
};

export class PiBuilder {
  readonly #agents: PiAgentRegistry = {};
  readonly #tools: PiToolRegistry = {};
  #logging: PiFragmentConfig["logging"];

  agent(definition: PiAgentDefinition): this {
    this.#agents[definition.name] = definition;
    return this;
  }

  agents(registry: PiAgentRegistry): this {
    Object.assign(this.#agents, registry);
    return this;
  }

  tool(name: string, tool: PiToolFactory): this {
    this.#tools[name] = tool;
    return this;
  }

  tools(registry: PiToolRegistry): this {
    Object.assign(this.#tools, registry);
    return this;
  }

  logging(config: PiFragmentConfig["logging"]): this {
    this.#logging = config;
    return this;
  }

  build(): PiRuntime {
    const agents = { ...this.#agents };
    const tools = { ...this.#tools };
    const config: PiFragmentConfig = {
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
