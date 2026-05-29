import { describe, expect, expectTypeOf, test } from "vitest";

import { Type } from "typebox";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { definePiTool } from "../dsl";
import { createAssistantStreamScript, mockModel } from "../pi-test-utils";
import type { PiAgentDefinition, PiToolRegistry } from "../types";
import { restoreAgentTurnFromEvents, runAgentTurn } from "./agent-runner";
import { collectPiToolCallResults, createPiToolCallAccessor } from "./tool-call-results";

const userMessage = (text: string): Extract<AgentMessage, { role: "user" }> => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

const assistantMessage = (
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
  stopReason: Extract<AgentMessage, { role: "assistant" }>["stopReason"] = "stop",
): Extract<AgentMessage, { role: "assistant" }> => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

const toolResultMessage = (toolCallId: string): Extract<AgentMessage, { role: "toolResult" }> => ({
  role: "toolResult",
  toolCallId,
  toolName: "lookup",
  content: [{ type: "text", text: "result" }],
  details: {},
  isError: false,
  timestamp: 3,
});

describe("restoreAgentTurnFromEvents", () => {
  test("continues instead of replaying a prompt when the prompt message was already emitted", () => {
    const promptMessage = userMessage("hello");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
    });
  });

  test("finishes from a terminal assistant message without another model call", () => {
    const promptMessage = userMessage("hello");
    const finalMessage = assistantMessage([{ type: "text", text: "hi" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: finalMessage },
        { type: "message_end", message: finalMessage },
        { type: "agent_end", messages: [promptMessage, finalMessage] },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "finish",
      stopReason: "stop",
      messages: [promptMessage, finalMessage],
      errorMessage: null,
    });
  });

  test("keeps base messages when there are no restorable events", () => {
    const existing = assistantMessage([{ type: "text", text: "base" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [existing],
      operation: { mode: "prompt", promptInput: { text: "next" } },
      events: [],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "prompt", promptInput: { text: "next" } },
      messages: [existing],
      events: [],
    });
  });

  test("ignores assistant-only prompt restore state", () => {
    const finalMessage = assistantMessage([{ type: "text", text: "hi" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "message_start", message: finalMessage },
        { type: "message_end", message: finalMessage },
        { type: "agent_end", messages: [finalMessage] },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      messages: [],
      events: [],
    });
  });

  test("rolls back an assistant tool call that did not finish producing tool results", () => {
    const promptMessage = userMessage("lookup");
    const toolCallMessage = assistantMessage(
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      "toolUse",
    );

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "lookup", args: {} },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
      ],
    });
  });

  test("continues from restored tool results when a tool turn completed", () => {
    const promptMessage = userMessage("lookup");
    const toolCallMessage = assistantMessage(
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      "toolUse",
    );
    const resultMessage = toolResultMessage("call-1");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "message_start", message: resultMessage },
        { type: "message_end", message: resultMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage, toolCallMessage, resultMessage],
    });
  });

  test("drops an assistant stream that started but never ended", () => {
    const promptMessage = userMessage("hello");
    const partialMessage = assistantMessage([{ type: "text", text: "hel" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: partialMessage },
        {
          type: "message_update",
          message: partialMessage,
          assistantMessageEvent: { type: "text_delta" },
        },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
      events: [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
      ],
    });
  });

  test("drops all events when no message reached message_end", () => {
    const baseMessage = userMessage("continue from here");
    const partialMessage = assistantMessage([{ type: "text", text: "hel" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [baseMessage],
      operation: { mode: "continue" },
      events: [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: partialMessage },
        {
          type: "message_update",
          message: partialMessage,
          assistantMessageEvent: { type: "text_delta" },
        },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [baseMessage],
      events: [],
    });
  });

  test("restores the final message_end payload instead of message_update partials", () => {
    const promptMessage = userMessage("hello");
    const partialMessage = assistantMessage([{ type: "text", text: "hel" }]);
    const finalMessage = assistantMessage([{ type: "text", text: "hello" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: partialMessage },
        {
          type: "message_update",
          message: partialMessage,
          assistantMessageEvent: { type: "text_delta" },
        },
        { type: "message_end", message: finalMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "finish",
      messages: [promptMessage, finalMessage],
      errorMessage: null,
    });
  });

  test("restores a message_end even if the matching message_start was not persisted", () => {
    const promptMessage = userMessage("hello");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [{ type: "message_end", message: promptMessage }] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
      events: [{ type: "message_end", message: promptMessage }],
    });
  });

  test("finishes from a terminal assistant message even before agent_end is emitted", () => {
    const promptMessage = userMessage("hello");
    const finalMessage = assistantMessage([{ type: "text", text: "hi" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: finalMessage },
        { type: "message_end", message: finalMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "finish",
      stopReason: "stop",
      messages: [promptMessage, finalMessage],
      errorMessage: null,
    });
  });

  test("finishes from a restored error assistant message", () => {
    const promptMessage = userMessage("hello");
    const errorMessage = {
      ...assistantMessage([{ type: "text", text: "failed" }], "error"),
      errorMessage: "provider failed",
    };

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "hello" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: errorMessage },
        { type: "message_end", message: errorMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "finish",
      stopReason: "error",
      messages: [promptMessage, errorMessage],
      errorMessage: "provider failed",
    });
  });

  test("rolls back a multi-tool assistant message until every requested tool result is present", () => {
    const promptMessage = userMessage("lookup twice");
    const toolCallMessage = assistantMessage(
      [
        { type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "one" } },
        { type: "toolCall", id: "call-2", name: "lookup", arguments: { query: "two" } },
      ],
      "toolUse",
    );
    const firstResultMessage = toolResultMessage("call-1");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup twice" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "lookup", args: {} },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "lookup",
          result: { content: [{ type: "text", text: "one" }], details: {} },
          isError: false,
        },
        { type: "message_start", message: firstResultMessage },
        { type: "message_end", message: firstResultMessage },
        { type: "tool_execution_start", toolCallId: "call-2", toolName: "lookup", args: {} },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
      ],
    });
  });

  test("restores complete parallel tool results in assistant source order", () => {
    const promptMessage = userMessage("lookup twice");
    const toolCallMessage = assistantMessage(
      [
        { type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "one" } },
        { type: "toolCall", id: "call-2", name: "lookup", arguments: { query: "two" } },
      ],
      "toolUse",
    );
    const firstResultMessage = toolResultMessage("call-1");
    const secondResultMessage = toolResultMessage("call-2");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup twice" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "lookup", args: {} },
        { type: "tool_execution_start", toolCallId: "call-2", toolName: "lookup", args: {} },
        {
          type: "tool_execution_end",
          toolCallId: "call-2",
          toolName: "lookup",
          result: { content: [{ type: "text", text: "two" }], details: {} },
          isError: false,
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "lookup",
          result: { content: [{ type: "text", text: "one" }], details: {} },
          isError: false,
        },
        { type: "message_start", message: firstResultMessage },
        { type: "message_end", message: firstResultMessage },
        { type: "message_start", message: secondResultMessage },
        { type: "message_end", message: secondResultMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage, toolCallMessage, firstResultMessage, secondResultMessage],
    });
  });

  test("does not synthesize a tool result from tool_execution_end alone", () => {
    const promptMessage = userMessage("lookup");
    const toolCallMessage = assistantMessage(
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      "toolUse",
    );

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "lookup", args: {} },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "lookup",
          result: { content: [{ type: "text", text: "result" }], details: {} },
          isError: false,
        },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
      ],
    });
  });

  test("drops a tool result message that started but never reached message_end", () => {
    const promptMessage = userMessage("lookup");
    const toolCallMessage = assistantMessage(
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      "toolUse",
    );
    const resultMessage = toolResultMessage("call-1");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "lookup", args: {} },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "lookup",
          result: { content: [{ type: "text", text: "result" }], details: {} },
          isError: false,
        },
        { type: "message_start", message: resultMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage],
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
      ],
    });
  });

  test("finishes a continuation run from a restored terminal assistant message", () => {
    const baseMessage = userMessage("already in context");
    const finalMessage = assistantMessage([{ type: "text", text: "continued" }]);

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [baseMessage],
      operation: { mode: "continue" },
      events: [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: finalMessage },
        { type: "message_end", message: finalMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "finish",
      stopReason: "stop",
      messages: [baseMessage, finalMessage],
      errorMessage: null,
    });
  });

  test("finishes a completed tool-termination run when agent_end was emitted", () => {
    const promptMessage = userMessage("lookup");
    const toolCallMessage = assistantMessage(
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      "toolUse",
    );
    const resultMessage = toolResultMessage("call-1");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "lookup" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: toolCallMessage },
        { type: "message_end", message: toolCallMessage },
        { type: "message_start", message: resultMessage },
        { type: "message_end", message: resultMessage },
        { type: "turn_end", message: toolCallMessage, toolResults: [resultMessage] },
        { type: "agent_end", messages: [promptMessage, toolCallMessage, resultMessage] },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "finish",
      stopReason: "toolUse",
      messages: [promptMessage, toolCallMessage, resultMessage],
      errorMessage: null,
    });
  });

  test("restores queued steering messages and continues from the latest user message", () => {
    const promptMessage = userMessage("initial");
    const firstAssistantMessage = assistantMessage([{ type: "text", text: "working" }]);
    const steeringMessage = userMessage("also consider docs");

    const restore = restoreAgentTurnFromEvents({
      baseMessages: [],
      operation: { mode: "prompt", promptInput: { text: "initial" } },
      events: [
        { type: "message_start", message: promptMessage },
        { type: "message_end", message: promptMessage },
        { type: "message_start", message: firstAssistantMessage },
        { type: "message_end", message: firstAssistantMessage },
        { type: "turn_end", message: firstAssistantMessage, toolResults: [] },
        { type: "turn_start" },
        { type: "message_start", message: steeringMessage },
        { type: "message_end", message: steeringMessage },
      ] as AgentEvent[],
    });

    expect(restore).toMatchObject({
      type: "run",
      operation: { mode: "continue" },
      messages: [promptMessage, firstAssistantMessage, steeringMessage],
    });
  });
});

describe("runAgentTurn", () => {
  test("passes per-run afterToolCall hooks to the agent", async () => {
    const { streamFn } = createAssistantStreamScript()
      .toolCall("lookup", { id: "call-1", args: { query: "fragno" } })
      .text("done")
      .build();
    const agent: PiAgentDefinition = {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
      tools: ["lookup"],
      streamFn,
    };
    const lookupParameters = Type.Object({ query: Type.String() });
    const lookupTool = definePiTool({
      name: "lookup",
      description: "Lookup a query.",
      label: "Lookup",
      parameters: lookupParameters,
      async execute(_toolCallId, params) {
        expectTypeOf(params).toMatchObjectType<{ query: string }>();
        return {
          content: [{ type: "text", text: "original" }],
          details: { source: "tool" },
        };
      },
    });
    const tools: PiToolRegistry = { lookup: lookupTool };

    const result = await runAgentTurn(
      { mode: "prompt", promptInput: { text: "search" } },
      {
        agent,
        session: { sessionId: "session-1", agentName: "default", workflowName: "test" },
        turn: { tools, messages: [], turnId: "turn-1" },
      },
      {},
      {
        afterToolCall: async () => ({
          content: [{ type: "text", text: "overridden" }],
          details: { source: "hook" },
        }),
      },
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: expect.objectContaining({
          content: [{ type: "text", text: "overridden" }],
          details: { source: "hook" },
        }),
      }),
    );
  });

  test("stops on matching decision tools and exposes the typed tool result", async () => {
    const { streamFn } = createAssistantStreamScript()
      .toolCall("classify", { id: "call-1", args: { request: "broken" } })
      .build();
    const agent: PiAgentDefinition = {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
      tools: ["classify"],
      streamFn,
    };
    const classifyTool = definePiTool({
      name: "classify",
      description: "Classify a request.",
      label: "Classify",
      parameters: Type.Object({ request: Type.String() }),
      async execute() {
        return {
          content: [{ type: "text", text: "classified" }],
          details: { kind: "bug" as const, confidence: 0.91 },
        };
      },
    });
    const tools: PiToolRegistry = { classify: classifyTool };

    const result = await runAgentTurn(
      { mode: "prompt", promptInput: { text: "classify this" } },
      {
        agent,
        session: { sessionId: "session-1", agentName: "default", workflowName: "test" },
        turn: { tools, messages: [], turnId: "turn-1" },
      },
      {},
      { stopOnTools: ["classify"] },
    );

    const toolCalls = collectPiToolCallResults(result.events);
    const toolCall = createPiToolCallAccessor(toolCalls, classifyTool).latest();
    const details = toolCall.details;
    if (!details) {
      throw new Error("Expected tool call details.");
    }
    const kind: "bug" = details.kind;
    expect(kind).toBe("bug");
    expect(toolCall).toMatchObject({
      toolName: "classify",
      args: { request: "broken" },
      details: { kind: "bug", confidence: 0.91 },
      result: { terminate: true },
    });
  });
});
