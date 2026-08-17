import { describe, expect, it, assert } from "vitest";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";

import {
  PiHarnessEventEncoder,
  type PiHarnessSubscribedEvent,
} from "./harness/agent-harness-event-protocol";
import type { PiHarnessFrontendAgentMessage } from "./harness/agent-harness-event-protocol";
import { PiSessionDataIntegrityError, type PiWorkflowStatus } from "./types";
import {
  createLoadingPiWorkflowSessionProjection,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionStep,
} from "./workflow-session-projection";

const workflowName = "interactive-chat";
const sessionId = "session-1";
const instance = { status: "active" } as const;

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

const agentMessageEntry = (
  id: string,
  message: AgentMessage,
  parentId: string | null,
): SessionTreeEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-07-03T00:00:00.000Z",
  message,
});

const textContent = (message: PiHarnessFrontendAgentMessage) =>
  (message as AgentMessage & { content: readonly [{ text: string }] }).content[0].text;

const completedStep = (
  stepKey: string,
  entries: readonly SessionTreeEntry[],
  value?: unknown,
): PiWorkflowSessionProjectionStep => ({
  stepKey,
  type: "do",
  status: "completed",
  waitEventType: null,
  result: {
    type: "harness-run",
    outcome: "completed",
    appendedEntries: [...entries],
    leafId: entries.at(-1)?.id ?? null,
    value,
  },
});

const waitingCommandStep = (): PiWorkflowSessionProjectionStep => ({
  stepKey: "waitForEvent:command",
  type: "waitForEvent",
  status: "waiting",
  waitEventType: "command",
  result: null,
});

const eventEncodersByStepKey = new Map<string, PiHarnessEventEncoder>();

const harnessOperationStartEmission = (
  stepKey: string,
  index = 0,
): PiWorkflowSessionProjectionEmission => {
  eventEncodersByStepKey.set(stepKey, new PiHarnessEventEncoder());
  return {
    stepKey,
    executionId: `${stepKey}:execution`,
    epoch: `${stepKey}:epoch`,
    sequence: index,
    createdAt: new Date(index),
    payload: {
      kind: "harness-operation-start",
      operationId: `${stepKey}:operation`,
      replay: { protocol: "pi-harness-operation", version: 1 },
    },
  };
};

const harnessEmission = (
  stepKey: string,
  event: PiHarnessSubscribedEvent,
  index: number,
): PiWorkflowSessionProjectionEmission => {
  const encoder = eventEncodersByStepKey.get(stepKey) ?? new PiHarnessEventEncoder();
  eventEncodersByStepKey.set(stepKey, encoder);
  return {
    stepKey,
    executionId: `${stepKey}:execution`,
    epoch: `${stepKey}:epoch`,
    sequence: index,
    createdAt: new Date(index),
    payload: { kind: "harness-event", event: encoder.encode(event) },
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

    expect(projection.contextMessages.map(textContent)).toEqual(["hello", "hi"]);
    expect(projection.completedStepKeys).toEqual(["do:first"]);
    expect(projection.draftAgentMessage).toBeNull();
    assert(projection.readyForInput);
    expect(projection.activity).toBeNull();
  });

  it("projects interrupted operations in the timeline without adding them to model context", () => {
    const userEntry = messageEntry("user-1", "hello", { role: "user" });

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        {
          stepKey: "do:interrupted",
          type: "do",
          status: "completed",
          waitEventType: null,
          result: {
            type: "harness-run",
            outcome: "aborted",
            appendedEntries: [userEntry],
            leafId: userEntry.id,
          },
        },
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.contextMessages.map((message) => message.role)).toEqual(["user"]);
    expect(projection.timelineMessages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [], stopReason: "aborted" },
    ]);
  });

  it("does not duplicate an aborted assistant already recorded by Pi", () => {
    const userEntry = messageEntry("user-1", "hello", { role: "user" });
    const abortedAssistant = assistantMessage("");
    abortedAssistant.stopReason = "aborted";
    const assistantEntry = agentMessageEntry("assistant-1", abortedAssistant, userEntry.id);

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        {
          stepKey: "do:aborted-by-user",
          type: "do",
          status: "completed",
          waitEventType: null,
          result: {
            type: "harness-run",
            outcome: "aborted",
            appendedEntries: [userEntry, assistantEntry],
            leafId: assistantEntry.id,
          },
        },
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.timelineMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(projection.timelineMessages[1]).toMatchObject({ stopReason: "aborted" });
  });

  it("retains recovered tool progress before the projected interruption", () => {
    const toolCallAssistant = assistantMessage("");
    toolCallAssistant.stopReason = "toolUse";
    toolCallAssistant.content = [
      fauxToolCall("read-a", { path: "a" }, { id: "call-a" }),
      fauxToolCall("read-b", { path: "b" }, { id: "call-b" }),
    ];
    const realToolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "read-a",
      content: [fauxText("contents:a")],
      isError: false,
      timestamp: 2,
    };
    const interruptedToolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "read-b",
      content: [fauxText("Tool execution interrupted before completion.")],
      isError: true,
      timestamp: 3,
    };
    const entries = [
      agentMessageEntry("user-1", userMessage("inspect both"), null),
      agentMessageEntry("assistant-tools", toolCallAssistant, "user-1"),
      agentMessageEntry("result-a", realToolResult, "assistant-tools"),
      agentMessageEntry("result-b", interruptedToolResult, "result-a"),
    ];

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        {
          stepKey: "do:interrupted-tools",
          type: "do",
          status: "completed",
          waitEventType: null,
          result: {
            type: "harness-run",
            outcome: "aborted",
            appendedEntries: entries,
            leafId: "result-b",
          },
        },
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.contextMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(projection.timelineMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
    expect(projection.timelineMessages.at(-1)).toMatchObject({
      content: [],
      stopReason: "aborted",
    });
  });

  it("projects the active command from its command-start emission", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        {
          stepKey: "command:compact-1",
          type: "do",
          status: "running",
          waitEventType: null,
          result: null,
        },
      ],
      workflowStepEmissions: [
        {
          stepKey: "command:compact-1",
          executionId: "command:compact-1:execution",
          epoch: "command:compact-1:epoch",
          sequence: 1,
          payload: {
            kind: "pi-session-command-start",
            command: { commandId: "compact-1", kind: "compact" },
          },
          createdAt: new Date("2026-08-06T12:00:00.000Z"),
        },
      ],
    });

    expect(projection.activeCommand).toEqual({ commandId: "compact-1", kind: "compact" });
    assert(projection.activity === "working");
    assert(!projection.readyForInput);
  });

  it("ignores command-start emissions after their command step completes", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("command:compact-1", [], {
          kind: "compact",
          commandId: "compact-1",
          status: "succeeded",
        }),
        waitingCommandStep(),
      ],
      workflowStepEmissions: [
        {
          stepKey: "command:compact-1",
          executionId: "command:compact-1:execution",
          epoch: "command:compact-1:epoch",
          sequence: 1,
          payload: {
            kind: "pi-session-command-start",
            command: { commandId: "compact-1", kind: "compact" },
          },
          createdAt: new Date("2026-08-06T12:00:00.000Z"),
        },
      ],
    });

    expect(projection.activeCommand).toBeNull();
    assert(projection.readyForInput);
  });

  it("projects a rejected compaction without making the session terminal", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("command:compact-1", [], {
          kind: "compact",
          commandId: "compact-1",
          status: "rejected",
          code: "nothing_to_compact",
          message: "Nothing to compact.",
        }),
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.latestCommandCompactOutcome).toEqual({
      kind: "compact",
      commandId: "compact-1",
      status: "rejected",
      code: "nothing_to_compact",
      message: "Nothing to compact.",
    });
    expect(projection.compactOutcomesByCommandId["compact-1"]).toEqual(
      projection.latestCommandCompactOutcome,
    );
    assert(projection.readyForInput);
    expect(projection.activity).toBeNull();
  });

  it("ignores persisted compact values from aborted command results", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        {
          stepKey: "command:compact-aborted",
          type: "do",
          status: "completed",
          waitEventType: null,
          result: {
            type: "harness-run",
            outcome: "aborted",
            appendedEntries: [],
            leafId: null,
            value: {
              kind: "compact",
              commandId: "compact-aborted",
              status: "rejected",
            },
          },
        },
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.latestCommandCompactOutcome).toBeNull();
    expect(projection.compactOutcomesByCommandId).toEqual({});
  });

  it("clears an older compaction failure after a later command completes", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("command:compact-1", [], {
          kind: "compact",
          commandId: "compact-1",
          status: "rejected",
          code: "compaction_failed",
          message: "Provider unavailable.",
        }),
        completedStep("command:prompt-2", [messageEntry("user-2", "continue", { role: "user" })]),
        waitingCommandStep(),
      ],
      workflowStepEmissions: [],
    });

    expect(projection.latestCommandCompactOutcome).toBeNull();
    expect(projection.compactOutcomesByCommandId["compact-1"]).toEqual({
      kind: "compact",
      commandId: "compact-1",
      status: "rejected",
      code: "compaction_failed",
      message: "Provider unavailable.",
    });
  });

  it("keeps compaction summaries at their chronological timeline position", () => {
    const retainedAssistant = assistantMessage("retained reply");
    const entries: SessionTreeEntry[] = [
      messageEntry("user-1", "old prompt", { role: "user" }),
      messageEntry("assistant-1", "old reply", { parentId: "user-1" }),
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "assistant-1",
        timestamp: "2026-07-03T00:01:00.000Z",
        summary: "Earlier context summary",
        firstKeptEntryId: "assistant-1",
        tokensBefore: 25_000,
        retainedTail: [retainedAssistant],
        fromHook: false,
      },
      messageEntry("user-2", "new prompt", { role: "user", parentId: "compaction-1" }),
    ];

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [completedStep("do:compacted", entries), waitingCommandStep()],
      workflowStepEmissions: [],
    });

    expect(projection.timelineMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "compactionSummary",
      "user",
    ]);
    expect(projection.contextMessages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
    ]);
  });

  it("keeps every message from consecutive completed steps", () => {
    const previousEntries = [
      agentMessageEntry("previous-user", userMessage("previous prompt"), null),
      agentMessageEntry("previous-assistant", assistantMessage("previous reply"), "previous-user"),
    ];
    const toolCallMessage = fauxAssistantMessage(
      fauxToolCall("lookup", { query: "current" }, { id: "tool-call-1" }),
      { stopReason: "toolUse", timestamp: 1 },
    );
    const toolResultMessage: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tool-call-1",
      toolName: "lookup",
      content: [fauxText("tool result")],
      details: { found: true },
      isError: false,
      timestamp: 1,
    };
    const deltaEntries = [
      agentMessageEntry("current-user", userMessage("current prompt"), "previous-assistant"),
      agentMessageEntry("current-tool-call", toolCallMessage, "current-user"),
      agentMessageEntry("current-tool-result", toolResultMessage, "current-tool-call"),
      agentMessageEntry(
        "current-assistant",
        assistantMessage("current reply"),
        "current-tool-result",
      ),
    ];

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("do:previous", previousEntries),
        completedStep("do:current", deltaEntries),
      ],
    });

    expect(projection.contextMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("replaces earlier context when a later step compacts the session", () => {
    const oldUser = messageEntry("old-user", "old prompt", { role: "user" });
    const oldAssistant = messageEntry("old-assistant", "old reply", {
      parentId: "old-user",
    });
    const compaction: SessionTreeEntry = {
      type: "compaction",
      id: "compaction-1",
      parentId: "old-assistant",
      timestamp: "2026-07-03T00:01:00.000Z",
      summary: "Compacted context",
      tokensBefore: 25_000,
      retainedTail: [assistantMessage("old reply")],
    };

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("command:prompt-1", [oldUser, oldAssistant]),
        completedStep("command:compact-2", [compaction], {
          kind: "compact",
          commandId: "compact-2",
          status: "succeeded",
        }),
        waitingCommandStep(),
      ],
    });

    expect(projection.contextMessages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
    ]);
    expect(projection.timelineMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "compactionSummary",
    ]);
  });

  it("applies a navigation entry using entries from earlier completed steps", () => {
    const root = messageEntry("root", "Root", { role: "user" });
    const branchA = messageEntry("branch-a", "Branch A", { parentId: "root" });
    const branchB = messageEntry("branch-b", "Branch B", { parentId: "root" });
    const previousLeaf: SessionTreeEntry = {
      type: "leaf",
      id: "leaf-b",
      parentId: "branch-b",
      timestamp: "2026-07-03T00:00:00.000Z",
      targetId: "branch-b",
    };
    const navigationLeaf: SessionTreeEntry = {
      type: "leaf",
      id: "leaf-a",
      parentId: "branch-b",
      timestamp: "2026-07-03T00:00:01.000Z",
      targetId: "branch-a",
    };

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        completedStep("do:branches", [root, branchA, branchB, previousLeaf]),
        {
          stepKey: "do:navigate",
          type: "do",
          status: "completed",
          waitEventType: null,
          result: {
            type: "harness-run",
            appendedEntries: [navigationLeaf],
            leafId: "branch-a",
          },
        },
      ],
    });

    expect(projection.contextMessages.map(textContent)).toEqual(["Root", "Branch A"]);
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
        harnessOperationStartEmission(stepKey),
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

    expect(projection.contextMessages.map(textContent)).toEqual(["hello"]);
    expect(projection.draftAgentMessage).toBeNull();
    assert(!projection.readyForInput);
    assert(projection.activity === "working");
  });

  it("does not mutate message_update emissions while applying later deltas", () => {
    const stepKey = "do:message-update-immutable-input";
    const updateMessage = assistantMessage("");

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessOperationStartEmission(stepKey),
        harnessEmission(
          stepKey,
          { type: "message_start", message: fauxAssistantMessage([], { timestamp: 1 }) },
          1,
        ),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: updateMessage,
            assistantMessageEvent: {
              type: "text_start",
              contentIndex: 0,
              partial: updateMessage,
            },
          },
          2,
        ),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: assistantMessage("hello"),
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "hello",
              partial: assistantMessage("hello"),
            },
          },
          3,
        ),
      ],
    });

    assert(projection.draftAgentMessage?.assistant);
    assert(textContent(projection.draftAgentMessage.assistant) === "hello");
    assert(textContent(updateMessage) === "");
  });

  it("projects live assistant text from full message updates", () => {
    const stepKey = "do:delta-only";

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessOperationStartEmission(stepKey),
        harnessEmission(stepKey, { type: "message_start", message: assistantMessage("") }, 1),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: assistantMessage("hel"),
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "hel",
              partial: assistantMessage("hel"),
            },
          },
          2,
        ),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: assistantMessage("hello"),
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "lo",
              partial: assistantMessage("hello"),
            },
          },
          3,
        ),
      ],
    });

    assert(projection.draftAgentMessage?.assistant);
    expect(textContent(projection.draftAgentMessage.assistant)).toEqual("hello");
    assert(projection.activity === "writing");
    assert(!projection.readyForInput);
  });

  it("does not mutate message_start emissions while projecting full updates", () => {
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
        harnessOperationStartEmission(stepKey),
        harnessEmission(stepKey, { type: "message_start", message: startMessage }, 1),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: assistantMessage("hello"),
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "hello",
              partial: assistantMessage("hello"),
            },
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
      {
        type: "toolCall",
        id: "tool-1",
        name: "write",
        arguments: { path: "/tmp/a" },
        partialJson: '{"path":"/tmp/a"}',
      } as never,
      { timestamp: 1 },
    );

    const toolCall = toolMessage.content[0];
    assert(toolCall?.type === "toolCall");

    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance,
      workflowSteps: [
        { stepKey, type: "do", status: "running", waitEventType: null, result: null },
      ],
      workflowStepEmissions: [
        harnessOperationStartEmission(stepKey),
        harnessEmission(stepKey, { type: "message_start", message: thinking }, 1),
        harnessEmission(
          stepKey,
          {
            type: "message_update",
            message: thinking,
            assistantMessageEvent: {
              type: "thinking_delta",
              partial: thinking,
              contentIndex: 0,
              delta: "plan",
            },
          },
          2,
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
              toolCall,
            },
          },
          3,
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
      argsText: '{"path":"/tmp/a"}',
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
    assert(projection.activity === "running_tools");
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
        harnessOperationStartEmission("do:live-b", 1),
        harnessEmission(
          "do:live-b",
          { type: "message_end", message: assistantMessage("live b") },
          2,
        ),
        harnessOperationStartEmission("do:live-a", 2),
        harnessEmission(
          "do:live-a",
          { type: "message_end", message: assistantMessage("live a") },
          3,
        ),
      ],
    });

    expect(projection.contextMessages.map(textContent)).toEqual([
      "root",
      "branch",
      "live b",
      "live a",
    ]);
    expect(projection.completedStepKeys).toEqual(["do:complete", "do:update"]);
  });

  it("only accepts input while an active or waiting workflow can receive commands", () => {
    for (const status of ["active", "waiting"] satisfies PiWorkflowStatus[]) {
      const projection = projectPiWorkflowSession({
        workflowName,
        sessionId,
        instance: { status },
        workflowSteps: [waitingCommandStep()],
      });
      assert(projection.readyForInput);
    }

    for (const status of [
      "paused",
      "errored",
      "terminated",
      "complete",
    ] satisfies PiWorkflowStatus[]) {
      const projection = projectPiWorkflowSession({
        workflowName,
        sessionId,
        instance: { status },
        workflowSteps: [waitingCommandStep()],
      });
      assert(!projection.readyForInput);
    }
  });

  it("fails fast when persisted session entries have a missing parent or cycle", () => {
    expect(() =>
      projectPiWorkflowSession({
        workflowName,
        sessionId,
        instance,
        workflowSteps: [
          completedStep("do:missing-parent", [
            messageEntry("orphan", "orphan", { parentId: "missing" }),
          ]),
        ],
      }),
    ).toThrow(PiSessionDataIntegrityError);

    expect(() =>
      projectPiWorkflowSession({
        workflowName,
        sessionId,
        instance,
        workflowSteps: [
          completedStep("do:cycle", [
            messageEntry("cycle-a", "a", { parentId: "cycle-b" }),
            messageEntry("cycle-b", "b", { parentId: "cycle-a" }),
          ]),
        ],
      }),
    ).toThrow(PiSessionDataIntegrityError);
  });

  it("fails fast when a persisted compact command outcome is malformed", () => {
    expect(() =>
      projectPiWorkflowSession({
        workflowName,
        sessionId,
        instance,
        workflowSteps: [
          completedStep("command:compact-invalid", [], {
            kind: "compact",
            commandId: "compact-invalid",
            status: "rejected",
          }),
        ],
      }),
    ).toThrow(PiSessionDataIntegrityError);
  });

  it("creates an empty loading projection before workflow data synchronizes", () => {
    const projection = createLoadingPiWorkflowSessionProjection();

    expect(projection.contextMessages).toEqual([]);
    expect(projection.timelineMessages).toEqual([]);
    expect(projection.completedStepKeys).toEqual([]);
    assert(projection.status === "loading");
    assert(!projection.readyForInput);
  });

  it("reports missing sessions", () => {
    const projection = projectPiWorkflowSession({
      workflowName,
      sessionId,
      instance: null,
      workflowSteps: [],
      workflowStepEmissions: [],
    });

    assert(projection.status === "not-found");
    expect(projection.error).toEqual(
      new Error(`Pi session ${workflowName}/${sessionId} was not found.`),
    );
    assert(!projection.readyForInput);
  });
});
