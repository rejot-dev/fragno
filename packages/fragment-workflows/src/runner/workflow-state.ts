// Helpers for holding restorable workflow state snapshots in memory.

import type { WorkflowStateShape } from "../workflow";

export type WorkflowStateController<TState extends WorkflowStateShape = WorkflowStateShape> = {
  getState: () => TState;
  setState: (nextState: Partial<TState>) => void;
};

type WorkflowStateControllerOptions<TState extends WorkflowStateShape> = {
  onStateChange?: (state: TState) => void;
};

export function createIsolatedWorkflowState<T extends WorkflowStateShape>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through so live in-memory members such as listeners or class instances remain usable.
    }
  }

  return { ...value };
}

/**
 * Create a state controller for a single workflow run/replay.
 * Bigger picture: replay reconstructs state by rerunning workflow code around cached step results,
 * so only in-memory state mutations that execute during replay are restorable.
 */
export function createWorkflowStateController<TState extends WorkflowStateShape>(
  initialState: TState,
  options: WorkflowStateControllerOptions<TState> = {},
): WorkflowStateController<TState> {
  const currentState = initialState;

  const setState = (nextState: Partial<TState>) => {
    Object.assign(currentState, nextState);
    options.onStateChange?.(currentState);
  };

  return {
    getState: () => currentState,
    setState,
  };
}
