import { describe, expect, it } from "vitest";

import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { piHarnessMessageUpdateFromPiEvent } from "./message-update-protocol";

describe("piHarnessMessageUpdateFromPiEvent", () => {
  it("strips Pi's full message and partial snapshots from text deltas", () => {
    const partial = fauxAssistantMessage(fauxText("hello"), { timestamp: 1 });
    const event = {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "lo",
        partial,
      },
    } satisfies Extract<AgentHarnessEvent, { type: "message_update" }>;

    expect(piHarnessMessageUpdateFromPiEvent(event)).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    });
  });
});
