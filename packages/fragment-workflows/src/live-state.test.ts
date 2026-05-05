import { describe, expect, it } from "vitest";

import { createWorkflowLiveStateStore } from "./live-state";

const snapshot = <TState extends Record<string, unknown>>(state: TState, runNumber = 2) => ({
  workflowName: "demo-workflow",
  instanceId: "instance-1",
  runNumber,
  stepKey: "do:step",
  parentStepKey: null,
  depth: 0,
  name: "step",
  capturedAt: new Date("2026-01-01T00:00:00.000Z"),
  state,
});

describe("createWorkflowLiveStateStore", () => {
  it("returns direct live references for matching step reads", () => {
    const store = createWorkflowLiveStateStore<{ phase: string; turn: number }>();
    const value = snapshot({ phase: "waiting", turn: 1 });

    store.set(value);

    const first = store.get("instance-1", {
      workflowName: "demo-workflow",
      runNumber: 2,
      stepKey: "do:step",
    });
    expect(first).toEqual(value);
    expect(first).toBe(value);
    expect(first?.state).toBe(value.state);

    if (!first) {
      throw new Error("Expected a live workflow snapshot");
    }
    first.state.turn = 99;

    const second = store.get("instance-1", { workflowName: "demo-workflow", runNumber: 2 });
    expect(second?.state.turn).toBe(99);
  });

  it("keeps arbitrary in-memory members intact", () => {
    const listeners = new Set([() => "listener"]);
    const store = createWorkflowLiveStateStore<{ phase: string; listeners: Set<() => string> }>();

    store.set(snapshot({ phase: "active", listeners }, 0));

    const live = store.get("instance-1", { workflowName: "demo-workflow" });
    expect(live?.state.listeners).toBe(listeners);
    expect(live?.state.listeners.size).toBe(1);
  });

  it("returns null for stale run lookups without deleting current state", () => {
    const store = createWorkflowLiveStateStore<{ phase: string }>();
    store.set(snapshot({ phase: "waiting" }, 1));

    expect(store.get("instance-1", { workflowName: "demo-workflow", runNumber: 2 })).toBeNull();
    expect(store.size()).toBe(1);
  });

  it("lease clear cannot delete a newer lease for the same step", () => {
    const store = createWorkflowLiveStateStore<{ phase: string }>();
    const first = store.begin(snapshot({ phase: "first" }, 1));
    const second = store.begin(snapshot({ phase: "second" }, 1));

    first.clear();
    expect(store.get("instance-1", { runNumber: 1, stepKey: "do:step" })?.state.phase).toBe(
      "second",
    );

    second.clear();
    expect(store.get("instance-1", { runNumber: 1, stepKey: "do:step" })).toBeNull();
  });
});
