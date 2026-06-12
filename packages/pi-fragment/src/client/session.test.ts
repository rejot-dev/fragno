import { describe, expect, it, vi, assert } from "vitest";

import { FragnoClientApiError } from "@fragno-dev/core/client";
import { atom } from "nanostores";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiSessionEventStreamItem } from "../pi/types";
import {
  createInitialPiSessionStoreState,
  createPiSessionStore,
  createStorePiSessionTransport,
  isPiSessionPossiblyStuck,
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

const stepEmission = (payload: AgentEvent, options: { stepKey?: string; epoch?: string } = {}) =>
  ({
    kind: "step-emission",
    actor: "user",
    stepKey: options.stepKey ?? "do:command-0-followUp",
    epoch: options.epoch ?? "epoch-1",
    payload,
  }) as const;

const createStore = (
  transport: PiSessionTransport,
  options: Partial<Parameters<typeof createPiSessionStore>[1]> = {},
) =>
  createPiSessionStore(
    { path: { workflowName: "workflow_1", sessionId: "session_1" } },
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
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });

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

  it("replaces an abandoned partial assistant message when recovery starts a new stream", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 2 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("abandoned partial") } as AgentEvent,
      { now: 3 },
    );

    state = reducePiSessionStreamFrame(state, { type: "agent_start" } as AgentEvent, { now: 4 });
    state = reducePiSessionStreamFrame(state, { type: "turn_start" } as AgentEvent, { now: 5 });
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 6 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("recovered partial") } as AgentEvent,
      { now: 7 },
    );

    expect(state.agent?.messages).toEqual([message("recovered partial")]);
  });

  it("handles recovery that emits message_update without a new message_start", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 2 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("abandoned partial") } as AgentEvent,
      { now: 3 },
    );

    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("recovered partial") } as AgentEvent,
      { now: 4 },
    );

    expect(state.agent?.messages).toEqual([message("recovered partial")]);
  });

  it("handles recovery events before message_update without duplicating the abandoned draft", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 2 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("abandoned partial") } as AgentEvent,
      { now: 3 },
    );

    state = reducePiSessionStreamFrame(state, { type: "agent_start" } as AgentEvent, { now: 4 });
    state = reducePiSessionStreamFrame(state, { type: "turn_start" } as AgentEvent, { now: 5 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("recovered partial") } as AgentEvent,
      { now: 6 },
    );

    expect(state.agent?.messages).toEqual([message("recovered partial")]);
  });

  it("keeps a completed message when the next recovered message starts", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_end", message: message("complete") } as AgentEvent,
      { now: 2 },
    );
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 3 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("next partial") } as AgentEvent,
      { now: 4 },
    );

    expect(state.agent?.messages).toEqual([message("complete"), message("next partial")]);
  });

  it("drops only the abandoned partial when multiple completed messages exist", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_end", message: message("complete") } as AgentEvent,
      { now: 2 },
    );
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 3 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("abandoned") } as AgentEvent,
      { now: 4 },
    );
    state = reducePiSessionStreamFrame(state, { type: "agent_start" } as AgentEvent, { now: 5 });
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, { now: 6 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("recovered") } as AgentEvent,
      { now: 7 },
    );

    expect(state.agent?.messages).toEqual([message("complete"), message("recovered")]);
  });

  it("replaces an abandoned step-emission partial when recovery starts in the same epoch", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_start" } as AgentEvent),
      { now: 2 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_update", message: message("abandoned") } as AgentEvent),
      { now: 3 },
    );
    state = reducePiSessionStreamFrame(state, stepEmission({ type: "agent_start" } as AgentEvent), {
      now: 4,
    });
    state = reducePiSessionStreamFrame(state, stepEmission({ type: "turn_start" } as AgentEvent), {
      now: 5,
    });
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_start" } as AgentEvent),
      { now: 6 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_update", message: message("recovered") } as AgentEvent),
      { now: 7 },
    );

    expect(state.agent?.messages).toEqual([message("recovered")]);
  });

  it("replaces an abandoned step-emission partial when recovery starts in a new uncommitted epoch", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_start" } as AgentEvent, { epoch: "epoch-1" }),
      { now: 2 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_update", message: message("abandoned") } as AgentEvent, {
        epoch: "epoch-1",
      }),
      { now: 3 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_start" } as AgentEvent, { epoch: "epoch-2" }),
      { now: 4 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_update", message: message("recovered") } as AgentEvent, {
        epoch: "epoch-2",
      }),
      { now: 5 },
    );

    expect(state.agent?.messages).toEqual([message("recovered")]);
  });

  it("does not duplicate recovered step-emission updates after an old epoch commits stale", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      stepEmission(
        { type: "message_update", message: message("old epoch partial") } as AgentEvent,
        { epoch: "epoch-1" },
      ),
      { now: 2 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission(
        { type: "message_update", message: message("new epoch partial") } as AgentEvent,
        { epoch: "epoch-2" },
      ),
      { now: 3 },
    );
    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "system",
        stepKey: "do:command-0-followUp",
        epoch: "epoch-2",
        payload: { control: "step-committed", epoch: "epoch-2" },
      },
      { now: 4 },
    );

    expect(state.agent?.messages).toEqual([message("new epoch partial")]);
    assert(!isPiSessionPossiblyStuck(state, { now: 10_000 }));
  });

  it("does not mark a committed stale step emission as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_end", message: message("done") } as AgentEvent),
      { now: 1_000 },
    );
    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "system",
        stepKey: "do:command-0-followUp",
        epoch: "epoch-1",
        payload: { control: "step-committed", epoch: "epoch-1" },
      },
      { now: 1_001 },
    );

    assert(!isPiSessionPossiblyStuck(state, { now: 10_000 }));
  });

  it("does not mark old uncommitted step emissions as stuck after a later step commits", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_update", message: message("abandoned") } as AgentEvent, {
        stepKey: "do:command-0-followUp",
        epoch: "epoch-1",
      }),
      { now: 1_000 },
    );
    state = reducePiSessionStreamFrame(
      state,
      stepEmission({ type: "message_end", message: message("done") } as AgentEvent, {
        stepKey: "do:command-1-followUp",
        epoch: "epoch-2",
      }),
      { now: 2_000 },
    );
    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "system",
        stepKey: "do:command-1-followUp",
        epoch: "epoch-2",
        payload: { control: "step-committed", epoch: "epoch-2" },
      },
      { now: 2_001 },
    );

    assert(!isPiSessionPossiblyStuck(state, { now: 10_000 }));
  });

  it("does not mark a disconnected stale session as needing a nudge", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("partial") } as AgentEvent,
      { now: 1_000 },
    );

    assert(!isPiSessionPossiblyStuck({ ...state, connectionStatus: "retrying" }, { now: 10_000 }));
  });

  it("marks a stale tool execution start as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "tool_execution_start", toolCallId: "tool_1" } as AgentEvent,
      { now: 1_000 },
    );

    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));
  });

  it("marks a stale tool execution update as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "tool_execution_update", toolCallId: "tool_1" } as AgentEvent,
      { now: 1_000 },
    );

    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));
  });

  it("marks a stale agent start as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(state, { type: "agent_start" } as AgentEvent, {
      now: 1_000,
    });

    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));
  });

  it("marks a stale message start as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(state, { type: "message_start" } as AgentEvent, {
      now: 1_000,
    });

    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));
  });

  it("marks an uncommitted stale step after message_end as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "user",
        stepKey: "do:command-0-followUp",
        epoch: "epoch-1",
        payload: { type: "message_end", message: message("done") } as AgentEvent,
      },
      { now: 1_000 },
    );

    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));
  });

  it("marks an uncommitted stale step after agent_end as possibly stuck", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "user",
        stepKey: "do:command-0-followUp",
        epoch: "epoch-1",
        payload: { type: "agent_end" } as AgentEvent,
      },
      { now: 1_000 },
    );

    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));
  });

  it("detects an open session as possibly stuck when the last event is non-terminal and stale", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });
    state = reducePiSessionStreamFrame(
      state,
      { type: "message_update", message: message("partial") } as AgentEvent,
      { now: 1_000 },
    );

    assert(!isPiSessionPossiblyStuck(state, { now: 5_999 }));
    assert(isPiSessionPossiblyStuck(state, { now: 6_000 }));

    const ended = reducePiSessionStreamFrame(
      state,
      { type: "message_end", message: message("done") } as AgentEvent,
      { now: 6_000 },
    );
    assert(!isPiSessionPossiblyStuck(ended, { now: 20_000 }));
  });

  it("rolls back stale step-emission events when a competing epoch commits", () => {
    let state = createInitialPiSessionStoreState({
      workflowName: "workflow_1",
      sessionId: "session_1",
    });
    state = reducePiSessionStreamFrame(state, { type: "snapshot", state: snapshot }, { now: 1 });

    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "user",
        stepKey: "do:racy client message",
        epoch: "first-epoch",
        payload: { type: "message_update", message: message("first stale") } as AgentEvent,
      },
      { now: 2 },
    );
    expect(state.agent?.messages).toEqual([message("first stale")]);

    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "user",
        stepKey: "do:racy client message",
        epoch: "second-epoch",
        payload: { type: "message_update", message: message("second valid") } as AgentEvent,
      },
      { now: 3 },
    );
    state = reducePiSessionStreamFrame(
      state,
      {
        kind: "step-emission",
        actor: "system",
        stepKey: "do:racy client message",
        epoch: "second-epoch",
        payload: { control: "step-committed", epoch: "second-epoch" },
      },
      { now: 4 },
    );

    expect(state.agent?.messages).toEqual([message("second valid")]);
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
      workflowName: "workflow_1",
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
      workflowName: "workflow_1",
      sessionId: "session_1",
      signal: new AbortController().signal,
    });
    const iterator = frames[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => assert(eventsStore.listenerCount() === 1));

    eventsStore.set({ loading: false, error: storeError });
    await expect(next).rejects.toBe(storeError);
    assert(eventsStore.listenerCount() === 0);
  });

  it("unsubscribes when aborted", async () => {
    const eventsStore = createEventsStore();
    const controller = new AbortController();
    const transport = createStorePiSessionTransport({
      openEventsStore: () => eventsStore.store,
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    });

    const frames = await transport.openEvents({
      workflowName: "workflow_1",
      sessionId: "session_1",
      signal: controller.signal,
    });
    const iterator = frames[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => assert(eventsStore.listenerCount() === 1));

    controller.abort();
    await expect(next).rejects.toThrow("Request was aborted");
    assert(eventsStore.listenerCount() === 0);
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
      assert(store.get().connectionStatus === "open");
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

    await vi.waitFor(() => assert(store.get().connectionStatus === "open"));
    unsubscribe();

    await vi.waitFor(() => assert(aborted));
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

  it("sends commands with the current path atom values", async () => {
    const workflowName = atom("workflow_1");
    const sessionId = atom("session_1");
    const sentPaths: Array<{ workflowName: string; sessionId: string }> = [];
    const transport: PiSessionTransport = {
      openEvents: async () => stream([{ type: "snapshot", state: snapshot }]),
      sendCommand: async ({ workflowName, sessionId }) => {
        sentPaths.push({ workflowName, sessionId });
        return { accepted: true, commandId: "cmd_1", status: "active" };
      },
    };

    const store = createPiSessionStore(
      { path: { workflowName, sessionId } },
      { transport, retryDelay: () => 0, now: () => 100 },
    );

    workflowName.set("workflow_2");
    sessionId.set("session_2");

    await store.sendCommand({ kind: "continue" });

    expect(sentPaths).toEqual([{ workflowName: "workflow_2", sessionId: "session_2" }]);
    expect(store.get()).toMatchObject({ workflowName: "workflow_2", sessionId: "session_2" });
  });

  it("reopens events with the current path atom values after navigation", async () => {
    const workflowName = atom("workflow_1");
    const sessionId = atom("session_1");
    const openedPaths: Array<{ workflowName: string; sessionId: string }> = [];
    const transport: PiSessionTransport = {
      openEvents: async ({ workflowName, sessionId, signal }) =>
        (async function* () {
          openedPaths.push({ workflowName, sessionId });
          yield { type: "snapshot", state: snapshot };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createPiSessionStore(
      { path: { workflowName, sessionId } },
      { transport, retryDelay: () => 0, now: () => 100 },
    );
    const unsubscribe = store.subscribe(() => {});
    await vi.waitFor(() => expect(openedPaths).toHaveLength(1));

    workflowName.set("workflow_2");
    sessionId.set("session_2");

    await vi.waitFor(() =>
      expect(openedPaths).toContainEqual({ workflowName: "workflow_2", sessionId: "session_2" }),
    );
    expect(store.get()).toMatchObject({ workflowName: "workflow_2", sessionId: "session_2" });

    unsubscribe();
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

  it("exposes draft tool call input while the assistant writes arguments", async () => {
    const partialMessage = (arguments_: Record<string, unknown>) =>
      ({
        role: "assistant",
        content: [{ type: "toolCall", id: "tool_1", name: "bash", arguments: arguments_ }],
        timestamp: 1,
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "toolUse",
      }) as unknown as Extract<AgentMessage, { role: "assistant" }>;

    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          yield { type: "snapshot", state: snapshot };
          yield { type: "message_start", message: partialMessage({}) } as AgentEvent;
          yield {
            type: "message_update",
            message: partialMessage({}),
            assistantMessageEvent: {
              type: "toolcall_start",
              contentIndex: 0,
              partial: partialMessage({}),
            },
          } as AgentEvent;
          yield {
            type: "message_update",
            message: partialMessage({ command: "pnpm test" }),
            assistantMessageEvent: {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: '{"command":"pnpm test',
              partial: partialMessage({ command: "pnpm test" }),
            },
          } as AgentEvent;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
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
  });

  it("exposes execCodeMode draft input from provider partial JSON before the final tool call", async () => {
    const partialMessage = (partialJson: string, arguments_: Record<string, unknown> = {}) =>
      ({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool_1",
            name: "execCodeMode",
            arguments: arguments_,
            partialJson,
          },
        ],
        timestamp: 1,
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "toolUse",
      }) as unknown as Extract<AgentMessage, { role: "assistant" }>;

    const partialCode = 'await state.writeFile("/tmp/streaming.txt", "still writing';
    const partialJson = JSON.stringify({ code: partialCode }).slice(0, -2);

    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          yield { type: "snapshot", state: snapshot };
          yield { type: "message_start", message: partialMessage("") } as AgentEvent;
          yield {
            type: "message_update",
            message: partialMessage(""),
            assistantMessageEvent: {
              type: "toolcall_start",
              contentIndex: 0,
              partial: partialMessage(""),
            },
          } as AgentEvent;
          yield {
            type: "message_update",
            message: partialMessage(partialJson),
            assistantMessageEvent: {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: "",
              partial: partialMessage(partialJson),
            },
          } as AgentEvent;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store.messages.get()).toMatchObject([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool_1",
              name: "execCodeMode",
              partialJson,
            },
          ],
        },
      ]);
    });

    await vi.waitFor(() => {
      expect(store.draftToolCalls.get()).toMatchObject([
        {
          toolCallId: "tool_1",
          toolName: "execCodeMode",
          argumentsText: partialJson,
          argumentsValue: { code: partialCode },
          status: "streaming",
        },
      ]);
    });

    unsubscribe();
  });

  it("removes draft tool calls when execution starts", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tool_1", name: "bash", arguments: { command: "ls" } }],
      timestamp: 1,
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: "toolUse",
    } as unknown as Extract<AgentMessage, { role: "assistant" }>;

    const transport: PiSessionTransport = {
      openEvents: async ({ signal }) =>
        (async function* () {
          yield { type: "snapshot", state: snapshot };
          yield { type: "message_start", message: assistant } as AgentEvent;
          yield {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: assistant.content[0],
              partial: assistant,
            },
          } as AgentEvent;
          yield {
            type: "tool_execution_start",
            toolCallId: "tool_1",
            toolName: "bash",
            args: { command: "ls" },
          } as AgentEvent;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
      sendCommand: async () => ({ accepted: true, commandId: "cmd_1", status: "active" }),
    };

    const store = createStore(transport);
    const unsubscribe = store.subscribe(() => {});

    await vi.waitFor(() =>
      expect(store.runningTools.get()).toMatchObject([
        { toolCallId: "tool_1", toolName: "bash", args: { command: "ls" } },
      ]),
    );
    expect(store.draftToolCalls.get()).toEqual([]);
    expect(store.messages.get()).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool_1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    ]);

    unsubscribe();
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
    assert(store.get().connectionStatus === "open");

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
      assert(store.get().connectionStatus === "open");
      expect(opens).toBe(2);
    });

    unsubscribe();
  });
});
