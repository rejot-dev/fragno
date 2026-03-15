import type { PiSteeringMode } from "./constants";
import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiFragmentConfig,
  PiToolFactory,
  PiToolRegistry,
  PiToolSideEffectReducer,
  PiToolSideEffectReducerRegistry,
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

export const createPi = () => {
  const agents: PiAgentRegistry = {};
  const tools: PiToolRegistry = {};
  const toolSideEffectReducers: PiToolSideEffectReducerRegistry = {};
  let defaultSteeringMode: PiSteeringMode | undefined;
  let logging: PiFragmentConfig["logging"];

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
    toolSideEffectReducer(toolName: string, reducer: PiToolSideEffectReducer) {
      toolSideEffectReducers[toolName] = reducer;
      return builder;
    },
    toolSideEffectReducers(registry: PiToolSideEffectReducerRegistry) {
      Object.assign(toolSideEffectReducers, registry);
      return builder;
    },
    defaultSteeringMode(mode: PiSteeringMode) {
      defaultSteeringMode = mode;
      return builder;
    },
    logging(config: PiFragmentConfig["logging"]) {
      logging = config;
      return builder;
    },
    build(): PiRuntime {
      const agentsSnapshot = { ...agents };
      const toolsSnapshot = { ...tools };
      const reducersSnapshot = { ...toolSideEffectReducers };
      const config: PiFragmentConfig = {
        agents: agentsSnapshot,
        tools: toolsSnapshot,
        defaultSteeringMode,
        toolSideEffectReducers: reducersSnapshot,
        logging,
      };
      return {
        config,
        workflows: createPiWorkflows({
          agents: agentsSnapshot,
          tools: toolsSnapshot,
          toolSideEffectReducers: reducersSnapshot,
          logging,
        }),
      };
    },
  };

  return builder;
};
