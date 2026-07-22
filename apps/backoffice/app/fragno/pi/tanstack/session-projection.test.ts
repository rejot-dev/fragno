import { assert, describe, expect, it } from "vitest";

import { projectPiSessionCollectionRows } from "./session-projection";

const baseInput = {
  workflowName: "interactive-chat-workflow",
  sessionId: "session-1",
  workflowSteps: [],
  workflowStepEmissions: [],
};

describe("projectPiSessionCollectionRows", () => {
  it("returns an empty loading projection while the local instance synchronizes", () => {
    const projection = projectPiSessionCollectionRows({
      ...baseInput,
      instance: null,
      synchronized: false,
    });

    assert(projection.status === "loading");
    expect(projection.state).toEqual({ messages: [] });
    expect(projection.completedStepKeys).toEqual([]);
    expect(projection.error).toBeNull();
  });

  it("reports a missing session only after synchronization completes", () => {
    const projection = projectPiSessionCollectionRows({
      ...baseInput,
      instance: null,
      synchronized: true,
    });

    assert(projection.status === "error");
    expect(projection.error?.message).toContain("session-1 was not found");
    expect(projection.state).toEqual({ messages: [] });
  });

  it("keeps a projected local instance non-interactive until all related rows synchronize", () => {
    const projection = projectPiSessionCollectionRows({
      ...baseInput,
      instance: { status: "waiting" },
      synchronized: false,
    });

    assert(projection.status === "loading");
    assert(!projection.readyForInput);
    assert(projection.statusText === "Loading…");
    expect(projection.state).toEqual({ messages: [] });
  });
});
