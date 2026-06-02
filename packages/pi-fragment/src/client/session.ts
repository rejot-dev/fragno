import { FragnoClientApiError, FragnoClientFetchAbortError } from "@fragno-dev/core/client";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import type { z } from "zod";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

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
    workflowName: string | ReadableAtom<string>;
    sessionId: string | ReadableAtom<string>;
  };
  initialData?: PiSessionDetail;
};

export type PiSessionStoreState = {
  connectionStatus: PiSessionConnectionStatus;
  workflowName: string;
  sessionId: string;
  agent: PiAgentStateSnapshot | null;
  snapshotAgent: PiAgentStateSnapshot | null;
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
    workflowName: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AsyncIterable<PiSessionEventStreamItem>>;
  sendCommand(args: {
    workflowName: string;
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
  subscribe?: (listener: (state: EventsStoreState) => void) => () => void;
};

type StoreTransportOptions = {
  openEventsStore: (args: { workflowName: string; sessionId: string }) => EventsStore;
  sendCommand: PiSessionTransport["sendCommand"];
};

class PiSessionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionProtocolError";
  }
}

export const PI_SESSION_STUCK_AFTER_MS = 5_000;

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

const replaceLastMessage = (messages: AgentMessage[], message: AgentMessage): AgentMessage[] =>
  messages.length === 0 ? [message] : [...messages.slice(0, -1), message];

const reduceMessages = (
  messages: AgentMessage[],
  event: AgentEvent,
  previousEvent: AgentEvent | null,
  hasOpenMessageDraft: boolean,
): AgentMessage[] => {
  // If a prior stream died after message_update, recovery can emit agent/turn events before the
  // next message_start. Track the open draft across those events and drop it when the recovered
  // message starts, so the next update reuses the same visual assistant slot.
  if (event.type === "message_start" && hasOpenMessageDraft) {
    return messages.slice(0, -1);
  }

  if (event.type === "message_update") {
    return hasOpenMessageDraft && previousEvent?.type !== "message_start"
      ? replaceLastMessage(messages, event.message)
      : [...messages, event.message];
  }

  if (event.type === "message_end") {
    return hasOpenMessageDraft
      ? replaceLastMessage(messages, event.message)
      : [...messages, event.message];
  }

  return messages;
};

export const createInitialPiSessionStoreState = (options: {
  workflowName: string;
  sessionId: string;
}): PiSessionStoreState => ({
  connectionStatus: "idle",
  workflowName: options.workflowName,
  sessionId: options.sessionId,
  agent: null,
  snapshotAgent: null,
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

const committedEpochsByStep = (events: Array<Exclude<PiSessionEventStreamItem, SnapshotFrame>>) => {
  const committed = new Map<string, string>();
  for (const event of events) {
    if ("kind" in event && event.kind === "step-emission") {
      const payload = event.payload;
      if (
        typeof payload === "object" &&
        payload !== null &&
        "control" in payload &&
        payload.control === "step-committed"
      ) {
        committed.set(event.stepKey, event.epoch);
      }
    }
  }
  return committed;
};

const agentEventFromStreamFrame = (
  frame: Exclude<PiSessionEventStreamItem, SnapshotFrame>,
  committedEpochs: ReadonlyMap<string, string>,
): AgentEvent | null => {
  if ("type" in frame) {
    return frame;
  }
  if (!("kind" in frame) || frame.kind !== "step-emission") {
    return null;
  }

  const payload = frame.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("type" in payload) ||
    payload.type === "snapshot"
  ) {
    return null;
  }

  const committedEpoch = committedEpochs.get(frame.stepKey);
  if (committedEpoch && committedEpoch !== frame.epoch) {
    return null;
  }

  return payload as AgentEvent;
};

const rebuildAgentState = (
  snapshotAgent: PiAgentStateSnapshot,
  events: Array<Exclude<PiSessionEventStreamItem, SnapshotFrame>>,
): { agent: PiAgentStateSnapshot; lastEvent: AgentEvent | null } => {
  const committedEpochs = committedEpochsByStep(events);
  let messages = snapshotAgent.messages;
  let previousEvent: AgentEvent | null = null;
  let hasOpenMessageDraft = false;

  for (const event of events) {
    const agentEvent = agentEventFromStreamFrame(event, committedEpochs);
    if (!agentEvent) {
      continue;
    }
    messages = reduceMessages(messages, agentEvent, previousEvent, hasOpenMessageDraft);

    if (agentEvent.type === "message_update") {
      hasOpenMessageDraft = true;
    }
    if (agentEvent.type === "message_end") {
      hasOpenMessageDraft = false;
    }
    previousEvent = agentEvent;
  }

  return { agent: { ...snapshotAgent, messages }, lastEvent: previousEvent };
};

const latestStepEmissionCommitState = (
  events: Array<Exclude<PiSessionEventStreamItem, SnapshotFrame>>,
): "none" | "committed" | "uncommitted" => {
  const committed = committedEpochsByStep(events);
  const latestStepEmission = events.findLast(
    (frame) => "kind" in frame && frame.kind === "step-emission",
  );

  if (!latestStepEmission || latestStepEmission.kind !== "step-emission") {
    return "none";
  }

  return committed.get(latestStepEmission.stepKey) === latestStepEmission.epoch
    ? "committed"
    : "uncommitted";
};

export const isPiSessionPossiblyStuck = (
  state: PiSessionStoreState,
  meta: { now: number; stuckAfterMs?: number },
) => {
  if (
    state.connectionStatus !== "open" ||
    state.lastFrameAt === null ||
    meta.now - state.lastFrameAt < (meta.stuckAfterMs ?? PI_SESSION_STUCK_AFTER_MS)
  ) {
    return false;
  }

  const latestStepCommitState = latestStepEmissionCommitState(state.events);
  if (latestStepCommitState === "committed") {
    return false;
  }

  return (
    latestStepCommitState === "uncommitted" ||
    (state.lastEvent !== null && !state.lastEvent.type.endsWith("_end"))
  );
};

export const reducePiSessionStreamFrame = (
  state: PiSessionStoreState,
  frame: PiSessionEventStreamItem,
  meta: { now: number },
): PiSessionStoreState => {
  if ("type" in frame && frame.type === "snapshot") {
    return {
      ...state,
      connectionStatus: "open",
      agent: frame.state,
      snapshotAgent: frame.state,
      lastFrameAt: meta.now,
      streamError: undefined,
    };
  }

  const events = [...state.events, frame];
  const snapshotAgent = state.snapshotAgent ?? { messages: [] };
  const rebuilt = rebuildAgentState(snapshotAgent, events);

  return {
    ...state,
    connectionStatus: "open",
    agent: rebuilt.agent,
    events,
    lastEvent: rebuilt.lastEvent,
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

  const unsubscribe = (store.subscribe ?? store.listen).call(store, pushState);
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
  openEvents: async ({ workflowName, sessionId, signal }) =>
    eventsStoreToAsyncIterable(openEventsStore({ workflowName, sessionId }), signal),
  sendCommand,
});

const runningToolsFromEvents = (
  events: Array<Exclude<PiSessionEventStreamItem, SnapshotFrame>>,
): PiLiveToolExecution[] => {
  const running = new Map<string, PiLiveToolExecution>();
  const committedEpochs = committedEpochsByStep(events);
  for (const frame of events) {
    const event = agentEventFromStreamFrame(frame, committedEpochs);
    if (!event) {
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
  const now = deps.now ?? (() => Date.now());
  const retryDelay = deps.retryDelay ?? defaultRetryDelay;
  const readPath = () => ({
    workflowName: readAtom(args.path.workflowName),
    sessionId: readAtom(args.path.sessionId),
  });
  const initialDataForPath = (path: { workflowName: string; sessionId: string }) =>
    args.initialData?.workflowName === path.workflowName && args.initialData.id === path.sessionId
      ? args.initialData
      : undefined;
  const createInitialStateForPath = (path: { workflowName: string; sessionId: string }) => {
    const initialState = createInitialPiSessionStoreState(path);
    const initialData = initialDataForPath(path);
    return {
      ...initialState,
      agent: initialData?.agent.state ?? initialState.agent,
      snapshotAgent: initialData?.agent.state ?? initialState.snapshotAgent,
      events: initialData?.agent.events ?? initialState.events,
    };
  };
  const createInitialState = () => createInitialStateForPath(readPath());
  const staleCheckNow = atom(now());
  onMount(staleCheckNow, () => {
    const interval = setInterval(() => staleCheckNow.set(now()), 1_000);
    return () => clearInterval(interval);
  });

  const state = atom<PiSessionStoreState>(createInitialState());

  let stopController: AbortController | null = null;
  let streamController: AbortController | null = null;
  let running = false;
  let stopped = true;

  const setState = (updater: (current: PiSessionStoreState) => PiSessionStoreState) => {
    state.set(updater(state.get()));
  };

  const pathMatchesState = (path: { workflowName: string; sessionId: string }) => {
    const current = state.get();
    return current.workflowName === path.workflowName && current.sessionId === path.sessionId;
  };

  const resetStateForCurrentPath = () => {
    if (!pathMatchesState(readPath())) {
      state.set(createInitialState());
    }
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

        const path = readPath();
        setState((current) => {
          const next =
            current.workflowName === path.workflowName && current.sessionId === path.sessionId
              ? current
              : createInitialStateForPath(path);
          return {
            ...next,
            connectionStatus: attempt === 0 ? "connecting" : "retrying",
            reconnectAttempt: attempt,
            streamError: undefined,
          };
        });

        let sawSnapshot = false;
        let streamError: unknown;

        try {
          const frames = await deps.transport.openEvents({
            ...path,
            signal: streamController.signal,
          });

          for await (const frame of frames) {
            if (!sawSnapshot) {
              if (!("type" in frame && frame.type === "snapshot")) {
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
  const needsNudge = computed([state, staleCheckNow], ($state, $now) =>
    isPiSessionPossiblyStuck($state, { now: $now }),
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
  const session = computed([agentState, events, state], ($agent, $events, $state) => {
    const initialData = initialDataForPath({
      workflowName: $state.workflowName,
      sessionId: $state.sessionId,
    });
    return initialData
      ? {
          ...initialData,
          agent: { state: $agent, events: $events },
        }
      : null;
  });

  const reconnectToCurrentPath = () => {
    const wasRunning = !stopped;
    resetStateForCurrentPath();
    if (!wasRunning) {
      return;
    }
    stop();
    void (async () => {
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await run();
    })();
  };

  const listenPathAtom = <T>(value: T | ReadableAtom<T>) =>
    value && typeof value === "object" && "listen" in value && typeof value.listen === "function"
      ? value.listen(reconnectToCurrentPath)
      : undefined;

  onMount(state, () => {
    const unlistenWorkflowName = listenPathAtom(args.path.workflowName);
    const unlistenSessionId = listenPathAtom(args.path.sessionId);
    resetStateForCurrentPath();
    void run();
    return () => {
      unlistenWorkflowName?.();
      unlistenSessionId?.();
      stop();
    };
  });

  return {
    state,
    session,
    messages,
    events,
    runningTools,
    readyForInput,
    needsNudge,
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
        const path = readPath();
        setState((current) =>
          current.workflowName === path.workflowName && current.sessionId === path.sessionId
            ? current
            : { ...createInitialStateForPath(path), command: current.command },
        );
        const ack = await deps.transport.sendCommand({
          ...path,
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
