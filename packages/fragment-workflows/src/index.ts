import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import type { WorkflowsFragmentConfig, WorkflowsRegistry } from "./workflow";

const routes = [workflowsRoutesFactory] as const;

/** Create a workflows fragment with routes and database integration. */
export function createWorkflowsFragment<TRegistry extends WorkflowsRegistry>(
  config: WorkflowsFragmentConfig<TRegistry>,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();

  return fragment;
}

export { workflowsFragmentDefinition };
export { workflowsRoutesFactory };
export { workflowsSchema };
export type { WorkflowsHistory, WorkflowsHistoryEvent, WorkflowsHistoryStep } from "./definition";
export { defineWorkflow } from "./workflow";
export type { WorkflowDefinition } from "./workflow";
export * from "./workflow";
