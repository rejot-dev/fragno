import { describe, expect, it, assert } from "vitest";

import { projectPiSessionInteraction } from "./session-interaction";

describe("projectPiSessionInteraction", () => {
  it("preserves compaction state without component-local pending state", () => {
    const interaction = projectPiSessionInteraction({
      sessionDisabled: false,
      sending: false,
      localCompactionPending: false,
      projection: {
        activeCommand: { commandId: "compact-1", kind: "compact" },
        activity: "working",
        readyForInput: false,
      },
    });

    expect(interaction).toEqual({
      compacting: true,
      readyForInput: false,
      running: true,
      needsNudge: false,
    });
  });

  it("offers a nudge only when no command owns generic live work", () => {
    const interaction = projectPiSessionInteraction({
      sessionDisabled: false,
      sending: false,
      localCompactionPending: false,
      projection: {
        activeCommand: null,
        activity: "working",
        readyForInput: false,
      },
    });

    assert(interaction.needsNudge);
  });
});
