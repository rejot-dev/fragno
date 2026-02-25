import { instantiate } from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import type { WorkflowUsageAgentDefinition } from "./dsl";
import {
  workflowUsageFragmentDefinition,
  type WorkflowUsageConfig,
  type WorkflowUsageWorkflowsService,
} from "./definition";
import { workflowUsageRoutesFactory } from "./routes";
import { dslWorkflow, INTERNAL_WORKFLOW_NAME } from "./workflow";

export type {
  WorkflowUsageAgentDefinition,
  WorkflowUsageAgentDsl,
  WorkflowUsageDslCalcStep,
  WorkflowUsageDslRandomStep,
  WorkflowUsageDslState,
  WorkflowUsageDslStep,
  WorkflowUsageDslWaitStep,
  WorkflowUsageDuration,
  WorkflowUsageSessionCompletedPayload,
} from "./dsl";

export type {
  WorkflowUsageConfig,
  WorkflowUsageHooks,
  WorkflowUsageWorkflowsService,
} from "./definition";

export function createWorkflowUsageFragment(
  config: WorkflowUsageConfig,
  options: FragnoPublicConfigWithDatabase,
  services: { workflows: WorkflowUsageWorkflowsService },
) {
  return instantiate(workflowUsageFragmentDefinition)
    .withConfig(config)
    .withRoutes([workflowUsageRoutesFactory])
    .withOptions(options)
    .withServices(services)
    .build();
}

export function createWorkflowUsageFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const builder = createClientBuilder(workflowUsageFragmentDefinition, fragnoConfig, [
    workflowUsageRoutesFactory,
  ]);

  return {
    useSessions: builder.createHook("/sessions"),
    useSession: builder.createHook("/sessions/:sessionId"),
    useCreateSession: builder.createMutator("POST", "/sessions"),
    useSendSessionEvent: builder.createMutator("POST", "/sessions/:sessionId/events"),
  };
}

export { dslWorkflow, INTERNAL_WORKFLOW_NAME } from "./workflow";
export { workflowUsageFragmentDefinition } from "./definition";
export { workflowUsageRoutesFactory } from "./routes";

export const usageRequiredWorkflows = {
  workflowUsage: dslWorkflow,
} as const;

export type { FragnoRouteConfig } from "@fragno-dev/core";
