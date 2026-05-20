import { describe, expect, it } from "vitest";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { projectSessionDetailFromWorkflowHistory } from "./reconstruct-session";

type WorkflowHistoryStepRow = Parameters<
  typeof projectSessionDetailFromWorkflowHistory
>[0]["steps"][number];

const textMessage = (role: "user" | "assistant", text: string): AgentMessage =>
  ({
    role,
    content: [{ type: "text", text }],
    timestamp: 1,
  }) as AgentMessage;

const agentRunStep = (
  stepKey: string,
  userText: string,
  assistantText: string,
): WorkflowHistoryStepRow => {
  const user = textMessage("user", userText);
  const assistant = textMessage("assistant", assistantText);
  const events: AgentEvent[] = [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: user },
    { type: "message_end", message: user },
    { type: "message_start", message: assistant },
    { type: "message_end", message: assistant },
    { type: "turn_end", message: assistant, toolResults: [] },
    { type: "agent_end", messages: [user, assistant] },
  ];

  return {
    stepKey,
    result: {
      type: "agent-run",
      outcome: "completed",
      messages: [user, assistant],
      events,
      errorMessage: null,
    },
  };
};

const contentTexts = (content: unknown) => {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block: unknown) =>
    block && typeof block === "object" && "type" in block && block.type === "text"
      ? [String((block as { text?: unknown }).text)]
      : [],
  );
};

const messageTexts = (messages: AgentMessage[]) =>
  messages.flatMap((message) => contentTexts("content" in message ? message.content : undefined));

const eventMessageTexts = (events: AgentEvent[]) =>
  events.flatMap((event) => {
    if (
      event.type !== "message_start" &&
      event.type !== "message_end" &&
      event.type !== "message_update"
    ) {
      return [];
    }
    return contentTexts("content" in event.message ? event.message.content : undefined);
  });

const project = (steps: WorkflowHistoryStepRow[]) =>
  projectSessionDetailFromWorkflowHistory({
    cursorState: { turn: 0, phase: "waiting-for-command", waitingFor: null },
    events: [],
    steps,
  });

describe("projectSessionDetailFromWorkflowHistory", () => {
  it("rebuilds messages from per-step emissions in command step order", () => {
    const first = agentRunStep("do:command-0-prompt", "how are you?", "I am well.");
    const second = agentRunStep("do:command-1-prompt", "write me a poem", "A tiny poem.");
    const third = agentRunStep("do:command-2-prompt", "blablba", "Looks like a test.");

    expect(messageTexts(project([third, second, first]).messages)).toEqual([
      "how are you?",
      "I am well.",
      "write me a poem",
      "A tiny poem.",
      "blablba",
      "Looks like a test.",
    ]);
  });

  it("uses command step order instead of database row order for events", () => {
    const first = agentRunStep("do:command-0-prompt", "how are you?", "I am well.");
    const second = agentRunStep("do:command-1-prompt", "write me a poem", "A tiny poem.");
    const third = agentRunStep("do:command-2-prompt", "blablba", "Looks like a test.");

    expect(eventMessageTexts(project([third, second, first]).events)).toEqual([
      "how are you?",
      "how are you?",
      "I am well.",
      "I am well.",
      "write me a poem",
      "write me a poem",
      "A tiny poem.",
      "A tiny poem.",
      "blablba",
      "blablba",
      "Looks like a test.",
      "Looks like a test.",
    ]);
  });
});
