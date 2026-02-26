import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiFragmentConfig,
  PiToolFactory,
  PiToolRegistry,
} from "./types";
import type { PiSteeringMode } from "./constants";
import { createPiWorkflows, type PiWorkflowsRegistry } from "./workflow";

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

export const createPi = () => {
  const agents: PiAgentRegistry = {};
  const tools: PiToolRegistry = {};
  let defaultSteeringMode: PiSteeringMode | undefined;

  const builder = {
    agent(definition: PiAgentDefinition) {
      agents[definition.name] = definition;
      return builder;
    },
    agents(registry: PiAgentRegistry) {
      Object.assign(agents, registry);
      return builder;
    },
    tool(name: string, tool: PiToolFactory) {
      tools[name] = tool;
      return builder;
    },
    tools(registry: PiToolRegistry) {
      Object.assign(tools, registry);
      return builder;
    },
    defaultSteeringMode(mode: PiSteeringMode) {
      defaultSteeringMode = mode;
      return builder;
    },
    build(): PiRuntime {
      const agentsSnapshot = { ...agents };
      const toolsSnapshot = { ...tools };
      const config: PiFragmentConfig = {
        agents: agentsSnapshot,
        tools: toolsSnapshot,
        defaultSteeringMode,
      };
      return {
        config,
        workflows: createPiWorkflows({ agents: agentsSnapshot, tools: toolsSnapshot }),
      };
    },
  };

  return builder;
};
