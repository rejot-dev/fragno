import {
  emptyPiWorkflowSessionProjectionState,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionState,
  type PiWorkflowSessionProjectionStep,
} from "@fragno-dev/pi-harness/workflow-session-projection";
import { selectCanonicalWorkflowStepEmissions } from "@fragno-dev/workflows/step-emission-control";

type PiWorkflowInstanceProjectionRow = {
  status: string;
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
    return emptyPiWorkflowSessionProjectionState();
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
      result: step.result as PiWorkflowSessionProjectionStep["result"],
    })),
    workflowStepEmissions: canonicalEmissions.map((emission) => ({
      stepKey: emission.stepKey,
      payload: emission.payload as PiWorkflowSessionProjectionEmission["payload"],
      createdAt: emission.createdAt,
    })),
  });

  if (synchronized || projection.status === "error") {
    return projection;
  }

  return {
    ...projection,
    status: "loading",
    readyForInput: false,
    statusText: projection.statusText ?? "Loading…",
  };
}
