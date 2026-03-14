import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  PiActiveSessionProtocolMessage,
  PiAgentLoopPhase,
  PiAgentLoopWaitingFor,
  PiSessionDetail,
} from "../pi/types";
import type { PiSessionStatus } from "../pi/constants";

type QueryStoreValue<T> = {
  loading: boolean;
  data?: T;
  error?: { message?: string };
};

type QueryStore<T> = ReadableAtom<QueryStoreValue<T>> & {
  revalidate: () => void;
};

type ToolResultContent = Extract<AgentMessage, { role: "toolResult" }>["content"];

type OptimisticMessage = {
  clientId: string;
  message: AgentMessage;
};

type LiveActivity =
  | { kind: "none" }
  | { kind: "sending-message" }
  | { kind: "assistant-responding" }
  | { kind: "assistant-ready" }
  | { kind: "tool-running"; toolName: string }
  | { kind: "tool-updating"; toolName: string }
  | { kind: "tool-finished"; toolName: string }
  | { kind: "agent-started" }
  | { kind: "agent-finished" }
  | { kind: "turn-started" }
  | { kind: "turn-finished" };

export type PiLiveToolExecution = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown | null;
};

export type PiSessionConnectionState =
  | "idle"
  | "connecting"
  | "listening"
  | "reconnecting"
  | "error";

type OverlayState = {
  sessionId: string;
  connection: PiSessionConnectionState;
  error: string | null;
  sendError: string | null;
  sending: boolean;
  activity: LiveActivity;
  pendingTurn: boolean;
  pendingSnapshotReconcile: boolean;
  readyForInputOverride: boolean | null;
  optimisticMessages: OptimisticMessage[];
  streamedMessages: AgentMessage[];
  draftAssistant: AgentMessage | null;
  runningTools: PiLiveToolExecution[];
  trace: AgentEvent[];
};

type OverlayAction =
  | { type: "snapshot-updated"; sessionId: string }
  | { type: "send-started"; clientId: string; text: string }
  | { type: "send-failed"; clientId: string; message: string }
  | { type: "send-acknowledged" }
  | { type: "stream-connecting"; reconnecting: boolean }
  | { type: "stream-open" }
  | { type: "stream-message"; message: PiActiveSessionProtocolMessage }
  | { type: "stream-settled" }
  | { type: "stream-inactive" }
  | { type: "stream-error"; message: string }
  | { type: "stream-idle" };

export type PiSessionStoreState = {
  loading: boolean;
  session: PiSessionDetail | null;
  messages: AgentMessage[];
  traceEvents: AgentEvent[];
  runningTools: PiLiveToolExecution[];
  connection: PiSessionConnectionState;
  statusText: string | null;
  readyForInput: boolean;
  sending: boolean;
  error: string | null;
  sendError: string | null;
};

export type CreatePiSessionStoreArgs = {
  sessionId: string;
  initialData?: PiSessionDetail | null;
};

export type PiSessionStoreController = {
  store: ReadableAtom<PiSessionStoreState>;
  sendMessage: (input: {
    text: string;
    done?: boolean;
    steeringMode?: "all" | "one-at-a-time";
  }) => boolean;
  refetch: () => void;
  deactivate: () => void;
  destroy: () => void;
};

export type CreatePiSessionStoreDependencies = {
  createDetailStore: (sessionId: string) => QueryStore<PiSessionDetail>;
  sendMessage: (options: {
    sessionId: string;
    text: string;
    done?: boolean;
    steeringMode?: "all" | "one-at-a-time";
  }) => Promise<{ status: PiSessionStatus }>;
  buildActiveUrl: (sessionId: string) => string;
  fetcher: typeof fetch;
  defaultOptions?: RequestInit;
  enableActiveStream?: boolean;
  activeLogger?: (event: string, details?: Record<string, unknown>) => void;
};

const createOverlayState = (sessionId: string): OverlayState => ({
  sessionId,
  connection: "idle" as const,
  error: null,
  sendError: null,
  sending: false,
  activity: { kind: "none" as const },
  pendingTurn: false,
  pendingSnapshotReconcile: false,
  readyForInputOverride: null,
  optimisticMessages: [],
  streamedMessages: [],
  draftAssistant: null,
  runningTools: [],
  trace: [],
});

const buildOptimisticUserMessage = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const buildLiveToolResultMessage = (
  message: Extract<PiActiveSessionProtocolMessage, { layer: "pi"; type: "event" }>["event"] & {
    type: "tool_execution_end";
  },
): AgentMessage => {
  const result = message.result as {
    content?: ToolResultContent;
    details?: unknown;
  } | null;
  const content: ToolResultContent =
    result && Array.isArray(result.content)
      ? result.content
      : [{ type: "text", text: formatJson(message.result) }];

  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content,
    details: result?.details,
    isError: message.isError,
    timestamp: Date.now(),
  };
};

const appendOrReplaceLiveMessage = (messages: AgentMessage[], nextMessage: AgentMessage) => {
  if (nextMessage.role === "assistant") {
    const existingIndex = messages.findIndex(
      (message) => message.role === "assistant" && message.timestamp === nextMessage.timestamp,
    );
    if (existingIndex >= 0) {
      return [
        ...messages.slice(0, existingIndex),
        nextMessage,
        ...messages.slice(existingIndex + 1),
      ];
    }
  }

  if (nextMessage.role === "toolResult") {
    const existingIndex = messages.findIndex(
      (message) => message.role === "toolResult" && message.toolCallId === nextMessage.toolCallId,
    );
    if (existingIndex >= 0) {
      return [
        ...messages.slice(0, existingIndex),
        nextMessage,
        ...messages.slice(existingIndex + 1),
      ];
    }
  }

  return [...messages, nextMessage];
};

const mergeMessages = (
  snapshotMessages: AgentMessage[],
  optimisticMessages: AgentMessage[],
  streamedMessages: AgentMessage[],
  draftAssistant: AgentMessage | null,
) => {
  let messages = [...snapshotMessages];

  for (const optimisticMessage of optimisticMessages) {
    messages = appendOrReplaceLiveMessage(messages, optimisticMessage);
  }

  for (const streamedMessage of streamedMessages) {
    messages = appendOrReplaceLiveMessage(messages, streamedMessage);
  }

  if (draftAssistant) {
    messages = appendOrReplaceLiveMessage(messages, draftAssistant);
  }

  return messages;
};

const hasActiveOverlay = (
  state: Pick<OverlayState, "draftAssistant" | "runningTools" | "streamedMessages">,
) =>
  state.draftAssistant !== null ||
  state.runningTools.length > 0 ||
  state.streamedMessages.length > 0;

const activityLabel = (activity: LiveActivity): string | null => {
  switch (activity.kind) {
    case "none":
      return null;
    case "sending-message":
      return "Sending message";
    case "assistant-responding":
      return "Assistant responding";
    case "assistant-ready":
      return "Assistant response ready";
    case "tool-running":
      return `Running ${activity.toolName}`;
    case "tool-updating":
      return `Updating ${activity.toolName}`;
    case "tool-finished":
      return `${activity.toolName} finished`;
    case "agent-started":
      return "Agent started";
    case "agent-finished":
      return "Agent finished";
    case "turn-started":
      return "Turn started";
    case "turn-finished":
      return "Turn finished";
    default:
      return null;
  }
};

const connectionStatusText = (connection: PiSessionConnectionState): string | null => {
  switch (connection) {
    case "connecting":
      return "Connecting to live updates";
    case "reconnecting":
      return "Reconnecting to live updates";
    default:
      return null;
  }
};

const reduceProtocolMessage = (state: OverlayState, message: PiActiveSessionProtocolMessage) => {
  if (message.layer === "system") {
    switch (message.type) {
      case "snapshot": {
        const readyForInput = isSessionReadyForInput(message.phase, message.waitingFor);
        return {
          ...state,
          error: null,
          activity: readyForInput ? { kind: "none" as const } : state.activity,
          pendingTurn: !readyForInput,
          readyForInputOverride: readyForInput,
        };
      }
      case "inactive":
        return {
          ...state,
          connection: "idle" as const,
          error: null,
          readyForInputOverride: false,
        };
      case "settled":
        return {
          ...state,
          connection: "reconnecting" as const,
          activity: { kind: "turn-finished" as const },
          pendingTurn: true,
          pendingSnapshotReconcile: true,
          readyForInputOverride: false,
          error: null,
        };
      default:
        return state;
    }
  }

  const event = message.event;
  const trace = [...state.trace, event];

  switch (event.type) {
    case "message_start":
    case "message_update":
      return {
        ...state,
        trace,
        draftAssistant: event.message,
        activity: { kind: "assistant-responding" as const },
        pendingTurn: true,
        error: null,
      };
    case "message_end":
      return {
        ...state,
        trace,
        streamedMessages: appendOrReplaceLiveMessage(state.streamedMessages, event.message),
        draftAssistant: null,
        activity: { kind: "assistant-ready" as const },
        pendingTurn: true,
        error: null,
      };
    case "tool_execution_start":
      return {
        ...state,
        trace,
        runningTools: [
          ...state.runningTools.filter((tool) => tool.toolCallId !== event.toolCallId),
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            partialResult: null,
          },
        ],
        activity: { kind: "tool-running" as const, toolName: event.toolName },
        pendingTurn: true,
        error: null,
      };
    case "tool_execution_update":
      return {
        ...state,
        trace,
        runningTools: state.runningTools.map((tool) =>
          tool.toolCallId === event.toolCallId
            ? {
                ...tool,
                partialResult: event.partialResult,
              }
            : tool,
        ),
        activity: { kind: "tool-updating" as const, toolName: event.toolName },
        pendingTurn: true,
        error: null,
      };
    case "tool_execution_end":
      return {
        ...state,
        trace,
        streamedMessages: appendOrReplaceLiveMessage(
          state.streamedMessages,
          buildLiveToolResultMessage(event),
        ),
        runningTools: state.runningTools.filter((tool) => tool.toolCallId !== event.toolCallId),
        activity: { kind: "tool-finished" as const, toolName: event.toolName },
        pendingTurn: true,
        error: null,
      };
    case "agent_start":
      return {
        ...state,
        trace,
        activity: { kind: "agent-started" as const },
        pendingTurn: true,
        error: null,
      };
    case "agent_end":
      return {
        ...state,
        trace,
        activity: { kind: "agent-finished" as const },
        pendingTurn: true,
        error: null,
      };
    case "turn_start":
      return {
        ...state,
        trace,
        activity: { kind: "turn-started" as const },
        pendingTurn: true,
        error: null,
      };
    case "turn_end":
      return {
        ...state,
        trace,
        activity: { kind: "turn-finished" as const },
        pendingTurn: true,
        error: null,
      };
    default:
      return {
        ...state,
        trace,
        pendingTurn: true,
        error: null,
      };
  }
};

const reduceOverlayState = (state: OverlayState, action: OverlayAction): OverlayState => {
  switch (action.type) {
    case "snapshot-updated": {
      if (action.sessionId !== state.sessionId) {
        return createOverlayState(action.sessionId);
      }

      if (!state.pendingSnapshotReconcile) {
        return {
          ...state,
          optimisticMessages: [],
          sendError: null,
          error: null,
          readyForInputOverride: null,
        };
      }

      return {
        ...state,
        optimisticMessages: [],
        streamedMessages: [],
        draftAssistant: null,
        runningTools: [],
        trace: [],
        error: null,
        sendError: null,
        activity: { kind: "none" as const },
        pendingTurn: false,
        pendingSnapshotReconcile: false,
        readyForInputOverride: null,
      };
    }
    case "send-started":
      return {
        ...state,
        sending: true,
        sendError: null,
        optimisticMessages: [
          ...state.optimisticMessages,
          {
            clientId: action.clientId,
            message: buildOptimisticUserMessage(action.text),
          },
        ],
        activity: { kind: "sending-message" as const },
        pendingTurn: true,
        readyForInputOverride: false,
        error: null,
      };
    case "send-acknowledged":
      return {
        ...state,
        sending: false,
        sendError: null,
      };
    case "send-failed": {
      const optimisticMessages = state.optimisticMessages.filter(
        (message) => message.clientId !== action.clientId,
      );
      const keepPending = state.pendingSnapshotReconcile || hasActiveOverlay(state);
      return {
        ...state,
        sending: false,
        sendError: action.message,
        optimisticMessages,
        activity: keepPending ? state.activity : { kind: "none" as const },
        pendingTurn: keepPending,
        readyForInputOverride: keepPending ? state.readyForInputOverride : null,
      };
    }
    case "stream-connecting": {
      const connection: PiSessionConnectionState = action.reconnecting
        ? "reconnecting"
        : "connecting";
      return {
        ...state,
        connection,
        error: null,
      };
    }
    case "stream-open":
      return {
        ...state,
        connection: "listening" as const,
        error: null,
      };
    case "stream-message":
      return reduceProtocolMessage(state, action.message);
    case "stream-settled":
      return {
        ...state,
        connection: "reconnecting" as const,
      };
    case "stream-inactive":
      return {
        ...state,
        connection: "idle" as const,
        error: null,
      };
    case "stream-error":
      return {
        ...state,
        connection: "error" as const,
        error: action.message,
      };
    case "stream-idle":
      return {
        ...state,
        connection: "idle" as const,
        error: null,
        activity: state.pendingTurn ? state.activity : { kind: "none" as const },
      };
    default:
      return state;
  }
};

const readPiRouteError = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (!text) {
    return `Request failed (${response.status}).`;
  }

  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? text;
  } catch {
    return text;
  }
};

const consumeProtocolStream = async (
  body: ReadableStream<Uint8Array>,
  onMessage: (message: PiActiveSessionProtocolMessage) => void,
  signal: AbortSignal,
) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        onMessage(JSON.parse(trimmed) as PiActiveSessionProtocolMessage);
      }
    }

    const trailing = `${buffer}${decoder.decode()}`.trim();
    if (trailing) {
      onMessage(JSON.parse(trailing) as PiActiveSessionProtocolMessage);
    }
  } finally {
    reader.releaseLock();
  }
};

const waitWithAbort = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);

    function handleAbort() {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
      reject(new DOMException("Aborted", "AbortError"));
    }

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });

const isSessionReadyForInput = (phase: PiAgentLoopPhase, waitingFor: PiAgentLoopWaitingFor) =>
  phase === "waiting-for-user" && waitingFor?.type === "user_message";

const shouldKeepLiveConnection = (session: PiSessionDetail | null) => session?.phase !== "complete";

const withAcceptHeader = (defaultOptions: RequestInit | undefined) => {
  const headers = new Headers(defaultOptions?.headers);
  headers.set("accept", "application/x-ndjson");

  return {
    ...defaultOptions,
    headers,
  } satisfies RequestInit;
};

export function createPiSessionStore(
  deps: CreatePiSessionStoreDependencies,
  args: CreatePiSessionStoreArgs,
): PiSessionStoreController {
  const detailStore = deps.createDetailStore(args.sessionId);
  const snapshotStore = atom<PiSessionDetail | null>(args.initialData ?? null);
  const overlayStore = atom<OverlayState>(createOverlayState(args.sessionId));
  const lastSnapshotVersion = {
    current: args.initialData
      ? `${args.initialData.id}:${String(args.initialData.updatedAt)}`
      : null,
  };

  let destroyed = false;
  let mounted = false;
  let activeAbortController: AbortController | null = null;
  let activeLoopPromise: Promise<void> | null = null;
  let detailUnsubscribe: (() => void) | null = null;

  const logActive = (event: string, details?: Record<string, unknown>) => {
    deps.activeLogger?.(event, {
      sessionId: args.sessionId,
      ...details,
    });
  };

  const updateSnapshot = (session: PiSessionDetail | null | undefined) => {
    if (!session) {
      return;
    }

    snapshotStore.set(session);
    const nextVersion = `${session.id}:${String(session.updatedAt)}`;
    if (nextVersion !== lastSnapshotVersion.current) {
      logActive("snapshot:updated", {
        version: nextVersion,
        phase: session.phase,
        status: session.status,
        turn: session.turn,
      });
      lastSnapshotVersion.current = nextVersion;
      overlayStore.set(
        reduceOverlayState(overlayStore.get(), {
          type: "snapshot-updated",
          sessionId: session.id,
        }),
      );
    }
  };

  const refetch = () => {
    logActive("detail:refetch");
    detailStore.revalidate();
  };

  const stopActiveLoop = () => {
    if (activeAbortController || activeLoopPromise) {
      logActive("stream:stop");
    }
    activeAbortController?.abort();
    activeAbortController = null;
    activeLoopPromise = null;
  };

  const ensureActiveLoop = () => {
    if (destroyed || !mounted || activeLoopPromise || deps.enableActiveStream === false) {
      return;
    }

    const currentSession = snapshotStore.get();
    if (!shouldKeepLiveConnection(currentSession)) {
      logActive("stream:idle", {
        reason: "session-complete",
        phase: currentSession?.phase ?? null,
        status: currentSession?.status ?? null,
      });
      overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "stream-idle" }));
      return;
    }

    logActive("stream:start", {
      phase: currentSession?.phase ?? null,
      status: currentSession?.status ?? null,
      turn: currentSession?.turn ?? null,
    });

    const abortController = new AbortController();
    activeAbortController = abortController;
    activeLoopPromise = (async () => {
      let reconnecting = false;

      while (!abortController.signal.aborted && !destroyed) {
        const latestSession = snapshotStore.get();
        if (!shouldKeepLiveConnection(latestSession)) {
          overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "stream-idle" }));
          return;
        }

        const activeUrl = deps.buildActiveUrl(args.sessionId);
        logActive("stream:connecting", {
          reconnecting,
          url: activeUrl,
        });
        overlayStore.set(
          reduceOverlayState(overlayStore.get(), {
            type: "stream-connecting",
            reconnecting,
          }),
        );

        try {
          const response = await deps.fetcher(activeUrl, {
            ...withAcceptHeader(deps.defaultOptions),
            method: "GET",
            cache: "no-store",
            signal: abortController.signal,
          });

          logActive("stream:response", {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: activeUrl,
          });

          if (!response.ok) {
            throw new Error(await readPiRouteError(response));
          }

          if (!response.body) {
            throw new Error("The active session stream did not return a response body.");
          }

          logActive("stream:open", { url: activeUrl });
          overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "stream-open" }));

          let sawInactive = false;
          let sawSettled = false;
          await consumeProtocolStream(
            response.body,
            (message) => {
              logActive("stream:message", { message });
              overlayStore.set(
                reduceOverlayState(overlayStore.get(), { type: "stream-message", message }),
              );
              if (message.layer === "system" && message.type === "inactive") {
                sawInactive = true;
              }
              if (message.layer === "system" && message.type === "settled") {
                sawSettled = true;
              }
            },
            abortController.signal,
          );

          if (abortController.signal.aborted || destroyed) {
            return;
          }

          if (sawSettled || sawInactive) {
            logActive("stream:settled", {
              sawSettled,
              sawInactive,
            });
            overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "stream-settled" }));
            detailStore.revalidate();
          }

          if (sawInactive) {
            logActive("stream:inactive");
            overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "stream-inactive" }));
            return;
          }

          reconnecting = true;
          logActive("stream:retry", { delayMs: 250 });
          await waitWithAbort(250, abortController.signal);
        } catch (error) {
          if (abortController.signal.aborted || destroyed) {
            return;
          }

          const message =
            error instanceof Error ? error.message : "Failed to stream the active session.";
          logActive("stream:error", { message });
          overlayStore.set(
            reduceOverlayState(overlayStore.get(), { type: "stream-error", message }),
          );
          reconnecting = true;
          logActive("stream:retry", { delayMs: 1000 });
          await waitWithAbort(1000, abortController.signal).catch(() => undefined);
        }
      }
    })().finally(() => {
      logActive("stream:end");
      if (activeAbortController === abortController) {
        activeAbortController = null;
      }
      if (activeLoopPromise) {
        activeLoopPromise = null;
      }
    });
  };

  const store = computed(
    [detailStore, snapshotStore, overlayStore],
    (detailValue, session, overlay) => {
      const optimisticMessages = overlay.optimisticMessages.map((entry) => entry.message);
      const snapshotMessages = session?.messages ?? [];
      const messages = mergeMessages(
        snapshotMessages,
        optimisticMessages,
        overlay.streamedMessages,
        overlay.draftAssistant,
      );

      const statusText =
        activityLabel(overlay.activity) ?? connectionStatusText(overlay.connection);
      const readyForInput =
        session !== null &&
        (overlay.readyForInputOverride ??
          (isSessionReadyForInput(session.phase, session.waitingFor) && !overlay.pendingTurn));

      return {
        loading: detailValue.loading,
        session,
        messages,
        traceEvents: [...(session?.trace ?? []), ...overlay.trace],
        runningTools: overlay.runningTools,
        connection: overlay.connection,
        statusText,
        readyForInput,
        sending: overlay.sending,
        error: detailValue.error?.message ?? overlay.error,
        sendError: overlay.sendError,
      } satisfies PiSessionStoreState;
    },
  );

  onMount(store, () => {
    mounted = true;
    logActive("store:mount");
    updateSnapshot(detailStore.get().data);

    detailUnsubscribe = detailStore.listen((value) => {
      updateSnapshot(value.data);

      if (destroyed) {
        return;
      }

      if (!shouldKeepLiveConnection(snapshotStore.get())) {
        logActive("stream:idle", {
          reason: "detail-store-update",
        });
        stopActiveLoop();
        overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "stream-idle" }));
        return;
      }

      ensureActiveLoop();
    });

    ensureActiveLoop();

    return () => {
      logActive("store:unmount");
      mounted = false;
      stopActiveLoop();
      detailUnsubscribe?.();
      detailUnsubscribe = null;
    };
  });

  const sendMessage: PiSessionStoreController["sendMessage"] = (input) => {
    const text = input.text.trim();
    if (!text) {
      return false;
    }

    const current = store.get();
    if (current.sending || !current.readyForInput) {
      return false;
    }

    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logActive("send:start", { clientId, text });
    overlayStore.set(
      reduceOverlayState(overlayStore.get(), { type: "send-started", clientId, text }),
    );
    ensureActiveLoop();

    void deps
      .sendMessage({
        sessionId: args.sessionId,
        text,
        done: input.done,
        steeringMode: input.steeringMode,
      })
      .then(() => {
        logActive("send:acknowledged", { clientId });
        overlayStore.set(reduceOverlayState(overlayStore.get(), { type: "send-acknowledged" }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Failed to send message.";
        logActive("send:failed", { clientId, message });
        overlayStore.set(
          reduceOverlayState(overlayStore.get(), { type: "send-failed", clientId, message }),
        );
      });

    return true;
  };

  const deactivate = () => {
    logActive("store:dispose");
    mounted = false;
    stopActiveLoop();
    detailUnsubscribe?.();
    detailUnsubscribe = null;
  };

  const destroy = () => {
    if (destroyed) {
      return;
    }
    logActive("store:destroy");
    destroyed = true;
    deactivate();
  };

  return {
    store,
    sendMessage,
    refetch,
    deactivate,
    destroy,
  };
}
