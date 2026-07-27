import { WORKFLOW_EVENT_ACTOR_SYSTEM, WORKFLOW_EVENT_ACTOR_USER } from "./system-events";

export type WorkflowStepStartedControlPayload = {
  control: "step-started";
};

export type WorkflowStepCommittedControlPayload = {
  control: "step-committed";
  epoch: string;
};

export type WorkflowStepActivityEmission = {
  actor: string;
  stepKey: string;
  epoch: string;
  payload: unknown;
};

export type WorkflowStepExecutionActivity = {
  stepKey: string;
  epoch: string;
  active: boolean;
  userEmissionCount: number;
};

/** @internal */
export function createWorkflowStepStartedControlPayload(): WorkflowStepStartedControlPayload {
  return { control: "step-started" };
}

/** @internal */
export function createWorkflowStepCommittedControlPayload(
  epoch: string,
): WorkflowStepCommittedControlPayload {
  return { control: "step-committed", epoch };
}

/** @internal */
export function isWorkflowStepStartedControlPayload(
  payload: unknown,
): payload is WorkflowStepStartedControlPayload {
  return isRecord(payload) && payload["control"] === "step-started";
}

export function isWorkflowStepCommittedControlPayload(
  payload: unknown,
): payload is WorkflowStepCommittedControlPayload {
  return (
    isRecord(payload) &&
    payload["control"] === "step-committed" &&
    typeof payload["epoch"] === "string"
  );
}

export function projectWorkflowStepExecutionActivity(
  emissions: readonly WorkflowStepActivityEmission[],
): WorkflowStepExecutionActivity[] {
  const activityByExecution = new Map<string, WorkflowStepExecutionActivityAccumulator>();

  for (const emission of emissions) {
    const identity = workflowStepExecutionIdentity(emission.stepKey, emission.epoch);
    const activity = activityByExecution.get(identity) ?? {
      stepKey: emission.stepKey,
      epoch: emission.epoch,
      userEmissionCount: 0,
      started: false,
      committed: false,
    };

    if (emission.actor === WORKFLOW_EVENT_ACTOR_USER) {
      activity.userEmissionCount += 1;
    } else {
      const lifecycle = workflowStepLifecycle(emission);
      activity.started ||= lifecycle === "started";
      activity.committed ||= lifecycle === "committed";
    }

    activityByExecution.set(identity, activity);
  }

  return [...activityByExecution.values()].map(
    ({ stepKey, epoch, started, committed, userEmissionCount }) => ({
      stepKey,
      epoch,
      active: started && !committed,
      userEmissionCount,
    }),
  );
}

type WorkflowStepExecutionActivityAccumulator = {
  stepKey: string;
  epoch: string;
  userEmissionCount: number;
  started: boolean;
  committed: boolean;
};

function workflowStepLifecycle(
  emission: WorkflowStepActivityEmission,
): "started" | "committed" | null {
  if (emission.actor !== WORKFLOW_EVENT_ACTOR_SYSTEM) {
    return null;
  }
  if (isWorkflowStepStartedControlPayload(emission.payload)) {
    return "started";
  }
  if (
    isWorkflowStepCommittedControlPayload(emission.payload) &&
    emission.payload.epoch === emission.epoch
  ) {
    return "committed";
  }
  return null;
}

function workflowStepExecutionIdentity(stepKey: string, epoch: string): string {
  return `${stepKey}\u0000${epoch}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
