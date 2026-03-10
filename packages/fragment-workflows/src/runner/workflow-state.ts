// Helpers for holding restorable workflow state snapshots in memory.

import type { WorkflowStateShape } from "../workflow";

export type WorkflowStateController = {
  getState: () => WorkflowStateShape;
  setState: (nextState: Partial<WorkflowStateShape>) => void;
};

function cloneState<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Create a state controller for a single workflow run/replay.
 * Bigger picture: replay reconstructs state by rerunning workflow code around cached step results,
 * so only in-memory state mutations that execute during replay are restorable.
 */
export function createWorkflowStateController(
  initialState: WorkflowStateShape,
): WorkflowStateController {
  let currentState = cloneState(initialState);

  const setState = (nextState: Partial<WorkflowStateShape>) => {
    currentState = {
      ...currentState,
      ...cloneState(nextState),
    };
  };

  return {
    getState: () => cloneState(currentState),
    setState,
  };
}
