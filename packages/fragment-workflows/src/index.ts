import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import type { WorkflowsFragmentConfig, WorkflowsRegistry } from "./workflow";

const routes = [workflowsRoutesFactory] as const;

/** Create a workflows fragment with routes and database integration. */
export function createWorkflowsFragment<
  TRequestContext = never,
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
>(config: WorkflowsFragmentConfig<TRegistry>, fragnoConfig: FragnoPublicConfigWithDatabase) {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .withRequestContext<TRequestContext>()
    .build();

  return fragment as typeof fragment & { readonly __workflowsRegistry?: TRegistry };
}

export type WorkflowsFragment<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TRequestContext = never,
> = ReturnType<typeof createWorkflowsFragment<TRequestContext, TRegistry>>;

export type WorkflowsFragmentServices<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> =
  WorkflowsFragment<TRegistry>["services"];

export { validateWorkflowParams, workflowsFragmentDefinition } from "./definition";
export { workflowsRoutesFactory };
export { workflowsSchema };
export type {
  WorkflowsHistory,
  WorkflowsHistoryEmission,
  WorkflowsHistoryEvent,
  WorkflowsHistoryStep,
} from "./definition";
