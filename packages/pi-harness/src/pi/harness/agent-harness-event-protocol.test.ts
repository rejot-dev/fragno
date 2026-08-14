import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { Type } from "typebox";

import {
  AgentHarness,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import {
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
} from "../workflows/workflow-agent-harness";
import {
  PiHarnessEventDecoder,
  PiHarnessEventEncoder,
  PiHarnessEventStreamDecoders,
  piHarnessEventProtocol,
  type PiHarnessEncodedEvent,
  type PiHarnessSubscribedEvent,
} from "./agent-harness-event-protocol";
import type {
  PiHarnessFrontendAssistantMessage,
  PiHarnessFrontendEvent,
} from "./agent-harness-event-protocol";
import {
  createAssistantStreamScript,
  type PiHarnessAssistantStreamEvent,
} from "./assistant-stream-script";

const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

const model = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 10_000,
  maxTokens: 2_000,
} satisfies Model<"openai-responses">;

const assistantMessage = (
  content: AssistantMessage["content"] = [],
  options: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 1,
  ...options,
});

const userMessage = (text: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});

const toolResultMessage = (text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text }],
  details: { path: "/tmp/a" },
  isError: false,
  timestamp: 3,
});

const roundTrip = (
  events: readonly PiHarnessSubscribedEvent[],
): { encoded: PiHarnessEncodedEvent[]; decoded: PiHarnessFrontendEvent[] } => {
  const encoder = new PiHarnessEventEncoder();
  const decoder = new PiHarnessEventDecoder();
  const encoded = events.map((event) => encoder.encode(event));
  return { encoded, decoded: encoded.map((event) => decoder.decode(event)) };
};

const expectFrontendProjection = (
  source: readonly PiHarnessSubscribedEvent[],
  decoded: readonly PiHarnessFrontendEvent[],
): void => {
  expect(decoded).toHaveLength(source.length);
  expect(decoded.map((event) => event.type)).toEqual(source.map((event) => event.type));
  expect(decoded).toEqual(source.map(expectedPiHarnessFrontendEvent));
};

const removedFrontendFieldNames = new Set([
  "api",
  "provider",
  "model",
  "responseModel",
  "responseId",
  "diagnostics",
  "textSignature",
  "thinkingSignature",
  "thoughtSignature",
]);

const frontendProjectionFieldPaths = (value: unknown, path = "$event"): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      frontendProjectionFieldPaths(child, `${path}[${index}]`),
    );
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => [
    ...(removedFrontendFieldNames.has(key) ? [`${path}.${key}`] : []),
    ...frontendProjectionFieldPaths(child, `${path}.${key}`),
  ]);
};

const omitFrontendOnlyToolCallFields = ({
  thoughtSignature: _thoughtSignature,
  ...toolCall
}: ToolCall): Omit<ToolCall, "thoughtSignature"> => toolCall;

const omitFrontendOnlyAssistantFields = ({
  api: _api,
  provider: _provider,
  model: _model,
  responseModel: _responseModel,
  responseId: _responseId,
  diagnostics: _diagnostics,
  content,
  ...message
}: AssistantMessage) => ({
  ...message,
  content: content.map((block) => {
    switch (block.type) {
      case "text": {
        const { textSignature: _textSignature, ...text } = block;
        return text;
      }
      case "thinking": {
        const { thinkingSignature: _thinkingSignature, ...thinking } = block;
        return thinking;
      }
      case "toolCall":
        return omitFrontendOnlyToolCallFields(block);
    }

    throw new Error("PI_HARNESS_TEST_UNKNOWN_ASSISTANT_CONTENT");
  }),
});

const omitFrontendOnlyAgentMessageFields = (message: AgentMessage) =>
  message.role === "assistant" ? omitFrontendOnlyAssistantFields(message) : message;

const omitFrontendOnlyAssistantEventFields = (event: AssistantMessageEvent) => ({
  ...event,
  ...("partial" in event
    ? { partial: omitFrontendOnlyAssistantFields(event.partial) }
    : "message" in event
      ? { message: omitFrontendOnlyAssistantFields(event.message) }
      : { error: omitFrontendOnlyAssistantFields(event.error) }),
  ...(event.type === "toolcall_end"
    ? { toolCall: omitFrontendOnlyToolCallFields(event.toolCall) }
    : {}),
});

const messageArrayFields = [
  "messages",
  "toolResults",
  "steer",
  "followUp",
  "nextTurn",
  "clearedSteer",
  "clearedFollowUp",
] as const;

/** Builds the expected round-trip value by omitting only the protocol's documented fields. */
export const expectedPiHarnessFrontendEvent = (
  event: AgentHarnessEvent,
): PiHarnessFrontendEvent => {
  const expected = { ...event } as Record<string, unknown>;

  if ("message" in event) {
    expected["message"] = omitFrontendOnlyAgentMessageFields(event.message);
  }

  for (const field of messageArrayFields) {
    const messages = expected[field];
    if (Array.isArray(messages)) {
      expected[field] = messages.map((message) =>
        omitFrontendOnlyAgentMessageFields(message as AgentMessage),
      );
    }
  }

  if ("assistantMessageEvent" in event) {
    expected["assistantMessageEvent"] = omitFrontendOnlyAssistantEventFields(
      event.assistantMessageEvent,
    );
  }

  return expected as PiHarnessFrontendEvent;
};

const textStreamEvents = (): PiHarnessSubscribedEvent[] => {
  const empty = assistantMessage([]);
  const started = assistantMessage([{ type: "text", text: "" }]);
  const firstDelta = assistantMessage([{ type: "text", text: "hel" }]);
  const secondDelta = assistantMessage([{ type: "text", text: "hello" }]);
  const final = assistantMessage([{ type: "text", text: "hello" }], {
    responseId: "response-1",
  });

  return [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: empty },
    {
      type: "message_update",
      message: started,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
    },
    {
      type: "message_update",
      message: firstDelta,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hel",
        partial: firstDelta,
      },
    },
    {
      type: "message_update",
      message: secondDelta,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "lo",
        partial: secondDelta,
      },
    },
    {
      type: "message_update",
      message: secondDelta,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "hello",
        partial: secondDelta,
      },
    },
    { type: "message_end", message: final },
    { type: "turn_end", message: final, toolResults: [] },
    { type: "save_point", hadPendingMutations: false },
    { type: "agent_end", messages: [final] },
    { type: "settled", nextTurnCount: 0 },
  ];
};

describe("PiHarnessEventEncoder and PiHarnessEventDecoder", () => {
  it("round-trips a complete text stream without changing event resolution", () => {
    const events = textStreamEvents();
    const { encoded, decoded } = roundTrip(events);

    expectFrontendProjection(events, decoded);
    expect(frontendProjectionFieldPaths(encoded)).toEqual([]);
    expect(encoded).toHaveLength(events.length);
    assert(encoded.every((event) => event.protocol === "pi-harness-event" && event.version === 2));
  });

  it("omits reconstructable growing message snapshots from message updates", () => {
    const { encoded } = roundTrip(textStreamEvents());
    const updates = encoded
      .map((envelope) => envelope.event)
      .filter((event) => event.type === "message_update");

    expect(updates).toHaveLength(4);
    expect(updates.at(-1)).toEqual({
      type: "message_update",
      update: { type: "text_end", contentIndex: 0, content: "hello", text: "hello" },
    });
  });

  it("round-trips thinking updates", () => {
    const empty = assistantMessage([]);
    const started = assistantMessage([{ type: "thinking", thinking: "" }]);
    const partial = assistantMessage([{ type: "thinking", thinking: "considering" }]);
    const events: PiHarnessSubscribedEvent[] = [
      { type: "message_start", message: empty },
      {
        type: "message_update",
        message: started,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: started },
      },
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "considering",
          partial,
        },
      },
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "considering",
          partial,
        },
      },
      { type: "message_end", message: partial },
    ];

    expect(roundTrip(events).decoded).toEqual(events.map(expectedPiHarnessFrontendEvent));
  });

  it("round-trips tool-call updates without repeating the assistant message", () => {
    const empty = assistantMessage([]);
    const partialToolCall = {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "/tmp" },
      partialJson: '{"path":"/tmp"',
    } as ToolCall;
    const finalToolCall: ToolCall = {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "/tmp/a" },
    };
    const partial = assistantMessage([partialToolCall]);
    const final = assistantMessage([finalToolCall], { stopReason: "toolUse" });
    const events: PiHarnessSubscribedEvent[] = [
      { type: "message_start", message: empty },
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
      },
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '"}',
          partial,
        },
      },
      {
        type: "message_update",
        message: final,
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: finalToolCall,
          partial: final,
        },
      },
      { type: "message_end", message: final },
    ];

    const { encoded, decoded } = roundTrip(events);
    expect(decoded).toEqual(events.map(expectedPiHarnessFrontendEvent));
    expect(encoded[1]?.event).toMatchObject({
      type: "message_update",
      update: { type: "toolcall_start", toolCall: partialToolCall },
    });
    expect(encoded[1]?.event).not.toHaveProperty("message");
  });

  it("round-trips message references across message, turn, agent, queue, and abort events", () => {
    const user = userMessage("hello");
    const assistant = assistantMessage([{ type: "text", text: "hi" }]);
    const toolResult = toolResultMessage("file contents");
    const events: PiHarnessSubscribedEvent[] = [
      { type: "message_start", message: user },
      { type: "message_end", message: user },
      { type: "message_start", message: assistant },
      { type: "message_end", message: assistant },
      { type: "message_start", message: toolResult },
      { type: "message_end", message: toolResult },
      { type: "turn_end", message: assistant, toolResults: [toolResult] },
      { type: "agent_end", messages: [user, assistant, toolResult] },
      { type: "queue_update", steer: [user], followUp: [user], nextTurn: [user] },
      { type: "abort", clearedSteer: [user], clearedFollowUp: [user] },
    ];

    const { encoded, decoded } = roundTrip(events);
    expect(decoded).toEqual(events.map(expectedPiHarnessFrontendEvent));
    expect(encoded.at(-1)?.event).toEqual({
      type: "abort",
      clearedSteer: [{ kind: "reference", id: 0 }],
      clearedFollowUp: [{ kind: "reference", id: 0 }],
    });
  });

  it("round-trips tool execution events and reuses repeated opaque values", () => {
    const args = { path: "/tmp/a", options: { encoding: "utf8" } };
    const partialResult = {
      content: [{ type: "text", text: "opening" }],
      details: { progress: 0.5 },
    };
    const result = { content: [{ type: "text", text: "done" }], details: { progress: 1 } };
    const events: PiHarnessSubscribedEvent[] = [
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        args,
        partialResult,
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result,
        isError: false,
      },
    ];

    const { encoded, decoded } = roundTrip(events);
    expect(decoded).toEqual(events.map(expectedPiHarnessFrontendEvent));
    expect(encoded[1]?.event).toMatchObject({
      type: "tool_execution_update",
      args: { kind: "reference", id: 0 },
    });
  });

  it("captures a new snapshot when a tool mutates and reuses its progress object", () => {
    const encoder = new PiHarnessEventEncoder();
    const decoder = new PiHarnessEventDecoder();
    const args = { path: "/tmp/a" };
    const progress = { completed: 1, total: 2 };

    const firstUpdate = encoder.encode({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "read",
      args,
      partialResult: progress,
    });

    progress.completed = 2;
    const secondUpdate = encoder.encode({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "read",
      args,
      partialResult: progress,
    });

    expect(decoder.decode(firstUpdate)).toMatchObject({
      partialResult: { completed: 1, total: 2 },
    });
    expect(decoder.decode(secondUpdate)).toMatchObject({
      partialResult: { completed: 2, total: 2 },
    });
  });

  it("round-trips lifecycle, retry, model, tools, and resources events", () => {
    const previousModel = { ...model, id: "previous-model", name: "Previous model" };
    const resources = {
      skills: [
        {
          name: "review",
          description: "Review code",
          content: "Review carefully.",
          filePath: "/skills/review/SKILL.md",
        },
      ],
      promptTemplates: [{ name: "fix", description: "Fix issue", content: "Fix: $@" }],
    };
    const events: PiHarnessSubscribedEvent[] = [
      { type: "after_provider_response", status: 200, headers: { "request-id": "req-1" } },
      {
        type: "retry_scheduled",
        operation: "compaction",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        errorMessage: "retry",
      },
      { type: "retry_attempt_start", operation: "compaction" },
      { type: "retry_finished", operation: "compaction" },
      { type: "model_update", model, previousModel, source: "set" },
      { type: "thinking_level_update", level: "high", previousLevel: "low" },
      {
        type: "tools_update",
        toolNames: ["read", "write"],
        previousToolNames: ["read"],
        activeToolNames: ["read"],
        previousActiveToolNames: ["read"],
        source: "set",
      },
      { type: "resources_update", resources, previousResources: {} },
      { type: "save_point", hadPendingMutations: true },
      { type: "settled", nextTurnCount: 2 },
    ];

    expect(roundTrip(events).decoded).toEqual(events.map(expectedPiHarnessFrontendEvent));
  });

  it("round-trips compact and tree events", () => {
    const summaryEntry = {
      type: "branch_summary" as const,
      id: "summary-1",
      parentId: "message-1",
      timestamp: "2026-08-12T00:00:00.000Z",
      fromId: "message-2",
      summary: "Summary",
      details: { files: ["a.ts"] },
      usage,
      fromHook: false,
    };
    const compactionEntry = {
      type: "compaction" as const,
      id: "compact-1",
      parentId: "message-2",
      timestamp: "2026-08-12T00:00:01.000Z",
      summary: "Compacted",
      firstKeptEntryId: "message-1",
      tokensBefore: 2000,
      retainedTail: [userMessage("tail")],
      details: { reason: "limit" },
      usage,
      fromHook: true,
    };
    const events: PiHarnessSubscribedEvent[] = [
      { type: "session_compact", compactionEntry, fromHook: true },
      {
        type: "session_tree",
        newLeafId: "summary-1",
        oldLeafId: "message-2",
        summaryEntry,
        fromHook: false,
      },
    ];

    expect(roundTrip(events).decoded).toEqual(events.map(expectedPiHarnessFrontendEvent));
  });

  it("keeps interned decoded values immutable", () => {
    const events: PiHarnessSubscribedEvent[] = [
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "/tmp/a" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "/tmp/a" },
        partialResult: { phase: "opening" },
      },
    ];
    const encoder = new PiHarnessEventEncoder();
    const decoder = new PiHarnessEventDecoder();
    const first = decoder.decode(encoder.encode(events[0]!));
    const firstArgs = (first as Extract<PiHarnessSubscribedEvent, { type: "tool_execution_start" }>)
      .args;
    expect(() => {
      firstArgs.path = "/mutated";
    }).toThrow(TypeError);

    expect(decoder.decode(encoder.encode(events[1]!))).toEqual(events[1]);
  });

  it("rejects references decoded without their stream history", () => {
    const encoder = new PiHarnessEventEncoder();
    const message = userMessage("same");
    encoder.encode({ type: "message_start", message });
    const reference = encoder.encode({ type: "message_end", message });

    expect(() => new PiHarnessEventDecoder().decode(reference)).toThrow(
      "PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_MESSAGE_REFERENCE:0",
    );
  });

  it("exposes only frontend-safe fields through the decoder type", () => {
    const frontendEvent = piHarnessEventProtocol.createDecoder().decode(
      new PiHarnessEventEncoder().encode({
        type: "message_end",
        message: assistantMessage([{ type: "text", text: "hello" }]),
      }),
    );
    expectTypeOf(frontendEvent).toEqualTypeOf<PiHarnessFrontendEvent>();

    if (frontendEvent.type === "message_end" && frontendEvent.message.role === "assistant") {
      expectTypeOf(frontendEvent.message).toEqualTypeOf<PiHarnessFrontendAssistantMessage>();
      expectTypeOf(frontendEvent.message).not.toHaveProperty("api");
      expectTypeOf(frontendEvent.message).not.toHaveProperty("provider");
      expectTypeOf(frontendEvent.message).not.toHaveProperty("model");
    }
  });

  it("rejects unsupported protocol versions", () => {
    const encoded = new PiHarnessEventEncoder().encode({ type: "agent_start" });

    expect(() =>
      new PiHarnessEventDecoder().decode({
        ...encoded,
        version: 1,
      } as unknown as PiHarnessEncodedEvent),
    ).toThrow("PI_HARNESS_EVENT_PROTOCOL_UNSUPPORTED_PROTOCOL");
  });

  it("validates the protocol envelope before reading its event type", () => {
    const encoded = new PiHarnessEventEncoder().encode({ type: "agent_start" });

    assert.equal(piHarnessEventProtocol.eventType(encoded), "agent_start");
    expect(() => piHarnessEventProtocol.eventType({ ...encoded, version: 1 })).toThrow(
      "PI_HARNESS_EVENT_PROTOCOL_UNSUPPORTED_PROTOCOL",
    );
    expect(() => piHarnessEventProtocol.eventType({ protocol: "pi-harness-event" })).toThrow(
      "PI_HARNESS_EVENT_PROTOCOL_UNSUPPORTED_PROTOCOL",
    );
  });
});

const expectScriptRoundTrip = (events: readonly PiHarnessAssistantStreamEvent[]) => {
  const subscribedEvents = events as readonly PiHarnessSubscribedEvent[];
  expect(roundTrip(subscribedEvents).decoded).toEqual(
    subscribedEvents.map(expectedPiHarnessFrontendEvent),
  );
};

const toolCall = (argumentsValue: Record<string, unknown> = { path: "/tmp/a" }): ToolCall => ({
  type: "toolCall",
  id: "call-1",
  name: "read",
  arguments: argumentsValue,
});

const roundTripScripts: ReadonlyArray<{
  name: string;
  events: () => readonly PiHarnessAssistantStreamEvent[];
}> = [
  {
    name: "multi-delta text",
    events: () =>
      createAssistantStreamScript()
        .text("hello", { chunks: ["h", "el", "lo"] })
        .harnessEvents(),
  },
  {
    name: "multi-delta thinking",
    events: () =>
      createAssistantStreamScript()
        .thinking("consider", { chunks: ["con", "sid", "er"] })
        .harnessEvents(),
  },
  {
    name: "mixed thinking, text, and tool-call blocks",
    events: () =>
      createAssistantStreamScript()
        .thinking("plan", { chunks: ["pl", "an"] })
        .text("reading", { chunks: ["read", "ing"] })
        .toolCall("read", {
          id: "call-1",
          arguments: { path: "/tmp/a" },
          chunks: ['{"path":', '"/tmp/a"}'],
        })
        .completes("toolUse")
        .harnessEvents(),
  },
  {
    name: "text delta without text_start",
    events: () =>
      createAssistantStreamScript()
        .startsWith([{ type: "text", text: "before" }])
        .text(" after", { contentIndex: 0, start: false, chunks: [" ", "after"] })
        .harnessEvents(),
  },
  {
    name: "text_start overwrites a thinking block",
    events: () =>
      createAssistantStreamScript()
        .startsWith([{ type: "thinking", thinking: "old" }])
        .text("new", { contentIndex: 0 })
        .harnessEvents(),
  },
  {
    name: "thinking_start overwrites a text block",
    events: () =>
      createAssistantStreamScript()
        .startsWith([{ type: "text", text: "old" }])
        .thinking("new", { contentIndex: 0 })
        .harnessEvents(),
  },
  {
    name: "text_end content differs from partial text",
    events: () =>
      createAssistantStreamScript()
        .text("partial", { chunks: ["partial"], endContent: "provider-corrected" })
        .harnessEvents(),
  },
  {
    name: "thinking_end content differs from partial thinking",
    events: () =>
      createAssistantStreamScript()
        .thinking("partial", { chunks: ["partial"], endContent: "provider-corrected" })
        .harnessEvents(),
  },
  {
    name: "toolcall_end without earlier tool-call events",
    events: () =>
      createAssistantStreamScript()
        .toolCall("read", {
          id: "call-1",
          arguments: { path: "/tmp/a" },
          start: false,
          chunks: [],
        })
        .completes("toolUse")
        .harnessEvents(),
  },
  {
    name: "toolcall_end partial differs from event toolCall",
    events: () =>
      createAssistantStreamScript()
        .toolCall("read", {
          id: "call-1",
          arguments: { path: "/tmp/a" },
          chunks: [],
          snapshots: [[toolCall({})], [toolCall({ path: "/partial-correction" })]],
        })
        .completes("toolUse")
        .harnessEvents(),
  },
  {
    name: "provider partial snapshots lag behind text deltas",
    events: () =>
      createAssistantStreamScript()
        .text("hello", {
          chunks: ["hel", "lo"],
          snapshots: [
            [{ type: "text", text: "" }],
            [{ type: "text", text: "" }],
            [{ type: "text", text: "hel" }],
            [{ type: "text", text: "hello" }],
          ],
        })
        .harnessEvents(),
  },
  {
    name: "assistant metadata changes during a text stream",
    events: () =>
      createAssistantStreamScript()
        .text("hello", {
          chunks: ["hello"],
          snapshots: [
            assistantMessage([{ type: "text", text: "" }], { responseId: "partial-start" }),
            assistantMessage([{ type: "text", text: "hello" }], { responseId: "partial-delta" }),
            assistantMessage([{ type: "text", text: "hello" }], { responseId: "partial-end" }),
          ],
        })
        .harnessEvents(),
  },
  {
    name: "empty text deltas",
    events: () =>
      createAssistantStreamScript()
        .text("", { chunks: ["", ""], endContent: "" })
        .harnessEvents(),
  },
  {
    name: "provider replaces text instead of appending the declared delta",
    events: () =>
      createAssistantStreamScript()
        .text("ignored", {
          chunks: ["first", " delta"],
          snapshots: [
            [{ type: "text", text: "" }],
            [{ type: "text", text: "first" }],
            [{ type: "text", text: "replacement" }],
            [{ type: "text", text: "replacement" }],
          ],
        })
        .harnessEvents(),
  },
  {
    name: "text and thinking signatures appear during streaming",
    events: () =>
      createAssistantStreamScript()
        .text("answer", {
          snapshots: [
            [{ type: "text", text: "", textSignature: "text-start" }],
            [{ type: "text", text: "answer", textSignature: "text-delta" }],
            [{ type: "text", text: "answer", textSignature: "text-end" }],
          ],
        })
        .thinking("plan", {
          snapshots: [
            [
              { type: "text", text: "answer", textSignature: "text-end" },
              { type: "thinking", thinking: "", thinkingSignature: "thinking-start" },
            ],
            [
              { type: "text", text: "answer", textSignature: "text-end" },
              { type: "thinking", thinking: "plan", thinkingSignature: "thinking-delta" },
            ],
            [
              { type: "text", text: "answer", textSignature: "text-end" },
              { type: "thinking", thinking: "plan", thinkingSignature: "thinking-end" },
            ],
          ],
        })
        .harnessEvents(),
  },
  {
    name: "multiple tool calls with independent partial JSON",
    events: () =>
      createAssistantStreamScript()
        .toolCall("read", {
          id: "call-1",
          arguments: { path: "/tmp/a" },
          chunks: ['{"path":"/tmp/a"}'],
        })
        .toolCall("write", {
          id: "call-2",
          arguments: { path: "/tmp/b", contents: "hello" },
          chunks: ['{"path":"/tmp/b",', '"contents":"hello"}'],
        })
        .completes("toolUse")
        .harnessEvents(),
  },
  {
    name: "stream ending before a text_end event",
    events: () =>
      createAssistantStreamScript()
        .text("partial", { chunks: ["partial"], end: false })
        .harnessEvents(),
  },
  {
    name: "terminal error after partial text",
    events: () =>
      createAssistantStreamScript()
        .text("partial", { end: false })
        .fails("provider disconnected")
        .harnessEvents(),
  },
  {
    name: "same index changes block type multiple times",
    events: () =>
      createAssistantStreamScript()
        .text("first", { contentIndex: 0 })
        .thinking("second", { contentIndex: 0 })
        .toolCall("read", { id: "call-1", arguments: {}, contentIndex: 0 })
        .completes("toolUse")
        .harnessEvents(),
  },
];

describe("PiHarnessEventProtocol scripted message streams", () => {
  it.each(roundTripScripts)("round-trips $name", ({ events }) => {
    expectScriptRoundTrip(events());
  });

  it("rejects a sparse positive content index with a named protocol error", () => {
    const events = createAssistantStreamScript().text("third", { contentIndex: 2 }).harnessEvents();
    const encoder = new PiHarnessEventEncoder();

    expect(() => events.map((event) => encoder.encode(event))).toThrow(
      "PI_HARNESS_EVENT_PROTOCOL_SPARSE_CONTENT_INDEX:2",
    );
  });
});

const stepKey = "do:protocol-equivalence";
const fauxMessage = (
  content: Parameters<typeof fauxAssistantMessage>[0],
  options: Parameters<typeof fauxAssistantMessage>[1] = {},
) => fauxAssistantMessage(content, { timestamp: 1, ...options });

describe("PiHarnessEventProtocol stream decoding", () => {
  it("keeps decoder state isolated by execution and epoch", () => {
    const first = fauxMessage([fauxText("first")]);
    const second = fauxMessage([fauxText("second")]);
    const firstEncoder = piHarnessEventProtocol.createEncoder();
    const secondEncoder = piHarnessEventProtocol.createEncoder();
    const decoders = new PiHarnessEventStreamDecoders();
    const firstIdentity = { stepKey, executionId: "first-execution", epoch: "first-epoch" };
    const secondIdentity = { stepKey, executionId: "second-execution", epoch: "second-epoch" };

    decoders.start(firstIdentity);
    decoders.start(secondIdentity);
    const decodedFirst = decoders.decode(
      firstIdentity,
      firstEncoder.encode({ type: "message_start", message: first }),
    );
    const decodedSecond = decoders.decode(
      secondIdentity,
      secondEncoder.encode({ type: "message_start", message: second }),
    );

    expect(decodedFirst).toEqual(
      expectedPiHarnessFrontendEvent({ type: "message_start", message: first }),
    );
    expect(decodedSecond).toEqual(
      expectedPiHarnessFrontendEvent({ type: "message_start", message: second }),
    );
  });

  it("requires streams to start and releases their decoder when they finish", () => {
    const message = fauxMessage([fauxText("hello")]);
    const identity = { stepKey, executionId: "execution", epoch: "epoch" };
    const encoded = piHarnessEventProtocol
      .createEncoder()
      .encode({ type: "message_start", message });
    const decoders = new PiHarnessEventStreamDecoders();

    expect(() => decoders.decode(identity, encoded)).toThrow(/was not started/);

    decoders.start(identity);
    expect(decoders.decode(identity, encoded)).toEqual(
      expectedPiHarnessFrontendEvent({ type: "message_start", message }),
    );

    decoders.finish(identity);
    expect(() => decoders.decode(identity, encoded)).toThrow(/was not started/);
  });
});

const createHarness = () => {
  const faux = fauxProvider({ api: "faux", tokensPerSecond: 0 });
  faux.setResponses([fauxAssistantMessage(fauxText("hello"), { timestamp: 1 })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const state = createPiHarnessSessionState({
    metadata: { id: "event-protocol", createdAt: "2026-08-12T00:00:00.000Z" },
  });
  const restored = restoreWorkflowBackedSession({
    operationId: "event-protocol:prompt",
    state,
    previousEmissions: [],
    models,
  });
  return {
    restored,
    harness: new AgentHarness({ models, model, ...restored.options }),
  };
};

describe("withWorkflowAgentHarness event encoding", () => {
  it("always emits compact versioned events", async () => {
    const { restored, harness } = createHarness();
    const emissions: unknown[] = [];

    await withWorkflowAgentHarness({
      session: restored.session,
      storage: restored.storage,
      harness,
      tx: { emit: (payload) => emissions.push(payload), onEvent: () => () => undefined },
      runDurableStep: () => harness.prompt("hi"),
    });

    expect(emissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "harness-event",
          event: expect.objectContaining({
            protocol: "pi-harness-event",
            version: 2,
            event: expect.objectContaining({ type: "message_update" }),
          }),
        }),
      ]),
    );
  });

  it("preserves progress when a real tool mutates and reuses its update object", async () => {
    const faux = fauxProvider({ api: "faux", tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("reportProgress", {}, { id: "progress-call" }), {
        stopReason: "toolUse",
        timestamp: 1,
      }),
      fauxAssistantMessage(fauxText("done"), { timestamp: 2 }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const state = createPiHarnessSessionState({
      metadata: { id: "mutated-tool-progress", createdAt: "2026-08-12T00:00:00.000Z" },
    });
    const restored = restoreWorkflowBackedSession({
      operationId: "mutated-tool-progress:prompt",
      state,
      previousEmissions: [],
      models,
    });
    const progress = {
      content: [{ type: "text" as const, text: "working" }],
      details: { completed: 1, total: 2 },
    };
    const progressTool: AgentTool = {
      name: "reportProgress",
      label: "Report progress",
      description: "Reports progress by mutating and reusing one update object.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _args, _signal, onUpdate) => {
        onUpdate?.(progress);
        await Promise.resolve();
        progress.details.completed = 2;
        onUpdate?.(progress);
        return progress;
      },
    };
    const harness = new AgentHarness({
      models,
      model: faux.getModel(),
      tools: [progressTool],
      ...restored.options,
    });
    const emissions: unknown[] = [];

    await withWorkflowAgentHarness({
      session: restored.session,
      storage: restored.storage,
      harness,
      tx: { emit: (payload) => emissions.push(payload), onEvent: () => () => undefined },
      runDurableStep: () => harness.prompt("report progress"),
    });

    const decoder = new PiHarnessEventDecoder();
    const progressUpdates = emissions
      .filter(
        (emission): emission is { kind: "harness-event"; event: unknown } =>
          typeof emission === "object" &&
          emission !== null &&
          "kind" in emission &&
          emission.kind === "harness-event",
      )
      .map((emission) => decoder.decode(emission.event))
      .filter((event) => event.type === "tool_execution_update");

    expect(progressUpdates.map((event) => event.partialResult.details.completed)).toEqual([1, 2]);
  });

  it("emits one encoded event for every subscribed Pi event", async () => {
    const { restored, harness } = createHarness();
    const subscribedEvents: unknown[] = [];
    const unsubscribe = harness.subscribe((event) => {
      subscribedEvents.push(structuredClone(event));
    });
    const emissions: unknown[] = [];

    try {
      await withWorkflowAgentHarness({
        session: restored.session,
        storage: restored.storage,
        harness,
        tx: { emit: (payload) => emissions.push(payload), onEvent: () => () => undefined },
        runDurableStep: () => harness.prompt("hi"),
      });
    } finally {
      unsubscribe();
    }

    const encodedEmissions = emissions.filter(
      (emission): emission is { kind: "harness-event"; event: unknown } =>
        typeof emission === "object" &&
        emission !== null &&
        "kind" in emission &&
        emission.kind === "harness-event",
    );
    const decoder = new PiHarnessEventDecoder();
    const decodedEvents = encodedEmissions.map((emission) => decoder.decode(emission.event));

    assert(encodedEmissions.length > 0);
    expect(encodedEmissions).toHaveLength(subscribedEvents.length);
    expect(decodedEvents).toEqual(
      structuredClone(
        subscribedEvents.map((event) => expectedPiHarnessFrontendEvent(event as AgentHarnessEvent)),
      ),
    );
    expect(encodedEmissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ protocol: "pi-harness-event", version: 2 }),
        }),
      ]),
    );
  });
});
