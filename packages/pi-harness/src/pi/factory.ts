import { WorkflowsLogger } from "@fragno-dev/workflows/debug-log";
import type { WorkflowRegistryEntry, WorkflowsRegistry } from "@fragno-dev/workflows/workflow";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { piRoutesFactory } from "../routes";
import { piHarnessDefinition } from "./definition";
import type { PiFragmentConfig } from "./types";

type PiFragmentServices = {
  workflows: WorkflowsFragmentServices;
};

type WorkflowsOptions = {
  logging?: PiFragmentConfig["logging"];
  workflows?: WorkflowRegistryEntry[];
};

export const createPiWorkflows = (options: WorkflowsOptions) => {
  if (options.logging) {
    WorkflowsLogger.configure(options.logging);
  }

  const registry: WorkflowsRegistry = {};

  for (const workflow of options.workflows ?? []) {
    if (registry[workflow.name]) {
      throw new Error(`Duplicate Pi workflow name '${workflow.name}'.`);
    }

    registry[workflow.name] = workflow;
  }

  return registry;
};

export function createPiFragment(
  config: PiFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
  services: PiFragmentServices,
) {
  return instantiate(piHarnessDefinition)
    .withConfig(config)
    .withRoutes([piRoutesFactory])
    .withOptions(options)
    .withServices(services)
    .build();
}

export const createPiHarness = createPiFragment;
