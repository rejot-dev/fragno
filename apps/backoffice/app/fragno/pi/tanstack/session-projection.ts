import type { PiWorkflowStatus } from "@fragno-dev/pi-harness/types";
import {
  createLoadingPiWorkflowSessionProjection,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionState,
} from "@fragno-dev/pi-harness/workflow-session-projection";
import { selectCanonicalWorkflowStepEmissions } from "@fragno-dev/workflows/step-emission-control";

type PiWorkflowInstanceProjectionRow = {
  status: PiWorkflowStatus;
};

type PiWorkflowStepProjectionRow = {
  stepKey: string;
  type: string;
  status: string;
  committedByExecutionId: string;
  waitEventType: string | null;
  result: unknown;
};

type PiWorkflowStepEmissionProjectionRow = {
  actor: string;
  stepKey: string;
  executionId: string;
  epoch: string;
  payload: unknown;
  createdAt: Date;
};

export function projectPiSessionCollectionRows({
  workflowName,
  sessionId,
  instance,
  workflowSteps,
  workflowStepEmissions,
  synchronized,
}: {
  workflowName: string;
  sessionId: string;
  instance: PiWorkflowInstanceProjectionRow | null;
  workflowSteps: readonly PiWorkflowStepProjectionRow[];
  workflowStepEmissions: readonly PiWorkflowStepEmissionProjectionRow[];
  synchronized: boolean;
}): PiWorkflowSessionProjectionState {
  if (!instance && !synchronized) {
    return createLoadingPiWorkflowSessionProjection({ workflowName, sessionId });
  }

  const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
    steps: workflowSteps,
    emissions: workflowStepEmissions,
  });
  const projection = projectPiWorkflowSession({
    workflowName,
    sessionId,
    instance,
    workflowSteps: workflowSteps.map((step) => ({
      stepKey: step.stepKey,
      type: step.type,
      status: step.status,
      waitEventType: step.waitEventType,
      result: step.result,
    })),
    workflowStepEmissions: canonicalEmissions.map((emission) => ({
      stepKey: emission.stepKey,
      payload: emission.payload as PiWorkflowSessionProjectionEmission["payload"],
      createdAt: emission.createdAt,
    })),
  });

  if (synchronized || projection.status === "not-found") {
    return projection;
  }

  return {
    ...projection,
    status: "loading",
    error: null,
    readyForInput: false,
    activity: null,
  };
}
