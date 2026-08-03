import { assert, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

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

  it("removes speculative downstream Pi emissions from a losing execution", () => {
    const projection = projectPiSessionCollectionRows({
      ...baseInput,
      instance: { status: "active" },
      workflowSteps: [
        {
          stepKey: "do:contested",
          type: "do",
          status: "completed",
          committedByExecutionId: "winning-execution",
          waitEventType: null,
          result: null,
        },
      ],
      workflowStepEmissions: [
        {
          actor: "user",
          stepKey: "do:contested",
          executionId: "losing-execution",
          epoch: "losing-contested-epoch",
          payload: { phase: "contested" },
          createdAt: new Date("2026-07-30T12:00:00.000Z"),
        },
        {
          actor: "user",
          stepKey: "do:speculative-downstream",
          executionId: "losing-execution",
          epoch: "losing-downstream-epoch",
          payload: {
            kind: "harness-event",
            event: {
              type: "message_start",
              message: fauxAssistantMessage(fauxText("discarded"), { timestamp: 1 }),
            },
          },
          createdAt: new Date("2026-07-30T12:00:01.000Z"),
        },
      ],
      synchronized: true,
    });

    expect(projection.draftAgentMessage).toBeNull();
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
