import { FragnoClientApiError, FragnoClientFetchAbortError } from "@fragno-dev/core/client";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import type { z } from "zod";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type { commandAckSchema, commandInputSchema } from "../pi/route-schemas";
import type { PiAgentStateSnapshot, PiSessionDetail, PiSessionEventStreamItem } from "../pi/types";

export type PiSessionCommandInput = z.infer<typeof commandInputSchema>;
export type PiSessionCommandAck = z.infer<typeof commandAckSchema>;

export type PiSessionConnectionStatus = "idle" | "connecting" | "open" | "retrying" | "error";

export type PiLiveToolExecution = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown | null;
};

export type PiSessionStoreArgs = {
  path: {
    sessionId: string | ReadableAtom<string>;
  };
  initialData?: PiSessionDetail;
};

export type PiSessionStoreState = {
  connectionStatus: PiSessionConnectionStatus;
  sessionId: string;
  agent: PiAgentStateSnapshot | null;
  events: Array<Exclude<PiSessionEventStreamItem, SnapshotFrame>>;
  lastEvent: AgentEvent | null;
  lastFrameAt: number | null;
  reconnectAttempt: number;
  streamError: unknown;
  command: {
    loading: boolean;
    error: unknown;
    lastAck: PiSessionCommandAck | null;
  };
};

export type PiSessionTransport = {
  openEvents(args: {
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AsyncIterable<PiSessionEventStreamItem>>;
  sendCommand(args: {
    sessionId: string;
    command: PiSessionCommandInput;
    signal?: AbortSignal;
  }): Promise<PiSessionCommandAck>;
};

export type PiSessionStoreDeps = {
  transport: PiSessionTransport;
  now?: () => number;
  retryDelay?: (args: { attempt: number; error: unknown }) => number | null | undefined;
};

type EventsStoreState = {
  loading: boolean;
  data?: PiSessionEventStreamItem[];
  error?: unknown;
};

type EventsStore = {
  get(): EventsStoreState;
  listen(listener: (state: EventsStoreState) => void): () => void;
};

type StoreTransportOptions = {
  openEventsStore: (args: { sessionId: string }) => EventsStore;
  sendCommand: PiSessionTransport["sendCommand"];
};

class PiSessionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionProtocolError";
  }
}

const defaultRetryDelay = ({ attempt }: { attempt: number; error: unknown }) =>
  Math.min(10_000, 500 * 2 ** Math.min(attempt, 8));

const readAtom = <T>(value: T | ReadableAtom<T>): T =>
  value && typeof value === "object" && "get" in value && typeof value.get === "function"
    ? value.get()
    : (value as T);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new FragnoClientFetchAbortError("Request was aborted"));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        reject(new FragnoClientFetchAbortError("Request was aborted"));
      },
      { once: true },
    );
  });

const isStopAbort = (error: unknown, stopped: boolean) =>
  stopped && error instanceof FragnoClientFetchAbortError;

const isFatalStreamError = (error: unknown) => {
  if (!(error instanceof FragnoClientApiError)) {
    return false;
  }

  return error.status === 404 || error.code === "SESSION_NOT_FOUND";
};

type SnapshotFrame = Extract<PiSessionEventStreamItem, { type: "snapshot" }>;
const isSnapshotFrame = (frame: PiSessionEventStreamItem): frame is SnapshotFrame =>
  "type" in frame && frame.type === "snapshot";

const isAgentEvent = (frame: PiSessionEventStreamItem): frame is AgentEvent =>
  "type" in frame && frame.type !== "snapshot";

const replaceLastMessage = (messages: AgentMessage[], message: AgentMessage): AgentMessage[] =>
  messages.length === 0 ? [message] : [...messages.slice(0, -1), message];

const reduceMessages = (
  messages: AgentMessage[],
  event: AgentEvent,
  previousEvent: AgentEvent | null,
): AgentMessage[] => {
  if (event.type === "message_update") {
    return previousEvent?.type === "message_update"
      ? replaceLastMessage(messages, event.message)
      : [...messages, event.message];
  }

  if (event.type === "message_end") {
    return previousEvent?.type === "message_update"
      ? replaceLastMessage(messages, event.message)
      : [...messages, event.message];
  }

  return messages;
};

export const createInitialPiSessionStoreState = (options: {
  sessionId: string;
}): PiSessionStoreState => ({
  connectionStatus: "idle",
  sessionId: options.sessionId,
  agent: null,
  events: [],
  lastEvent: null,
  lastFrameAt: null,
  reconnectAttempt: 0,
  streamError: undefined,
  command: {
    loading: false,
    error: undefined,
    lastAck: null,
  },
});

export const reducePiSessionStreamFrame = (
  state: PiSessionStoreState,
  frame: PiSessionEventStreamItem,
  meta: { now: number },
): PiSessionStoreState => {
  if (isSnapshotFrame(frame)) {
    return {
      ...state,
      connectionStatus: "open",
      agent: frame.state,
      lastFrameAt: meta.now,
      streamError: undefined,
    };
  }

  if (!isAgentEvent(frame)) {
    return {
      ...state,
      connectionStatus: "open",
      events: [...state.events, frame],
      lastFrameAt: meta.now,
      streamError: undefined,
    };
  }

  const currentAgent = state.agent ?? { messages: [] };
  return {
    ...state,
    connectionStatus: "open",
    agent: {
      ...currentAgent,
      messages: reduceMessages(currentAgent.messages, frame, state.lastEvent),
    },
    events: [...state.events, frame],
    lastEvent: frame,
    lastFrameAt: meta.now,
    streamError: undefined,
  };
};

const abortError = () => new FragnoClientFetchAbortError("Request was aborted");

async function* eventsStoreToAsyncIterable(
  store: EventsStore,
  signal: AbortSignal,
): AsyncIterable<PiSessionEventStreamItem> {
  let seen = 0;
  let queued: PiSessionEventStreamItem[] = [];
  let notify: (() => void) | null = null;
  let error: unknown;

  const wake = () => {
    notify?.();
    notify = null;
  };

  const pushState = (state: EventsStoreState) => {
    if (state.error) {
      error = state.error;
      wake();
      return;
    }

    const data = state.data ?? [];
    if (data.length > seen) {
      queued = [...queued, ...data.slice(seen)];
      seen = data.length;
      wake();
    }
  };

  const unsubscribe = store.listen(pushState);
  const onAbort = () => {
    error = abortError();
    wake();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    pushState(store.get());

    while (true) {
      if (queued.length > 0) {
        yield queued.shift()!;
        continue;
      }

      if (error) {
        throw error;
      }

      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

export const createStorePiSessionTransport = ({
  openEventsStore,
  sendCommand,
}: StoreTransportOptions): PiSessionTransport => ({
  openEvents: async ({ sessionId, signal }) =>
    eventsStoreToAsyncIterable(openEventsStore({ sessionId }), signal),
  sendCommand,
});

const runningToolsFromEvents = (
  events: Array<Exclude<PiSessionEventStreamItem, SnapshotFrame>>,
): PiLiveToolExecution[] => {
  const running = new Map<string, PiLiveToolExecution>();
  for (const event of events) {
    if (!isAgentEvent(event)) {
      continue;
    }
    if (event.type === "tool_execution_start") {
      const toolEvent = event as AgentEvent & {
        toolCallId: string;
        toolName?: string;
        name?: string;
        args?: unknown;
      };
      running.set(toolEvent.toolCallId, {
        toolCallId: toolEvent.toolCallId,
        toolName: toolEvent.toolName ?? toolEvent.name ?? "Tool call",
        args: toolEvent.args ?? null,
        partialResult: null,
      });
      continue;
    }
    if (event.type === "tool_execution_update") {
      const toolEvent = event as AgentEvent & {
        toolCallId: string;
        toolName?: string;
        name?: string;
        args?: unknown;
        partialResult?: unknown;
      };
      const current = running.get(toolEvent.toolCallId);
      running.set(toolEvent.toolCallId, {
        toolCallId: toolEvent.toolCallId,
        toolName: toolEvent.toolName ?? toolEvent.name ?? current?.toolName ?? "Tool call",
        args: toolEvent.args ?? current?.args ?? null,
        partialResult: toolEvent.partialResult ?? current?.partialResult ?? null,
      });
      continue;
    }
    if (event.type === "tool_execution_end") {
      running.delete((event as AgentEvent & { toolCallId: string }).toolCallId);
    }
  }
  return [...running.values()];
};

export const createPiSessionStore = (args: PiSessionStoreArgs, deps: PiSessionStoreDeps) => {
  const sessionId = readAtom(args.path.sessionId);
  const now = deps.now ?? (() => Date.now());
  const retryDelay = deps.retryDelay ?? defaultRetryDelay;
  const initialState = createInitialPiSessionStoreState({ sessionId });
  const state = atom<PiSessionStoreState>({
    ...initialState,
    agent: args.initialData?.agent.state ?? initialState.agent,
    events: args.initialData?.agent.events ?? initialState.events,
  });

  let stopController: AbortController | null = null;
  let streamController: AbortController | null = null;
  let running = false;
  let stopped = true;

  const setState = (updater: (current: PiSessionStoreState) => PiSessionStoreState) => {
    state.set(updater(state.get()));
  };

  const run = async () => {
    if (running) {
      return;
    }

    running = true;
    stopped = false;
    stopController = new AbortController();
    let attempt = 0;

    try {
      while (!stopped) {
        streamController = new AbortController();
        const stopSignal = stopController.signal;
        const abortCurrentStream = () => streamController?.abort();
        stopSignal.addEventListener("abort", abortCurrentStream, { once: true });

        setState((current) => ({
          ...current,
          connectionStatus: attempt === 0 ? "connecting" : "retrying",
          reconnectAttempt: attempt,
          streamError: undefined,
        }));

        let sawSnapshot = false;
        let streamError: unknown;

        try {
          const frames = await deps.transport.openEvents({
            sessionId,
            signal: streamController.signal,
          });

          for await (const frame of frames) {
            if (!sawSnapshot) {
              if (!isSnapshotFrame(frame)) {
                throw new PiSessionProtocolError("Expected /events stream to start with snapshot.");
              }
              sawSnapshot = true;
            }

            setState((current) => reducePiSessionStreamFrame(current, frame, { now: now() }));
          }
        } catch (error) {
          streamError = error;
        } finally {
          stopSignal.removeEventListener("abort", abortCurrentStream);
        }

        if (stopped) {
          break;
        }

        if (isStopAbort(streamError, stopped)) {
          break;
        }

        if (isFatalStreamError(streamError)) {
          setState((current) => ({ ...current, connectionStatus: "error", streamError }));
          break;
        }

        attempt += 1;
        setState((current) => ({
          ...current,
          connectionStatus: "retrying",
          reconnectAttempt: attempt,
          streamError,
        }));

        const delay = retryDelay({ attempt, error: streamError });
        if (delay === null || delay === undefined) {
          setState((current) => ({ ...current, connectionStatus: "error" }));
          break;
        }

        await sleep(delay, stopSignal);
      }
    } catch (error) {
      if (!isStopAbort(error, stopped)) {
        setState((current) => ({ ...current, connectionStatus: "error", streamError: error }));
      }
    } finally {
      streamController = null;
      stopController = null;
      running = false;
      if (stopped) {
        setState((current) => ({ ...current, connectionStatus: "idle" }));
      }
    }
  };

  const stop = () => {
    stopped = true;
    streamController?.abort();
    stopController?.abort();
  };

  const agentState = computed(
    state,
    ($state) => $state.agent ?? args.initialData?.agent.state ?? { messages: [] },
  );
  const events = computed(state, ($state) => $state.events);
  const messages = computed(agentState, ($agent) => $agent.messages);
  const runningTools = computed(events, runningToolsFromEvents);
  const readyForInput = computed(
    [state, runningTools],
    ($state, $runningTools) => $state.connectionStatus === "open" && $runningTools.length === 0,
  );
  const sending = computed(state, ($state) => $state.command.loading);
  const error = computed(state, ($state) =>
    $state.streamError instanceof Error ? $state.streamError.message : null,
  );
  const sendError = computed(state, ($state) =>
    $state.command.error instanceof Error ? $state.command.error.message : null,
  );
  const statusText = computed([state, runningTools], ($state, $runningTools) => {
    if ($state.command.loading) {
      return "Sending…";
    }
    if ($state.connectionStatus === "connecting") {
      return "Connecting…";
    }
    if ($state.connectionStatus === "retrying") {
      return "Reconnecting…";
    }
    if ($runningTools.length > 0) {
      return "Running tool calls…";
    }
    return null;
  });
  const session = computed([agentState, events, state], ($agent, $events) =>
    args.initialData
      ? {
          ...args.initialData,
          agent: { state: $agent, events: $events },
        }
      : null,
  );

  onMount(state, () => {
    void run();
    return stop;
  });

  return {
    state,
    session,
    messages,
    events,
    runningTools,
    readyForInput,
    sending,
    error,
    sendError,
    statusText,
    get: state.get.bind(state),
    listen: state.listen.bind(state),
    subscribe: state.subscribe.bind(state),
    reconnect: () => {
      stop();
      void (async () => {
        while (running) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await run();
      })();
    },
    disconnect: stop,
    sendCommand: async (command: PiSessionCommandInput, options?: { signal?: AbortSignal }) => {
      setState((current) => ({
        ...current,
        command: { ...current.command, loading: true, error: undefined },
      }));

      try {
        const ack = await deps.transport.sendCommand({
          sessionId,
          command,
          signal: options?.signal,
        });
        setState((current) => ({
          ...current,
          command: { loading: false, error: undefined, lastAck: ack },
        }));
        return ack;
      } catch (error) {
        setState((current) => ({
          ...current,
          command: { ...current.command, loading: false, error },
        }));
        throw error;
      }
    },
    [Symbol.dispose]: stop,
  };
};
