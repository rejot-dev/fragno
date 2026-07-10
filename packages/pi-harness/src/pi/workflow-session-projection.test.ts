import { describe, expect, it, assert } from "vitest";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, type UserMessage } from "@earendil-works/pi-ai";

import {
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionStep,
} from "./workflow-session-projection";

const workflowName = "interactive-chat";
const sessionId = "session-1";
const instance = { status: "active" };

const assistantMessage = (text: string) => fauxAssistantMessage(fauxText(text), { timestamp: 1 });

const userMessage = (text: string): UserMessage => ({
  role: "user",
  content: [fauxText(text)],
  timestamp: 1,
});

const messageEntry = (
  id: string,
  text: string,
  options: { role?: "assistant" | "user"; parentId?: string | null } = {},
): SessionTreeEntry => ({
  type: "message",
  id,
  parentId: options.parentId ?? null,
  timestamp: "2026-07-03T00:00:00.000Z",
  message: options.role === "user" ? userMessage(text) : assistantMessage(text),
});

const textContent = (message: AgentMessage) =>
  (message as AgentMessage & { content: readonly [{ text: string }] }).content[0].text;

const completedStep = (
  stepKey: string,
  entries: readonly SessionTreeEntry[],
): PiWorkflowSessionProjectionStep => ({
  stepKey,
  type: "do",
  status: "completed",
  waitEventType: null,
  result: {
    type: "harness-run",
    operation: "prompt",
    entries: [...entries],
    appendedEntries: [...entries],
    leafId: entries.at(-1)?.id ?? null,
  },
});

const waitingCommandStep = (): PiWorkflowSessionProjectionStep => ({
  stepKey: "waitForEvent:command",
  type: "waitForEvent",
  status: "waiting",
  waitEventType: "command",
  result: null,
});

const harnessEmission = (
  stepKey: string,
  event: unknown,
  index: number,
): PiWorkflowSessionProjectionEmission => {
  const eventRecord =
    event && typeof event === "object" ? (event as Record<string, unknown>) : null;
  const payload =
    eventRecord?.["type"] === "message_update"
      ? {
          kind: "harness-message-update",
          update: {
            type: "message_update",
            assistantMessageEvent: eventRecord["assistantMessageEvent"],
          },
        }
      : { kind: "harness-event", event };

  return {
    stepKey,
    createdAt: new Date(index),
    payload: payload as never,
  };
};

describe("projectPiWorkflowSession", () => {
  it("projects completed durable messages and command readiness", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("do:first", [
          messageEntry("user-1", "hello", { role: "user" }),
          messageEntry("assistant-1", "hi", { parentId: "user-1" }),
        ]),
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.state.messages.map(textContent)).toEqual(["hello", "hi"]);
    expect(projection.completedStepKeys).toEqual(["do:first"]);
    expect(projection.draftAgentMessage).toBeNull();
    assert(projection.readyForInput);
    expect(projection.statusText).toBeNull();
  });

  it("keeps live assistant updates in draft state and settles on message_end", () => {
    const stepKey = "do:streaming";
    const partial = assistantMessage("hel");
    const final = assistantMessage("hello");

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessEmission(stepKey, { type: "message_start", message: partial }, 1),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: partial,
            assistantMessageEvent: {
              type: "text_delta",
              partial,
              contentIndex: 0,
              delta: "hel",
            },
          },
          2,
        ),
        harnessEmission(stepKey, { type: "message_end", message: final }, 3),
      ],
    });

    expect(projection.state.messages.map(textContent)).toEqual(["hello"]);
    expect(projection.draftAgentMessage).toBeNull();
    assert(!projection.readyForInput);
    assert(projection.statusText === "Working…");
  });

  it("reconstructs live assistant text from delta-only message updates", () => {
    const stepKey = "do:delta-only";

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessEmission(stepKey, { type: "message_start", message: assistantMessage("") }, 1),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
          },
          2,
        ),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
          },
          3,
        ),
      ],
    });

    assert(projection.draftAgentMessage?.assistant);
    expect(textContent(projection.draftAgentMessage.assistant)).toEqual("hello");
    assert(projection.statusText === "Writing…");
    assert(!projection.readyForInput);
  });

  it("does not mutate message_start emissions while applying compact deltas", () => {
    const stepKey = "do:immutable-input";
    const startMessage = assistantMessage("");

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessEmission(stepKey, { type: "message_start", message: startMessage }, 1),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
          },
          2,
        ),
      ],
    });

    assert(projection.draftAgentMessage?.assistant);
    assert(textContent(projection.draftAgentMessage.assistant) === "hello");
    assert(textContent(startMessage) === "");
  });

  it("projects draft thinking, tool calls, running tools, failed tool results, and status text", () => {
    const stepKey = "do:tool";
    const thinking = fauxAssistantMessage({ type: "thinking", thinking: "plan" }, { timestamp: 1 });
    const toolMessage = fauxAssistantMessage(
      { type: "toolCall", id: "tool-1", name: "write", arguments: { path: "/tmp/a" } },
      { timestamp: 1 },
    );

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: thinking,
            assistantMessageEvent: { type: "thinking_delta", partial: thinking, contentIndex: 0 },
          },
          1,
        ),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: toolMessage,
            assistantMessageEvent: {
              type: "toolcall_end",
              partial: toolMessage,
              contentIndex: 0,
              toolCall: toolMessage.content[0],
            },
          },
          2,
        ),
        harnessEmission(
          stepKey,
          {
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "write",
            args: { path: "/tmp/a" },
          },
          3,
        ),
        harnessEmission(
          stepKey,
          {
            type: "tool_execution_update",
            toolCallId: "tool-1",
            toolName: "write",
            args: { path: "/tmp/a" },
            partialResult: { progress: 1 },
          },
          4,
        ),
        harnessEmission(
          stepKey,
          {
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "write",
            result: { ok: false },
            isError: true,
          },
          5,
        ),
        harnessEmission(
          stepKey,
          {
            type: "tool_execution_start",
            toolCallId: "tool-2",
            toolName: "read",
            args: { path: "/tmp/a" },
          },
          6,
        ),
        harnessEmission(
          stepKey,
          {
            type: "tool_execution_end",
            toolCallId: "tool-2",
            toolName: "read",
            result: { ok: true },
            isError: false,
          },
          7,
        ),
      ],
    });

    assert(projection.draftAgentMessage?.activity === "running_tools");
    expect(projection.draftAgentMessage?.tools["tool-1"]).toMatchObject({
      name: "write",
      status: "done",
      partialResult: { progress: 1 },
      result: { ok: false },
      isError: true,
    });
    expect(projection.draftAgentMessage?.tools["tool-2"]).toMatchObject({
      name: "read",
      status: "done",
      result: { ok: true },
      isError: false,
    });
    assert(projection.statusText === "Running tool calls…");
    assert(!projection.readyForInput);
  });

  it("skips completed-step emissions, preserves emission ordering, dedupes entries, and follows branch leaves", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("do:complete", [
          messageEntry("root", "root", { role: "user" }),
          messageEntry("old", "old", { parentId: "root" }),
        ]),
        completedStep("do:update", [
          messageEntry("old", "updated", { parentId: "root" }),
          messageEntry("branch", "branch", { parentId: "root" }),
          {
            type: "leaf",
            id: "leaf",
            parentId: "branch",
            targetId: "branch",
            timestamp: "2026-07-03T00:00:00.000Z",
          },
        ]),
      ],
      workflowStepEmissions: [
        harnessEmission(
          "do:complete",
          { type: "message_end", message: assistantMessage("ignored") },
          1,
        ),
        harnessEmission(
          "do:live-b",
          { type: "message_end", message: assistantMessage("live b") },
          2,
        ),
        harnessEmission(
          "do:live-a",
          { type: "message_end", message: assistantMessage("live a") },
          3,
        ),
      ],
    });

    expect(projection.state.messages.map(textContent)).toEqual([
      "root",
      "branch",
      "live b",
      "live a",
    ]);
    expect(projection.completedStepKeys).toEqual(["do:complete", "do:update"]);
  });

  it("reports missing sessions", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance: null,
      workflowSteps: [],
      workflowStepEmissions: [],
    });

    assert(!projection.sessionFound);
    assert(projection.status === "error");
  });
});
