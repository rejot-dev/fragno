import { instantiate, type InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import type { WorkflowsFragmentConfig, WorkflowsRegistry } from "./workflow";

const routes = [workflowsRoutesFactory] as const;

type UntypedWorkflowsFragment = InstantiatedFragmentFromDefinition<
  typeof workflowsFragmentDefinition
>;

export type WorkflowsFragment<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> =
  UntypedWorkflowsFragment & { readonly __workflowsRegistry?: TRegistry };

export type WorkflowsFragmentServices<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> =
  WorkflowsFragment<TRegistry>["services"];

/** Create a workflows fragment with routes and database integration. */
export function createWorkflowsFragment<TRegistry extends WorkflowsRegistry = WorkflowsRegistry>(
  config: WorkflowsFragmentConfig<TRegistry>,
  fragnoConfig: FragnoPublicConfigWithDatabase,
): WorkflowsFragment<TRegistry> {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();

  return fragment as WorkflowsFragment<TRegistry>;
}

export { workflowsFragmentDefinition };
export { workflowsRoutesFactory };
export { workflowsSchema };
export { createWorkflowLiveStateStore } from "./live-state";
export type { WorkflowsHistory, WorkflowsHistoryEvent, WorkflowsHistoryStep } from "./definition";
export { defineWorkflow } from "./workflow";
export type { WorkflowDefinition } from "./workflow";
export * from "./workflow";
export type {
  WorkflowLiveStateObserver,
  WorkflowLiveStateService,
  WorkflowLiveStateSnapshot,
  WorkflowLiveStateSnapshotLookup,
  WorkflowLiveStateStore,
  WorkflowStepLiveStateSnapshot,
  WorkflowStepLiveStateShape,
} from "./live-state";
