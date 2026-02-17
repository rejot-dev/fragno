// In-memory workflow run state and mutation buffer for a single task execution.

import type {
  WorkflowEventRecord,
  WorkflowEventUpdate,
  WorkflowInstanceRecord,
  WorkflowLogCreate,
  WorkflowStepCreateDraft,
  WorkflowStepRecord,
  WorkflowStepUpdateDraft,
} from "./types";
import type { HandlerTxContext, HooksMap, TxResult } from "@fragno-dev/db";

export type WorkflowStepSnapshot = Partial<Omit<WorkflowStepRecord, "id">> & {
  id?: WorkflowStepRecord["id"];
};

export type RunnerMutationBuffer = {
  stepCreates: Map<string, WorkflowStepCreateDraft>;
  stepUpdates: Map<
    string,
    {
      id: WorkflowStepRecord["id"];
      data: WorkflowStepUpdateDraft;
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

export type RunnerStepMutationBuffer = {
  serviceCalls: Array<() => readonly TxResult<unknown, unknown>[]>;
  mutations: Array<(ctx: HandlerTxContext<HooksMap>) => void>;
};

type RunnerStepMutationEntry = {
  attempt: number | null;
  buffer: RunnerStepMutationBuffer;
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
  stepMutations: Map<string, RunnerStepMutationEntry>;
};

const createMutationBuffer = (): RunnerMutationBuffer => ({
  stepCreates: new Map(),
  stepUpdates: new Map(),
  eventUpdates: new Map(),
  logs: [],
});

const createStepMutationBuffer = (): RunnerStepMutationBuffer => ({
  serviceCalls: [],
  mutations: [],
});

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
    mutations: createMutationBuffer(),
    stepMutations: new Map(),
  };
};

export const resetMutations = (state: RunnerState): void => {
  state.mutations = createMutationBuffer();
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

export const getStepMutationBuffer = (
  state: RunnerState,
  stepKey: string,
  attempt: number | null,
): RunnerStepMutationBuffer => {
  const existing = state.stepMutations.get(stepKey);
  if (!existing || existing.attempt !== attempt) {
    const entry = { attempt, buffer: createStepMutationBuffer() };
    state.stepMutations.set(stepKey, entry);
    return entry.buffer;
  }
  return existing.buffer;
};

export const getStepMutationBufferIfExists = (
  state: RunnerState,
  stepKey: string,
  attempt: number | null,
): RunnerStepMutationBuffer | null => {
  const existing = state.stepMutations.get(stepKey);
  if (!existing || existing.attempt !== attempt) {
    return null;
  }
  return existing.buffer;
};

export const clearStepMutationBuffer = (state: RunnerState, stepKey: string): void => {
  state.stepMutations.delete(stepKey);
};

export const queueStepCreate = (
  state: RunnerState,
  stepKey: string,
  data: WorkflowStepCreateDraft,
): void => {
  state.mutations.stepCreates.set(stepKey, data);
  state.mutations.stepUpdates.delete(stepKey);
  state.stepsByKey.set(stepKey, { ...data });
};

export const queueStepUpdate = (
  state: RunnerState,
  stepKey: string,
  id: WorkflowStepRecord["id"] | undefined,
  data: WorkflowStepUpdateDraft,
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
