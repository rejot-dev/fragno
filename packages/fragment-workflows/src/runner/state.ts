// In-memory runner state derived from a single tick's retrieved data.

import type { HandlerTxContext, HooksMap } from "@fragno-dev/db";

import type {
  AnyTxResult,
  WorkflowStepEmissionsCleanupHookPayload,
  WorkflowStepWorkflowOperation,
} from "../workflow";
import type {
  WorkflowEventRecord,
  WorkflowEventUpdate,
  WorkflowInstanceRecord,
  WorkflowStepCreateDraft,
  WorkflowStepEmissionRecord,
  WorkflowStepRecord,
  WorkflowStepUpdateDraft,
} from "./types";

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
  txMutations: Array<(ctx: HandlerTxContext<HooksMap>) => void>;
  txServiceCalls: AnyTxResult[];
  workflowServiceCalls: WorkflowStepWorkflowOperation[];
  stepEmissionCleanupRequests: WorkflowStepEmissionsCleanupHookPayload[];
};

export type RunnerState = {
  instance: WorkflowInstanceRecord;
  stepsByKey: Map<string, WorkflowStepSnapshot>;
  events: WorkflowEventRecord[];
  stepEmissions: WorkflowStepEmissionRecord[];
  mutations: RunnerMutationBuffer;
};

/**
 * Build a fresh mutation buffer for a single runner tick.
 * Bigger picture: captures all intended writes so the runner can apply them after retrieval.
 */
function createMutationBuffer(): RunnerMutationBuffer {
  return {
    stepCreates: new Map(),
    stepUpdates: new Map(),
    eventUpdates: new Map(),
    txMutations: [],
    txServiceCalls: [],
    workflowServiceCalls: [],
    stepEmissionCleanupRequests: [],
  };
}

/**
 * Create runner state from retrieved instance/steps/events.
 * Bigger picture: this snapshot is the in-memory source of truth during workflow execution.
 */
export function createRunnerState(
  instance: WorkflowInstanceRecord,
  steps: WorkflowStepRecord[],
  events: WorkflowEventRecord[],
  stepEmissions: WorkflowStepEmissionRecord[],
): RunnerState {
  const stepsByKey = new Map<string, WorkflowStepSnapshot>();
  for (const step of steps) {
    stepsByKey.set(step.stepKey, step);
  }

  return {
    instance,
    stepsByKey,
    events,
    stepEmissions,
    mutations: createMutationBuffer(),
  };
}
