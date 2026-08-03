import { WORKFLOW_EVENT_ACTOR_SYSTEM, WORKFLOW_EVENT_ACTOR_USER } from "./system-events";

export type WorkflowStepStartedControlPayload = {
  control: "step-started";
};

export type WorkflowStepCommittedControlPayload = {
  control: "step-committed";
  epoch: string;
};

export type WorkflowEventConsumedControlPayload = {
  control: "event-consumed";
  eventId: string;
};

export type WorkflowStepActivityEmission = {
  actor: string;
  stepKey: string;
  executionId: string;
  epoch: string;
  payload: unknown;
};

export type WorkflowStepCanonicalRecord = {
  stepKey: string;
  status: string;
  committedByExecutionId: string;
};

export type WorkflowStepExecutionActivity = {
  stepKey: string;
  epoch: string;
  active: boolean;
  userEmissionCount: number;
};

export type WorkflowStepEpochSelection = ReadonlyMap<string, string>;

type WorkflowStepCommittedScope = {
  executionId: string;
  epoch: string;
};

export function selectNoncanonicalWorkflowExecutionIds(options: {
  steps: readonly WorkflowStepCanonicalRecord[];
  emissions: readonly WorkflowStepActivityEmission[];
}): ReadonlySet<string> {
  const terminalStepsByKey = new Map(
    options.steps.flatMap((step) =>
      step.status === "completed" || step.status === "errored" ? [[step.stepKey, step]] : [],
    ),
  );
  const noncanonicalExecutionIds = new Set<string>();

  for (const emission of options.emissions) {
    const terminalStep = terminalStepsByKey.get(emission.stepKey);
    if (terminalStep && emission.executionId !== terminalStep.committedByExecutionId) {
      noncanonicalExecutionIds.add(emission.executionId);
    }
  }

  return noncanonicalExecutionIds;
}

export function selectCanonicalWorkflowStepEmissions<
  TEmission extends WorkflowStepActivityEmission,
>(options: {
  steps: readonly WorkflowStepCanonicalRecord[];
  emissions: readonly TEmission[];
}): TEmission[] {
  const noncanonicalExecutionIds = selectNoncanonicalWorkflowExecutionIds(options);
  return options.emissions.filter(
    (emission) => !noncanonicalExecutionIds.has(emission.executionId),
  );
}

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
export function createWorkflowEventConsumedControlPayload(
  eventId: string,
): WorkflowEventConsumedControlPayload {
  return { control: "event-consumed", eventId };
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

/** @internal */
export function isWorkflowEventConsumedControlPayload(
  payload: unknown,
): payload is WorkflowEventConsumedControlPayload {
  return (
    isRecord(payload) &&
    payload["control"] === "event-consumed" &&
    typeof payload["eventId"] === "string"
  );
}

function selectWorkflowStepCommittedScopes(
  emissions: readonly WorkflowStepActivityEmission[],
): ReadonlyMap<string, WorkflowStepCommittedScope> {
  const committedScopes = new Map<string, WorkflowStepCommittedScope>();

  for (const emission of emissions) {
    if (
      emission.actor === WORKFLOW_EVENT_ACTOR_SYSTEM &&
      isWorkflowStepCommittedControlPayload(emission.payload) &&
      emission.payload.epoch === emission.epoch
    ) {
      committedScopes.set(emission.stepKey, {
        executionId: emission.executionId,
        epoch: emission.epoch,
      });
    }
  }

  return committedScopes;
}

export function selectWorkflowStepCommittedEpochs(
  emissions: readonly WorkflowStepActivityEmission[],
): WorkflowStepEpochSelection {
  return new Map(
    [...selectWorkflowStepCommittedScopes(emissions)].map(([stepKey, scope]) => [
      stepKey,
      scope.epoch,
    ]),
  );
}

/**
 * Present one stable unresolved execution per step while retracting every emission from an
 * execution proven to have lost a committed step.
 */
export function selectWorkflowStepPresentationEmissions<
  TEmission extends WorkflowStepActivityEmission,
>(emissions: readonly TEmission[]): TEmission[] {
  const committedScopes = selectWorkflowStepCommittedScopes(emissions);
  const losingExecutionIds = new Set<string>();

  for (const emission of emissions) {
    const committedScope = committedScopes.get(emission.stepKey);
    if (committedScope && emission.executionId !== committedScope.executionId) {
      losingExecutionIds.add(emission.executionId);
    }
  }

  const canonicalEmissions = emissions.filter((emission) => {
    if (losingExecutionIds.has(emission.executionId)) {
      return false;
    }

    const committedScope = committedScopes.get(emission.stepKey);
    return (
      !committedScope ||
      (emission.executionId === committedScope.executionId &&
        emission.epoch === committedScope.epoch)
    );
  });
  const firstExecutionByStep = new Map<string, string>();

  for (const emission of canonicalEmissions) {
    if (!firstExecutionByStep.has(emission.stepKey)) {
      firstExecutionByStep.set(emission.stepKey, emission.executionId);
    }
  }

  return canonicalEmissions.filter(
    (emission) => firstExecutionByStep.get(emission.stepKey) === emission.executionId,
  );
}

export function selectWorkflowStepReplayEpochs(
  emissions: readonly WorkflowStepActivityEmission[],
): WorkflowStepEpochSelection {
  const replayEpochs = new Map<string, string>();

  for (const emission of emissions) {
    if (emission.actor !== WORKFLOW_EVENT_ACTOR_SYSTEM) {
      continue;
    }
    if (isWorkflowStepStartedControlPayload(emission.payload)) {
      replayEpochs.set(emission.stepKey, emission.epoch);
    } else if (
      isWorkflowStepCommittedControlPayload(emission.payload) &&
      emission.payload.epoch === emission.epoch
    ) {
      replayEpochs.set(emission.stepKey, emission.epoch);
    }
  }

  return replayEpochs;
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
