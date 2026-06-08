import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { computed } from "nanostores";

import { currentStepLabel, isTerminalStatus, isWaitingStatus, statusLabel } from "../workflow";
import { workflowsFragmentDefinitionClient } from "./definition";
import { workflowsRoutesFactoryClient } from "./routes";

type CurrentStepEmission = {
  stepKey: string;
  epoch: string;
  payload: unknown;
};

const isStepCommittedEmission = (emission: CurrentStepEmission) => {
  const payload = emission.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "control" in payload &&
    payload.control === "step-committed"
  );
};

const filterCurrentStepEmissions = <TEmission extends CurrentStepEmission>(
  emissions: TEmission[],
) => {
  const committedEpochsByStep = new Map<string, string>();
  for (const emission of emissions) {
    if (isStepCommittedEmission(emission)) {
      committedEpochsByStep.set(emission.stepKey, emission.epoch);
    }
  }

  return emissions.filter((emission) => {
    const committedEpoch = committedEpochsByStep.get(emission.stepKey);
    return !committedEpoch || committedEpoch === emission.epoch;
  });
};

export function createWorkflowsClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(workflowsFragmentDefinitionClient, fragnoConfig, [
    workflowsRoutesFactoryClient,
  ]);
  const rawCurrentStepEmissions = builder.createHook(
    "/:workflowName/instances/:instanceId/current-step/emissions",
  );
  const currentStepEmissions = builder.createStore(
    (args: Parameters<typeof rawCurrentStepEmissions.store>[0]) => {
      const store = rawCurrentStepEmissions.store(args);
      return computed(store, (state) =>
        state.data ? { ...state, data: filterCurrentStepEmissions(state.data) } : state,
      );
    },
  );

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
    useCurrentStepEmissions: currentStepEmissions,
    useInstanceHistory: builder.createHook("/:workflowName/instances/:instanceId/history"),
    useRetryInstance: builder.createMutator(
      "POST",
      "/:workflowName/instances/:instanceId/retry",
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
