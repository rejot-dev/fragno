import { defineFragment } from "@fragno-dev/core";
import type { InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { workflowsFragmentDefinition } from "@fragno-dev/workflows";

import { workflowUsageSchema } from "./schema";
import type { WorkflowUsageAgentDefinition, WorkflowUsageSessionCompletedPayload } from "./dsl";

export interface WorkflowUsageConfig {
  agents: Record<string, WorkflowUsageAgentDefinition>;
  onSessionCompleted?: (payload: WorkflowUsageSessionCompletedPayload) => void | Promise<void>;
}

type WorkflowsService = InstantiatedFragmentFromDefinition<
  typeof workflowsFragmentDefinition
>["services"];

export type WorkflowUsageWorkflowsService = Pick<
  WorkflowsService,
  "createInstance" | "getInstanceStatus" | "sendEvent" | "listHistory"
>;

export type WorkflowUsageHooks = {
  onSessionCompleted: (payload: WorkflowUsageSessionCompletedPayload) => void;
};

/**
 * Type-only helper for passing to `forSchema(workflowUsageSchema, workflowUsageHooks)`
 * in contexts outside the fragment (e.g. workflow step callbacks) to get typed `triggerHook`.
 */
export const workflowUsageHooks = {} as WorkflowUsageHooks;

export const workflowUsageFragmentDefinition = defineFragment<WorkflowUsageConfig>(
  "workflow-usage-fragment",
)
  .extend(withDatabase(workflowUsageSchema))
  .provideHooks(({ defineHook, config }) => ({
    onSessionCompleted: defineHook(async function (payload: WorkflowUsageSessionCompletedPayload) {
      await config.onSessionCompleted?.(payload);
    }),
  }))
  .usesService<"workflows", WorkflowUsageWorkflowsService>("workflows")
  .build();
