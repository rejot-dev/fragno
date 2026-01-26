// In-memory workflow run state and mutation buffer for a single task execution.

import type {
  WorkflowEventRecord,
  WorkflowEventUpdate,
  WorkflowInstanceRecord,
  WorkflowLogCreate,
  WorkflowStepCreate,
  WorkflowStepRecord,
  WorkflowStepUpdate,
} from "./types";

export type WorkflowStepSnapshot = Partial<Omit<WorkflowStepRecord, "id">> & {
  id?: WorkflowStepRecord["id"];
};

export type RunnerMutationBuffer = {
  stepCreates: Map<string, WorkflowStepCreate>;
  stepUpdates: Map<
    string,
    {
      id: WorkflowStepRecord["id"];
      data: WorkflowStepUpdate;
    }
  >;
  eventUpdates: Map<
    string,
    {
      id: WorkflowEventRecord["id"];
      data: WorkflowEventUpdate;
    }
  >;
  logs: WorkflowLogCreate[];
};

export type RunnerState = {
  instance: WorkflowInstanceRecord;
  remoteState: {
    pauseRequested: boolean;
    status: string;
    runNumber: number;
    missing: boolean;
    updatedAt: Date | null;
  };
  remoteStateRefresh: (() => Promise<void>) | null;
  remoteStateRefreshedAt: Date | null;
  stepsByKey: Map<string, WorkflowStepSnapshot>;
  events: WorkflowEventRecord[];
  mutations: RunnerMutationBuffer;
};

export const createRunnerState = (
  instance: WorkflowInstanceRecord,
  steps: WorkflowStepRecord[],
  events: WorkflowEventRecord[],
): RunnerState => {
  const stepsByKey = new Map<string, WorkflowStepSnapshot>();
  for (const step of steps) {
    stepsByKey.set(step.stepKey, step);
  }

  return {
    instance,
    remoteState: {
      pauseRequested: instance.pauseRequested,
      status: instance.status,
      runNumber: instance.runNumber,
      missing: false,
      updatedAt: instance.updatedAt ?? null,
    },
    remoteStateRefresh: null,
    remoteStateRefreshedAt: instance.updatedAt ?? null,
    stepsByKey,
    events,
    mutations: {
      stepCreates: new Map(),
      stepUpdates: new Map(),
      eventUpdates: new Map(),
      logs: [],
    },
  };
};

export const updateRemoteState = (
  state: RunnerState,
  instance: WorkflowInstanceRecord | null,
): void => {
  if (!instance) {
    state.remoteState.missing = true;
    state.remoteStateRefreshedAt = new Date();
    return;
  }

  state.remoteState = {
    pauseRequested: instance.pauseRequested,
    status: instance.status,
    runNumber: instance.runNumber,
    missing: false,
    updatedAt: instance.updatedAt ?? null,
  };
  state.remoteStateRefreshedAt = new Date();
};

export const getStepSnapshot = (state: RunnerState, stepKey: string) =>
  state.stepsByKey.get(stepKey) ?? null;

export const queueStepCreate = (
  state: RunnerState,
  stepKey: string,
  data: WorkflowStepCreate,
): void => {
  state.mutations.stepCreates.set(stepKey, data);
  state.mutations.stepUpdates.delete(stepKey);
  state.stepsByKey.set(stepKey, { ...data });
};

export const queueStepUpdate = (
  state: RunnerState,
  stepKey: string,
  id: WorkflowStepRecord["id"] | undefined,
  data: WorkflowStepUpdate,
): void => {
  const existingCreate = state.mutations.stepCreates.get(stepKey);
  if (existingCreate) {
    state.mutations.stepCreates.set(stepKey, { ...existingCreate, ...data });
    state.stepsByKey.set(stepKey, { ...existingCreate, ...data });
    return;
  }

  if (!id) {
    return;
  }

  const existingUpdate = state.mutations.stepUpdates.get(stepKey);
  state.mutations.stepUpdates.set(stepKey, {
    id,
    data: existingUpdate ? { ...existingUpdate.data, ...data } : data,
  });
  const current = state.stepsByKey.get(stepKey) ?? { id };
  state.stepsByKey.set(stepKey, { ...current, ...data });
};

export const queueEventUpdate = (
  state: RunnerState,
  event: WorkflowEventRecord,
  data: WorkflowEventUpdate,
): void => {
  state.mutations.eventUpdates.set(String(event.id), { id: event.id, data });
  Object.assign(event, data);
};

export const queueLogCreate = (state: RunnerState, log: WorkflowLogCreate): void => {
  state.mutations.logs.push(log);
};
