import {
  emptyPiWorkflowSessionProjectionState,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionState,
  type PiWorkflowSessionProjectionStep,
} from "@fragno-dev/pi-harness/workflow-session-projection";

type PiWorkflowInstanceProjectionRow = {
  status: string;
};

type PiWorkflowStepProjectionRow = {
  stepKey: string;
  type: string;
  status: string;
  waitEventType: string | null;
  result: unknown;
};

type PiWorkflowStepEmissionProjectionRow = {
  stepKey: string;
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
    workflowStepEmissions: workflowStepEmissions.map((emission) => ({
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
