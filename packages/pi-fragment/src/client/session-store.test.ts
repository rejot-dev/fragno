import { afterEach, describe, expect, it, vi } from "vitest";

import { atom } from "nanostores";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { PiActiveSessionProtocolMessage, PiSessionDetail } from "../pi/types";
import { createPiSessionStore } from "./session-store";

const buildUserMessage = (text: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const buildAssistantMessage = (text: string, timestamp = 2): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
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
  timestamp,
});

const buildSession = (overrides: Partial<PiSessionDetail> = {}): PiSessionDetail => ({
  id: overrides.id ?? "session-1",
  name: overrides.name ?? "Test session",
  status: overrides.status ?? "active",
  agent: overrides.agent ?? "default",
  steeringMode: overrides.steeringMode ?? "one-at-a-time",
  metadata: overrides.metadata ?? null,
  tags: overrides.tags ?? [],
  createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  workflow: overrides.workflow ?? { status: "active" },
  messages: overrides.messages ?? [],
  events: overrides.events ?? [],
  trace: overrides.trace ?? [],
  turns: overrides.turns ?? [],
  commandHistory: overrides.commandHistory ?? [],
  turn: overrides.turn ?? 0,
  phase: overrides.phase ?? "waiting-for-command",
  waitingFor: overrides.waitingFor ?? {
    type: "command",
    turn: 0,
    stepKey: "waitForEvent:wait-command-turn-0-command-0",
    allowedCommands: ["prompt", "followUp", "complete"],
    timeoutMs: 1_000,
  },
});

const createDetailStore = (initialData: PiSessionDetail) => {
  const store = atom({
    loading: false,
    data: initialData,
  });

  return Object.assign(store, {
    revalidate: vi.fn(),
  });
};

const createNdjsonResponse = (
  messages: PiActiveSessionProtocolMessage[],
  delays: number[] = [],
) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, message] of messages.entries()) {
        const delay = delays[index] ?? 0;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson" },
  });
};

const waitForStore = async <T>(store: { get: () => T }, predicate: (value: T) => boolean) =>
  vi.waitFor(() => {
    const value = store.get();
    expect(predicate(value)).toBe(true);
    return value;
  });

describe("createPiSessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-enables input when the live snapshot reports waiting for command after a refresh", async () => {
    const initialSession = buildSession({
      phase: "running-agent",
      waitingFor: { type: "assistant", turn: 0, stepKey: "assistant-0" },
      messages: [buildUserMessage("hello", 1)],
    });
    const detailStore = createDetailStore(initialSession);

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      createNdjsonResponse([
        {
          layer: "system",
          type: "snapshot",
          turn: 1,
          phase: "waiting-for-command",
          waitingFor: {
            type: "command",
            turn: 1,
            stepKey: "waitForEvent:wait-command-turn-1-command-1",
            allowedCommands: ["prompt", "followUp", "complete"],
            timeoutMs: 1_000,
          },
          replayCount: 0,
        },
      ]),
    );

    const controller = createPiSessionStore(
      {
        createDetailStore: () => detailStore,
        sendCommand: vi.fn(),
        buildActiveUrl: () => "http://localhost/api/pi/sessions/session-1/active",
        fetcher,
      },
      {
        sessionId: initialSession.id,
        initialData: initialSession,
      },
    );

    const state = await waitForStore(controller.store, (value) => value.readyForInput);

    expect(state.readyForInput).toBe(true);
    expect(state.statusText).toBeNull();

    controller.destroy();
  });

  it("does not duplicate a prompt once the accepted command is visible in a snapshot", async () => {
    const initialSession = buildSession();
    const detailStore = createDetailStore(initialSession);
    const sendCommand = vi.fn().mockResolvedValue({ commandId: "command-1", status: "active" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));

    const controller = createPiSessionStore(
      {
        createDetailStore: () => detailStore,
        sendCommand,
        buildActiveUrl: () => "http://localhost/api/pi/sessions/session-1/active",
        fetcher,
      },
      {
        sessionId: initialSession.id,
        initialData: initialSession,
      },
    );

    expect(controller.prompt({ text: "hello" })).toBe(true);
    expect(controller.store.get().messages).toHaveLength(1);

    await waitForStore(controller.store, (value) => !value.sending && value.messages.length === 0);

    detailStore.set({
      loading: false,
      data: buildSession({
        messages: [buildUserMessage("hello", 1_001)],
        phase: "running-agent",
        waitingFor: { type: "assistant", turn: 0, stepKey: "prompt-turn-0-op-0" },
        updatedAt: initialSession.updatedAt,
      }),
    });

    const state = controller.store.get();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", timestamp: 1_001 });

    controller.destroy();
  });

  it("deduplicates assistant messages between live replay and refreshed snapshot", async () => {
    const initialSession = buildSession({
      messages: [buildUserMessage("hello", 1)],
    });
    const detailStore = createDetailStore(initialSession);
    const committedAssistant = buildAssistantMessage("assistant:hello", 10);

    detailStore.revalidate.mockImplementation(() => {
      detailStore.set({
        loading: false,
        data: buildSession({
          messages: [buildUserMessage("hello", 1), committedAssistant],
          updatedAt: new Date("2026-01-01T00:00:01.000Z"),
          turn: 1,
          waitingFor: {
            type: "command",
            turn: 1,
            stepKey: "waitForEvent:wait-command-turn-1-command-1",
            allowedCommands: ["prompt", "followUp", "complete"],
            timeoutMs: 1_000,
          },
        }),
      });
    });

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createNdjsonResponse([
          {
            layer: "system",
            type: "snapshot",
            turn: 0,
            phase: "waiting-for-command",
            waitingFor: {
              type: "command",
              turn: 0,
              stepKey: "waitForEvent:wait-command-turn-0-command-0",
              allowedCommands: ["prompt", "followUp", "complete"],
              timeoutMs: 1_000,
            },
            replayCount: 0,
          },
          {
            layer: "pi",
            type: "event",
            source: "live",
            turn: 0,
            event: { type: "message_start", message: committedAssistant },
          },
          {
            layer: "pi",
            type: "event",
            source: "live",
            turn: 0,
            event: { type: "message_end", message: committedAssistant },
          },
          {
            layer: "system",
            type: "settled",
            turn: 0,
            status: "waiting-for-command",
          },
        ]),
      )
      .mockImplementation(() => new Promise<Response>(() => undefined));

    const controller = createPiSessionStore(
      {
        createDetailStore: () => detailStore,
        sendCommand: vi.fn(),
        buildActiveUrl: () => "http://localhost/api/pi/sessions/session-1/active",
        fetcher,
      },
      {
        sessionId: initialSession.id,
        initialData: initialSession,
      },
    );

    const state = await waitForStore(
      controller.store,
      (value) =>
        value.session?.turn === 1 &&
        value.messages.filter((message) => message.role === "assistant").length === 1,
    );

    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ role: "assistant", timestamp: 10 });
    expect(detailStore.revalidate).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  it("surfaces replayed in-memory tool activity before it is persisted", async () => {
    const initialSession = buildSession({
      phase: "running-agent",
      waitingFor: { type: "assistant", turn: 0, stepKey: "assistant-0" },
      messages: [buildUserMessage("run tool", 1)],
    });
    const detailStore = createDetailStore(initialSession);

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      createNdjsonResponse(
        [
          {
            layer: "system",
            type: "snapshot",
            turn: 0,
            phase: "running-agent",
            waitingFor: { type: "assistant", turn: 0, stepKey: "assistant-0" },
            replayCount: 1,
          },
          {
            layer: "pi",
            type: "event",
            source: "replay",
            turn: 0,
            event: {
              type: "tool_execution_start",
              toolCallId: "tool-1",
              toolName: "search",
              args: { query: "run tool" },
            },
          },
        ],
        [0, 10],
      ),
    );

    const controller = createPiSessionStore(
      {
        createDetailStore: () => detailStore,
        sendCommand: vi.fn(),
        buildActiveUrl: () => "http://localhost/api/pi/sessions/session-1/active",
        fetcher,
      },
      {
        sessionId: initialSession.id,
        initialData: initialSession,
      },
    );

    const state = await waitForStore(controller.store, (value) =>
      value.runningTools.some((tool) => tool.toolCallId === "tool-1"),
    );

    expect(state.runningTools).toEqual([
      {
        toolCallId: "tool-1",
        toolName: "search",
        args: { query: "run tool" },
        partialResult: null,
      },
    ]);

    controller.destroy();
  });

  it("handles inactive active-session streams without surfacing an error", async () => {
    const initialSession = buildSession();
    const detailStore = createDetailStore(initialSession);

    detailStore.revalidate.mockImplementation(() => {
      detailStore.set({
        loading: false,
        data: buildSession({
          updatedAt: new Date("2026-01-01T00:00:01.000Z"),
          phase: "complete",
          status: "complete",
          workflow: { status: "complete" },
          waitingFor: null,
        }),
      });
    });

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      createNdjsonResponse([
        {
          layer: "system",
          type: "snapshot",
          turn: 0,
          phase: "complete",
          waitingFor: null,
          replayCount: 0,
        },
        {
          layer: "system",
          type: "inactive",
          reason: "session-complete",
          turn: 0,
          phase: "complete",
          waitingFor: null,
        },
      ]),
    );

    const controller = createPiSessionStore(
      {
        createDetailStore: () => detailStore,
        sendCommand: vi.fn(),
        buildActiveUrl: () => "http://localhost/api/pi/sessions/session-1/active",
        fetcher,
      },
      {
        sessionId: initialSession.id,
        initialData: initialSession,
      },
    );

    const state = await waitForStore(
      controller.store,
      (value) => value.session?.phase === "complete" && value.connection === "idle",
    );

    expect(state.error).toBeNull();
    expect(state.connection).toBe("idle");
    expect(detailStore.revalidate).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  it("rolls back optimistic messages when prompt fails", async () => {
    const initialSession = buildSession();
    const detailStore = createDetailStore(initialSession);

    const sendCommand = vi.fn().mockRejectedValue(new Error("send failed"));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));

    const controller = createPiSessionStore(
      {
        createDetailStore: () => detailStore,
        sendCommand,
        buildActiveUrl: () => "http://localhost/api/pi/sessions/session-1/active",
        fetcher,
      },
      {
        sessionId: initialSession.id,
        initialData: initialSession,
      },
    );

    expect(controller.prompt({ text: "hello" })).toBe(true);
    expect(controller.store.get().messages.at(-1)).toMatchObject({ role: "user" });

    const state = await waitForStore(
      controller.store,
      (value) => value.sendError === "send failed" && value.messages.length === 0,
    );

    expect(state.sending).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith({
      sessionId: initialSession.id,
      command: { kind: "prompt", input: { text: "hello" } },
    });

    controller.destroy();
  });
});
