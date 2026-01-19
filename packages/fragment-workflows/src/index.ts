import { instantiate } from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { attachWorkflowsBindings } from "./bindings";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { createWorkflowsRunner } from "./runner";
import {
  currentStepLabel,
  isTerminalStatus,
  isWaitingStatus,
  statusLabel,
  type WorkflowsFragmentConfig,
} from "./workflow";

const routes = [workflowsRoutesFactory] as const;

/** Create a workflows fragment with routes, bindings, and database integration. */
export function createWorkflowsFragment(
  config: WorkflowsFragmentConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();

  return attachWorkflowsBindings(fragment, config.workflows ?? {});
}

export function createWorkflowsClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(workflowsFragmentDefinition, fragnoConfig, [
    workflowsRoutesFactory,
  ]);

  return {
    useWorkflows: builder.createHook("/"),
    useWorkflowInstances: builder.createHook("/:workflowName/instances"),
    useCreateInstance: builder.createMutator(
      "POST",
      "/:workflowName/instances",
      (invalidate, params) => {
        const workflowName = params.pathParams.workflowName;
        if (!workflowName) {
          return;
        }
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
      },
    ),
    useCreateBatch: builder.createMutator(
      "POST",
      "/:workflowName/instances/batch",
      (invalidate, params) => {
        const workflowName = params.pathParams.workflowName;
        if (!workflowName) {
          return;
        }
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
      },
    ),
    useInstance: builder.createHook("/:workflowName/instances/:instanceId"),
    useInstanceHistory: builder.createHook("/:workflowName/instances/:instanceId/history"),
    usePauseInstance: builder.createMutator(
      "POST",
      "/:workflowName/instances/:instanceId/pause",
      (invalidate, params) => {
        const { workflowName, instanceId } = params.pathParams;
        if (!workflowName || !instanceId) {
          return;
        }
        invalidate("GET", "/:workflowName/instances/:instanceId", {
          pathParams: { workflowName, instanceId },
        });
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
      },
    ),
    useResumeInstance: builder.createMutator(
      "POST",
      "/:workflowName/instances/:instanceId/resume",
      (invalidate, params) => {
        const { workflowName, instanceId } = params.pathParams;
        if (!workflowName || !instanceId) {
          return;
        }
        invalidate("GET", "/:workflowName/instances/:instanceId", {
          pathParams: { workflowName, instanceId },
        });
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
        invalidate("GET", "/:workflowName/instances/:instanceId/history", {
          pathParams: { workflowName, instanceId },
        });
      },
    ),
    useTerminateInstance: builder.createMutator(
      "POST",
      "/:workflowName/instances/:instanceId/terminate",
      (invalidate, params) => {
        const { workflowName, instanceId } = params.pathParams;
        if (!workflowName || !instanceId) {
          return;
        }
        invalidate("GET", "/:workflowName/instances/:instanceId", {
          pathParams: { workflowName, instanceId },
        });
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
      },
    ),
    useRestartInstance: builder.createMutator(
      "POST",
      "/:workflowName/instances/:instanceId/restart",
      (invalidate, params) => {
        const { workflowName, instanceId } = params.pathParams;
        if (!workflowName || !instanceId) {
          return;
        }
        invalidate("GET", "/:workflowName/instances/:instanceId", {
          pathParams: { workflowName, instanceId },
        });
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
        invalidate("GET", "/:workflowName/instances/:instanceId/history", {
          pathParams: { workflowName, instanceId },
        });
      },
    ),
    useSendEvent: builder.createMutator(
      "POST",
      "/:workflowName/instances/:instanceId/events",
      (invalidate, params) => {
        const { workflowName, instanceId } = params.pathParams;
        if (!workflowName || !instanceId) {
          return;
        }
        invalidate("GET", "/:workflowName/instances/:instanceId", {
          pathParams: { workflowName, instanceId },
        });
        invalidate("GET", "/:workflowName/instances", {
          pathParams: { workflowName },
        });
        invalidate("GET", "/:workflowName/instances/:instanceId/history", {
          pathParams: { workflowName, instanceId },
        });
      },
    ),
    helpers: {
      isTerminalStatus,
      isWaitingStatus,
      statusLabel,
      currentStepLabel,
    },
  };
}

export { workflowsFragmentDefinition };
export { workflowsRoutesFactory };
export { workflowsSchema };
export { createWorkflowsRunner };
export { attachWorkflowsBindings };
export * from "./workflow";
