import { WorkflowsLogger } from "@fragno-dev/workflows/debug-log";
import { type WorkflowsRegistry } from "@fragno-dev/workflows/workflow";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { PiLogger } from "../debug-log";
import { piRoutesFactory } from "../routes";
import { piFragmentDefinition } from "./definition";
import type { PiWorkflowDefinition } from "./dsl";
import { compilePiWorkflow } from "./dsl";
import type { PiSkillRegistry } from "./skills";
import type { PiAgentRegistry, PiFragmentConfig, PiToolRegistry } from "./types";
import { type PiAgentRunner } from "./workflow/pi-agent-step";

export type { PiAgentRunner };

type PiFragmentServices = {
  workflows: WorkflowsFragmentServices;
};

type WorkflowsOptions = {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  skills?: PiSkillRegistry;
  logging?: PiFragmentConfig["logging"];
  agentRunner?: PiAgentRunner;
  workflows?: PiWorkflowDefinition[];
};

export const createPiWorkflows = (options: WorkflowsOptions) => {
  PiLogger.reset();
  if (options.logging) {
    PiLogger.configure(options.logging);
    WorkflowsLogger.configure(options.logging);
  }

  const registry: WorkflowsRegistry = {};

  for (const workflow of options.workflows ?? []) {
    if (workflow.name in registry) {
      throw new Error(`Duplicate Pi workflow name '${workflow.name}'.`);
    }
    registry[workflow.name] = compilePiWorkflow(workflow, options);
  }

  return registry;
};

export function createPiFragment(
  config: PiFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
  services: PiFragmentServices,
) {
  return instantiate(piFragmentDefinition)
    .withConfig(config)
    .withRoutes([piRoutesFactory])
    .withOptions(options)
    .withServices(services)
    .build();
}
