import { describe, expect, it } from "vitest";

import { createWorkflowLiveStateStore } from "./live-state";

describe("createWorkflowLiveStateStore", () => {
  it("returns direct live references for matching reads", () => {
    const store = createWorkflowLiveStateStore<{ phase: string; turn: number }>();
    const snapshot = {
      workflowName: "demo-workflow",
      instanceId: "instance-1",
      runNumber: 2,
      status: "waiting" as const,
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      state: { phase: "waiting", turn: 1 },
    };

    store.set(snapshot);

    const first = store.get("instance-1", {
      workflowName: "demo-workflow",
      runNumber: 2,
    });
    expect(first).toEqual(snapshot);
    expect(first).toBe(snapshot);
    expect(first?.state).toBe(snapshot.state);

    if (!first) {
      throw new Error("Expected a live workflow snapshot");
    }
    first.state.turn = 99;

    const second = store.get("instance-1", {
      workflowName: "demo-workflow",
      runNumber: 2,
    });
    expect(second?.state.turn).toBe(99);
  });

  it("keeps arbitrary in-memory members intact", () => {
    const listeners = new Set([() => "listener"]);
    const store = createWorkflowLiveStateStore<{ phase: string; listeners: Set<() => string> }>();

    store.set({
      workflowName: "demo-workflow",
      instanceId: "instance-2",
      runNumber: 0,
      status: "active",
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      state: { phase: "active", listeners },
    });

    const snapshot = store.get("instance-2", { workflowName: "demo-workflow" });
    expect(snapshot?.state.listeners).toBe(listeners);
    expect(snapshot?.state.listeners.size).toBe(1);
  });

  it("rejects stale snapshots when the workflow run no longer matches", () => {
    const store = createWorkflowLiveStateStore<{ phase: string }>();

    store.set({
      workflowName: "demo-workflow",
      instanceId: "instance-1",
      runNumber: 1,
      status: "waiting",
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      state: { phase: "waiting" },
    });

    expect(
      store.get("instance-1", {
        workflowName: "demo-workflow",
        runNumber: 2,
      }),
    ).toBeNull();
    expect(store.size()).toBe(0);
  });
});
