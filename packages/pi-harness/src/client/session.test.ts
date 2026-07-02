import { assert, describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

import type { PiSessionEventStreamItem } from "../pi/types";
import {
  createInitialPiSessionStoreState,
  createPiSessionStore,
  isPiSessionPossiblyStuck,
  reducePiSessionStreamFrame,
  type PiSessionTransport,
} from "./session";

const snapshot = { messages: [] };

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 1,
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
});

const toolCallMessage = (toolCall: ToolCall & { partialJson?: string }): AssistantMessage => ({
  ...assistantMessage(""),
  content: [toolCall],
  stopReason: "toolUse",
});

const message = (text: string): AgentMessage => assistantMessage(text);

const harnessEmission = (
  event: AgentEvent,
  options: { stepKey?: string; epoch?: string } = {},
): PiSessionEventStreamItem => ({
  kind: "step-emission",
  actor: "user",
  stepKey: options.stepKey ?? "do:command-0-prompt",
  epoch: options.epoch ?? "epoch-1",
  payload: { kind: "harness-event", event },
});

const stepCommitted = (
  options: { stepKey?: string; epoch?: string } = {},
): PiSessionEventStreamItem => ({
  kind: "step-emission",
  actor: "system",
  stepKey: options.stepKey ?? "do:command-0-prompt",
  epoch: options.epoch ?? "epoch-1",
  payload: { control: "step-committed", epoch: options.epoch ?? "epoch-1" },
});

const createState = () =>
  createInitialPiSessionStoreState({ workflowName: "workflow_1", sessionId: "session_1" });

const reduceFrames = (frames: PiSessionEventStreamItem[]) =>
  frames.reduce(
    (state, frame, index) => reducePiSessionStreamFrame(state, frame, { now: index + 1 }),
    createState(),
  );

const createStore = (transport: PiSessionTransport) =>
  createPiSessionStore(
    { path: { workflowName: "workflow_1", sessionId: "session_1" } },
    { transport, retryDelay: () => 0, now: () => 100 },
  );

const openFrames =
  (frames: PiSessionEventStreamItem[]): PiSessionTransport["openEvents"] =>
  async ({ signal }) =>
    (async function* () {
      for (const frame of frames) {
        yield frame;
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    })();

describe("Pi session stream reducer", () => {
  it("reduces snapshots and workflow harness events", () => {
    const firstToolEvent = {
      type: "tool_execution_start",
      toolCallId: "tool_1",
      toolName: "bash",
      args: { command: "ls" },
    } as AgentEvent;
    const toolEndEvent = {
      type: "tool_execution_end",
      toolCallId: "tool_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }], details: {} },
      isError: false,
    } as AgentEvent;

    const state = reduceFrames([
      { type: "snapshot", state: snapshot },
      harnessEmission(firstToolEvent),
      harnessEmission({ type: "message_update", message: message("partial") } as AgentEvent),
      harnessEmission({ type: "message_update", message: message("more partial") } as AgentEvent),
      harnessEmission({ type: "message_end", message: message("done") } as AgentEvent),
      harnessEmission(toolEndEvent),
    ]);

    expect(state).toMatchObject({ connectionStatus: "open", lastFrameAt: 6 });
    expect(state.agent?.messages).toEqual([message("done")]);
    expect(state.events).toContainEqual(harnessEmission(firstToolEvent));
    expect(state.events).toContainEqual(harnessEmission(toolEndEvent));
  });

  it("replaces abandoned partial assistant messages during harness recovery", () => {
    const state = reduceFrames([
      { type: "snapshot", state: snapshot },
      harnessEmission({ type: "message_start", message: message("abandoned start") } as AgentEvent),
      harnessEmission({
        type: "message_update",
        message: message("abandoned partial"),
      } as AgentEvent),
      harnessEmission({ type: "agent_start" } as AgentEvent),
      harnessEmission({ type: "turn_start" } as AgentEvent),
      harnessEmission({ type: "message_start", message: message("recovered start") } as AgentEvent),
      harnessEmission({
        type: "message_update",
        message: message("recovered partial"),
      } as AgentEvent),
    ]);

    expect(state.agent?.messages).toEqual([message("recovered partial")]);
  });

  it("rolls back stale harness events when a competing epoch commits", () => {
    const state = reduceFrames([
      { type: "snapshot", state: snapshot },
      harnessEmission({ type: "message_update", message: message("first stale") } as AgentEvent, {
        stepKey: "do:racy client message",
        epoch: "first-epoch",
      }),
      harnessEmission({ type: "message_update", message: message("second valid") } as AgentEvent, {
        stepKey: "do:racy client message",
        epoch: "second-epoch",
      }),
      stepCommitted({ stepKey: "do:racy client message", epoch: "second-epoch" }),
    ]);

    expect(state.agent?.messages).toEqual([message("second valid")]);
    assert(!isPiSessionPossiblyStuck(state, { now: 10_000 }));
  });

  it("marks stale uncommitted harness emissions as possibly stuck", () => {
    const state = reduceFrames([
      { type: "snapshot", state: snapshot },
      harnessEmission({ type: "message_end", message: message("done") } as AgentEvent),
    ]);

    assert(isPiSessionPossiblyStuck(state, { now: 10_000 }));

    const committed = reducePiSessionStreamFrame(state, stepCommitted(), { now: 1_001 });
    assert(!isPiSessionPossiblyStuck(committed, { now: 10_000 }));
  });
});

describe("Pi session live harness projections", () => {
  it("exposes draft tool call input while the assistant writes arguments", async () => {
    const partialToolCall = {
      type: "toolCall" as const,
      id: "tool_1",
      name: "bash",
      arguments: {},
    };
    const partialMessage = toolCallMessage(partialToolCall);
    const transport: PiSessionTransport = {
      openEvents: openFrames([
        { type: "snapshot", state: snapshot },
        harnessEmission({ type: "message_start", message: partialMessage } as AgentEvent),
        harnessEmission({
          type: "message_update",
          message: partialMessage,
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: 0,
            partial: partialMessage,
          },
        } as AgentEvent),
        harnessEmission({
          type: "message_update",
          message: toolCallMessage({
            ...partialToolCall,
            arguments: { command: "pnpm test" },
          }),
          assistantMessageEvent: {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"command":"pnpm test',
            partial: toolCallMessage({
              ...partialToolCall,
              arguments: { command: "pnpm test" },
            }),
          },
        } as AgentEvent),
      ]),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store.draftToolCalls.get()).toEqual([
        {
          key: "assistant:1:tool:tool_1",
          contentIndex: 0,
          toolCallId: "tool_1",
          toolName: "bash",
          argumentsText: '{"command":"pnpm test',
          argumentsValue: { command: "pnpm test" },
          status: "streaming",
        },
      ]);
    });

    unsubscribe();
    store.disconnect();
  });

  it("removes draft tool calls when execution starts", async () => {
    const completedToolCall = {
      type: "toolCall" as const,
      id: "tool_1",
      name: "bash",
      arguments: { command: "ls" },
    };
    const assistant = toolCallMessage(completedToolCall);
    const transport: PiSessionTransport = {
      openEvents: openFrames([
        { type: "snapshot", state: snapshot },
        harnessEmission({ type: "message_start", message: assistant } as AgentEvent),
        harnessEmission({
          type: "message_update",
          message: assistant,
          assistantMessageEvent: {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: completedToolCall,
            partial: assistant,
          },
        } as AgentEvent),
        harnessEmission({
          type: "tool_execution_start",
          toolCallId: "tool_1",
          toolName: "bash",
          args: { command: "ls" },
        } as AgentEvent),
      ]),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store.runningTools.get()).toMatchObject([
        { toolCallId: "tool_1", toolName: "bash", args: { command: "ls" } },
      ]);
    });
    expect(store.draftToolCalls.get()).toEqual([]);
    expect(store.messages.get()).toMatchObject([
      {
        role: "assistant",
        content: [completedToolCall],
      },
    ]);

    unsubscribe();
    store.disconnect();
  });

  it("exposes live tool execution updates", async () => {
    const transport: PiSessionTransport = {
      openEvents: openFrames([
        { type: "snapshot", state: snapshot },
        harnessEmission({
          type: "tool_execution_start",
          toolCallId: "tool_1",
          toolName: "search",
          args: { q: "fragno" },
        } as AgentEvent),
        harnessEmission({
          type: "tool_execution_update",
          toolCallId: "tool_1",
          toolName: "search",
          args: { q: "fragno" },
          partialResult: { count: 1 },
        } as AgentEvent),
      ]),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store.runningTools.get()).toEqual([
        {
          toolCallId: "tool_1",
          toolName: "search",
          args: { q: "fragno" },
          partialResult: { count: 1 },
        },
      ]);
    });

    unsubscribe();
    store.disconnect();
  });
});
