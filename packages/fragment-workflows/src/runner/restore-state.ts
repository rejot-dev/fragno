// Read-only workflow replay for reconstructing restorable state.

import type { StandardSchemaV1 } from "@fragno-dev/core/api";

import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowStateContext,
  WorkflowStateShape,
} from "../workflow";
import { createRunnerState } from "./state";
import { RunnerStep, RunnerStepReplayStopped } from "./step";
import type { WorkflowInstanceRecord, WorkflowStepRecord } from "./types";
import { createIsolatedWorkflowState, createWorkflowStateController } from "./workflow-state";

function buildWorkflowReplayEvent<TParams>(
  instance: WorkflowInstanceRecord,
  timestamp: Date,
): WorkflowEvent<TParams> {
  return {
    payload: (instance.params ?? {}) as Readonly<TParams>,
    timestamp,
    instanceId: instance.id.toString(),
    runNumber: instance.runNumber,
  };
}

/**
 * Restore the latest in-memory workflow state without consuming events or running incomplete steps.
 * Bigger picture: this replays workflow code around cached step results, so only `setState` calls
 * that execute during replay are recoverable.
 */
export async function restoreWorkflowState<
  TParams = unknown,
  TOutput = unknown,
  TInputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TState extends WorkflowStateShape | undefined = undefined,
>(options: {
  workflow: WorkflowDefinition<TParams, TOutput, TInputSchema, TOutputSchema, TState>;
  instance: WorkflowInstanceRecord;
  steps: WorkflowStepRecord[];
  timestamp?: Date;
}): Promise<TState extends undefined ? undefined : TState> {
  if (!options.workflow.initialState) {
    return undefined as TState extends undefined ? undefined : TState;
  }

  type RestorableState = Exclude<TState, undefined> & WorkflowStateShape;

  const workflowState = createWorkflowStateController(
    createIsolatedWorkflowState(options.workflow.initialState as RestorableState),
  );
  const replayTimestamp = options.timestamp ?? options.instance.updatedAt;
  const initialEvent = buildWorkflowReplayEvent<TParams>(options.instance, replayTimestamp);
  const step = new RunnerStep({
    state: createRunnerState(options.instance, options.steps, []),
    taskKind: "run",
    mode: "restore",
  });
  const runContext: WorkflowStateContext<RestorableState> = {
    getState: workflowState.getState as WorkflowStateContext<RestorableState>["getState"],
    setState: workflowState.setState as WorkflowStateContext<RestorableState>["setState"],
  };

  try {
    await options.workflow.run.call(runContext as WorkflowStateContext<TState>, initialEvent, step);
  } catch (error) {
    if (!(error instanceof RunnerStepReplayStopped)) {
      // Best-effort restore: state emitted before the replay stopped is still valid for inspect.
    }
  }

  return workflowState.getState() as TState extends undefined ? undefined : TState;
}
