import { describe, expect, it, vi } from "vitest";

import { FragnoClientApiError } from "@fragno-dev/core/client";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiSessionEventStreamItem } from "../pi/types";
import {
  createInitialPiSessionStoreState,
  createPiSessionStore,
  createStorePiSessionTransport,
  reducePiSessionStreamFrame,
  type PiSessionTransport,
} from "./session";

const snapshot = {
  messages: [],
};

const message = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
  }) as AgentMessage;

const stream = (frames: AgentEvent[] | unknown[]) =>
  (async function* () {
    for (const frame of frames) {
      yield frame as never;
    }
  })();

const createStore = (
  transport: PiSessionTransport,
  options: Partial<Parameters<typeof createPiSessionStore>[1]> = {},
) =>
  createPiSessionStore(
    { path: { sessionId: "session_1" } },
    {
      transport,
      retryDelay: () => 0,
      now: () => 100,
      ...options,
    },
  );

const waitForStatus = async (store: ReturnType<typeof createPiSessionStore>, status: string) => {
  await vi.waitFor(() => expect(store.get().connectionStatus).toBe(status));
};

describe("Pi session stream reducer", () => {
  it("reduces snapshots, live message updates, and tool calls", () => {
    let state = createInitialPiSessionStoreState({ sessionId: "session_1" });

    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    expect(state).toMatchObject({ connectionStatus: "open", agent: snapshot, lastFrameAt: 1 });

    const firstToolEvent = { type: "tool_execution_start", toolCallId: "tool_1" } as AgentEvent;
    state = reducePiSessionStreamFrame(state, firstToolEvent, { now: 3 });
    expect(state.events).toEqual([firstToolEvent]);

    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("partial") } as AgentEvent,
      { now: 4 },
    );
    expect(state.agent?.messages).toEqual([message("partial")]);

    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("more partial") } as AgentEvent,
      { now: 5 },
    );
    expect(state.agent?.messages).toEqual([message("more partial")]);

    state = reducePiSessionStreamFrame(
      state,
      { type: "message_end", message: message("done") } as AgentEvent,
      { now: 6 },
    );
    expect(state.agent?.messages).toEqual([message("done")]);

    const secondToolEvent = { type: "tool_execution_update", toolCallId: "tool_2" } as AgentEvent;
    state = reducePiSessionStreamFrame(state, secondToolEvent, { now: 7 });
    expect(state.events).toContain(secondToolEvent);

    const toolEndEvent = { type: "tool_execution_end", toolCallId: "tool_1" } as AgentEvent;
    state = reducePiSessionStreamFrame(state, toolEndEvent, { now: 8 });
    expect(state.events).toContain(toolEndEvent);
  });
});

describe("createStorePiSessionTransport", () => {
  type TestEventsStoreState = {
    loading: boolean;
    data?: PiSessionEventStreamItem[];
    error?: unknown;
  };

  const createEventsStore = (initialState: TestEventsStoreState = { loading: true }) => {
    let state: TestEventsStoreState = initialState;
    const listeners = new Set<(state: TestEventsStoreState) => void>();

    return {
      store: {
        get: () => state,
        listen: (listener: (state: TestEventsStoreState) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      set: (nextState: TestEventsStoreState) => {
        state = nextState;
        for (const listener of listeners) {
          listener(state);
        }
      },
      listenerCount: () => listeners.size,
    };
  };

  it("converts /events store updates into stream frames", async () => {
    const eventsStore = createEventsStore();
    const transport = createStorePiSessionTransport({
      openEventsStore: () => eventsStore.store,
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    });

    const frames = await transport.openEvents({
      sessionId: "session_1",
      signal: new AbortController().signal,
    });
    const iterator = frames[Symbol.asyncIterator]();

    eventsStore.set({ loading: false, data: [{ type: "snapshot", state: snapshot }] });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "snapshot", state: snapshot },
    });

    const update = { type: "agent_start" } as PiSessionEventStreamItem;
    eventsStore.set({
      loading: false,
      data: [{ type: "snapshot", state: snapshot }, update],
    });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: update });
  });

  it("surfaces store errors and unsubscribes", async () => {
    const storeError = new Error("stream failed");
    const eventsStore = createEventsStore();
    const transport = createStorePiSessionTransport({
      openEventsStore: () => eventsStore.store,
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    });

    const frames = await transport.openEvents({
      sessionId: "session_1",
      signal: new AbortController().signal,
    });
    const iterator = frames[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(eventsStore.listenerCount()).toBe(1));

    eventsStore.set({ loading: false, error: storeError });
    await expect(next).rejects.toBe(storeError);
    expect(eventsStore.listenerCount()).toBe(0);
  });

  it("unsubscribes when aborted", async () => {
    const eventsStore = createEventsStore();
    const controller = new AbortController();
    const transport = createStorePiSessionTransport({
      openEventsStore: () => eventsStore.store,
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    });

    const frames = await transport.openEvents({
      sessionId: "session_1",
      signal: controller.signal,
    });
    const iterator = frames[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(eventsStore.listenerCount()).toBe(1));

    controller.abort();
    await expect(next).rejects.toThrow("Request was aborted");
    expect(eventsStore.listenerCount()).toBe(0);
  });
});

describe("createPiSessionStore", () => {
  it("reconnects after a clean EOF and exposes status transitions", async () => {
    let opens = 0;
    const statuses: string[] = [];
    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) => {
        opens += 1;
        if (opens === 1) {
          return stream([{ type: "snapshot", state: snapshot }]);
        }
        return (async function* () {
          yield { type: "snapshot", state: snapshot };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })();
      },
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport, { retryDelay: () => 5 });
    const unsubscribe = store.subscribe((state) => statuses.push(state.connectionStatus));

    await vi.waitFor(() => {
      expect(store.get().connectionStatus).toBe("open");
      expect(opens).toBe(2);
    });

    expect(statuses).toContain("connecting");
    expect(statuses).toContain("open");
    expect(statuses).toContain("retrying");

    unsubscribe();
  });

  it("retries network and server errors before succeeding", async () => {
    let opens = 0;
    const networkError = new Error("offline");
    const serverError = new FragnoClientApiError(
      { message: "temporary", code: "WORKFLOW_INSTANCE_MISSING" },
      500,
    );
    const transport: PiSessionTransport = {
      openEvents: async () => {
        opens += 1;
        if (opens === 1) {
          throw networkError;
        }
        if (opens === 2) {
          throw serverError;
        }
        return (async function* () {
          yield { type: "snapshot", state: snapshot };
          await new Promise<void>(() => {});
        })();
      },
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await waitForStatus(store, "open");
    expect(opens).toBe(3);

    unsubscribe();
  });

  it("does not retry fatal session-not-found errors", async () => {
    let opens = 0;
    const notFound = new FragnoClientApiError(
      { message: "missing", code: "SESSION_NOT_FOUND" },
      404,
    );
    const transport: PiSessionTransport = {
      openEvents: async () => {
        opens += 1;
        throw notFound;
      },
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store.get()).toMatchObject({ connectionStatus: "error", streamError: notFound });
      expect(opens).toBe(1);
    });

    unsubscribe();
  });

  it("aborts the active stream when the store is unmounted", async () => {
    let aborted = false;
    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          const abortPromise = new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          yield { type: "snapshot", state: snapshot };
          await abortPromise;
        })(),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => expect(store.get().connectionStatus).toBe("open"));
    unsubscribe();

    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it("stores successful command acknowledgements", async () => {
    const ack = { accepted: true as const, commandId: "cmd_1", status: "active" as const };
    const transport: PiSessionTransport = {
      openEvents: async () => stream([{ type: "snapshot", state: snapshot }]),
      sendCommand: async () => ack,
    };

    const store = createStore(transport);

    await expect(store.sendCommand({ kind: "continue" })).resolves.toBe(ack);
    expect(store.get()).toMatchObject({
      command: { loading: false, error: undefined, lastAck: ack },
    });
  });

  it("keeps command errors separate from stream state", async () => {
    const commandError = new Error("COMMAND_FAILED");
    const transport: PiSessionTransport = {
      openEvents: async () => stream([{ type: "snapshot", state: snapshot }]),
      sendCommand: async () => {
        throw commandError;
      },
    };

    const store = createStore(transport);

    await expect(store.sendCommand({ kind: "prompt", input: { text: "hello" } })).rejects.toThrow(
      "COMMAND_FAILED",
    );

    expect(store.get()).toMatchObject({
      command: { loading: false, error: commandError, lastAck: null },
    });
    expect(store.get().streamError).toBeUndefined();
  });

  it("exposes live tool execution updates", async () => {
    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          yield { type: "snapshot", state: snapshot };
          yield {
            type: "tool_execution_start",
            toolCallId: "tool_1",
            toolName: "search",
            args: { q: "fragno" },
          } as AgentEvent;
          yield {
            type: "tool_execution_update",
            toolCallId: "tool_1",
            toolName: "search",
            args: { q: "fragno" },
            partialResult: { count: 1 },
          } as AgentEvent;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
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
  });

  it("allows commands while the event stream is open", async () => {
    const ack = { accepted: true as const, commandId: "cmd_1", status: "active" as const };
    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          yield { type: "snapshot", state: snapshot };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
      sendCommand: async () => ack,
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});
    await waitForStatus(store, "open");

    await expect(store.sendCommand({ kind: "continue" })).resolves.toBe(ack);
    expect(store.get()).toMatchObject({
      connectionStatus: "open",
      command: { loading: false, error: undefined, lastAck: ack },
    });

    unsubscribe();
  });

  it("restarts the stream when reconnect is called manually", async () => {
    let opens = 0;
    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          opens += 1;
          yield { type: "snapshot", state: snapshot };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});
    await vi.waitFor(() => expect(opens).toBe(1));

    store.reconnect();

    await vi.waitFor(() => expect(opens).toBe(2));
    expect(store.get().connectionStatus).toBe("open");

    unsubscribe();
  });

  it("treats a non-snapshot first frame as a retryable protocol error", async () => {
    let opens = 0;
    const transport: PiSessionTransport = {
      openEvents: async () => {
        opens += 1;
        return opens === 1
          ? stream([{ type: "agent_start" }])
          : (async function* () {
              yield { type: "snapshot", state: snapshot };
              await new Promise<void>(() => {});
            })();
      },
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store.get().connectionStatus).toBe("open");
      expect(opens).toBe(2);
    });

    unsubscribe();
  });
});
