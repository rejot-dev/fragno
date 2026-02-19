import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { currentStepLabel, isTerminalStatus, isWaitingStatus, statusLabel } from "../workflow";
import { workflowsFragmentDefinitionClient } from "./definition";
import { workflowsRoutesFactoryClient } from "./routes";

export function createWorkflowsClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(workflowsFragmentDefinitionClient, fragnoConfig, [
    workflowsRoutesFactoryClient,
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
