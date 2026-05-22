import { describe, expect, it } from "vitest";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { createAssistantStreamScript, mockModel } from "../pi-test-utils";
import type { PiAgentDefinition } from "../types";
import { runAgentTurn } from "./agent-runner";
import { createPiAgentStepResult } from "./pi-agent-step";
import { projectSessionDetailFromWorkflowHistory } from "./reconstruct-session";

type WorkflowHistoryStepRow = Parameters<
  typeof projectSessionDetailFromWorkflowHistory
>[0]["steps"][number];

const agentRunStep = async (
  stepKey: string,
  userText: string,
  assistantText: string,
  options: { status?: string } = {},
): Promise<WorkflowHistoryStepRow> => {
  const { streamFn } = createAssistantStreamScript().text(assistantText).build();
  const agent: PiAgentDefinition = {
    name: "default",
    systemPrompt: "You are helpful.",
    model: mockModel,
    tools: [],
    streamFn,
  };

  return {
    stepKey,
    status: options.status,
    result: createPiAgentStepResult(
      await runAgentTurn(
        { mode: "prompt", promptInput: { text: userText } },
        {
          agent,
          session: { sessionId: "session-1", agentName: "default", workflowName: "test" },
          turn: { tools: {}, messages: [], turnId: stepKey },
        },
        {},
      ),
    ),
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

const eventMessageEndTexts = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.type === "message_end"
      ? contentTexts("content" in event.message ? event.message.content : undefined)
      : [],
  );

const project = (steps: WorkflowHistoryStepRow[]) =>
  projectSessionDetailFromWorkflowHistory({
    cursorState: { turn: 0, phase: "waiting-for-command", waitingFor: null },
    events: [],
    steps,
  });

describe("projectSessionDetailFromWorkflowHistory", () => {
  it("rebuilds messages from per-step emissions in history order", async () => {
    const first = await agentRunStep("do:command-0-prompt", "how are you?", "I am well.");
    const second = await agentRunStep("do:command-1-prompt", "write me a poem", "A tiny poem.");
    const third = await agentRunStep("do:command-2-prompt", "blablba", "Looks like a test.");

    expect(messageTexts(project([first, second, third]).messages)).toEqual([
      "how are you?",
      "I am well.",
      "write me a poem",
      "A tiny poem.",
      "blablba",
      "Looks like a test.",
    ]);
  });

  it("rebuilds events from per-step emissions in history order", async () => {
    const first = await agentRunStep("do:command-0-prompt", "how are you?", "I am well.");
    const second = await agentRunStep("do:command-1-prompt", "write me a poem", "A tiny poem.");
    const third = await agentRunStep("do:command-2-prompt", "blablba", "Looks like a test.");

    expect(eventMessageEndTexts(project([first, second, third]).events)).toEqual([
      "how are you?",
      "I am well.",
      "write me a poem",
      "A tiny poem.",
      "blablba",
      "Looks like a test.",
    ]);
  });

  it("reconstructs a custom sequential workflow from completed agent-run results", async () => {
    const research = await agentRunStep("do:research", "research cats", "cat facts", {
      status: "completed",
    });
    const write = await agentRunStep("do:write", "draft from facts", "final cat answer", {
      status: "completed",
    });

    expect(messageTexts(project([research, write]).messages)).toEqual([
      "research cats",
      "cat facts",
      "draft from facts",
      "final cat answer",
    ]);
  });

  it("reconstructs a custom parallel workflow from completed nested agent-run results", async () => {
    const security = await agentRunStep(
      "do:parallel-reviews>do:security-review",
      "review security",
      "safe",
      {
        status: "completed",
      },
    );
    const clarity = await agentRunStep(
      "do:parallel-reviews>do:clarity-review",
      "review clarity",
      "clear",
      {
        status: "completed",
      },
    );
    const waiting = await agentRunStep(
      "do:parallel-reviews>do:waiting-review",
      "waiting",
      "ignore",
      {
        status: "waiting",
      },
    );

    expect(messageTexts(project([security, clarity, waiting]).messages)).toEqual([
      "review security",
      "safe",
      "review clarity",
      "clear",
    ]);
  });
});
