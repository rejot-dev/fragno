import type {
  PiOlderSubagents,
  PiSubagentAsker,
  PiSubagentSummary,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { PiAgentNotification } from "@fragno-dev/backoffice-api/v0/pi-conversation/notification-entry";
import {
  backofficeContextScopeSchema,
  backofficeContextScopesEqual,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { liveThoughtHeadline } from "@fragno-private/backoffice-chat/messages/agent-turn";
import { AssistantMessage } from "@fragno-private/backoffice-chat/messages/messages";
import type {
  PiAgentSubagentsState,
  PiAgentViewSocket,
  PiSubagentConversationState,
} from "@fragno-private/backoffice-conversation/live/view-socket";
import {
  createAssistantUiMessages,
  isPiConversationRunning,
  piConversationDraftAgentMessage,
  piConversationMessages,
} from "@fragno-private/backoffice-conversation/projection/assistant-runtime";
import { usePiTranscript } from "@fragno-private/backoffice-conversation/projection/transcript";
import { ChatEventDivider } from "@fragno-private/design-system/agents/chat-divider";
import {
  ChatSubagentGroup,
  ChatSubagentsRunning,
  type ChatSubagentRun,
  type ChatSubagentRunStatus,
} from "@fragno-private/design-system/agents/chat-subagent-group";
import { ChatHistoryControls } from "@fragno-private/design-system/agents/chat-thread";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ConversationView } from "@earendil-works/pi-durable";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { readPiAgentEvent } from "@/fragno/backoffice-capabilities/capabilities/pi";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import { useEntryPageReader } from "./agent-entry-pages";
import type { loader as subagentsLoader } from "./agent-subagents";

// Subagents show in the agent's thread. Those its own turn starts sit in that turn, under the tool
// call that asked for them; those anyone else asks for sit where they were asked, between turns.

/**
 * Who asked for a subagent, as the agent's page shows it: its agent's own turn, from a tool call it
 * shows the subagent under, or someone else, by name; null names no one, such as a person.
 */
type AgentSubagentAsker =
  | { kind: "turn"; toolCallId: string }
  | { kind: "other"; name: string | null };

/** One of the agent's subagents as its page shows it. */
type AgentSubagent = Omit<PiSubagentSummary, "askedBy"> & { askedBy: AgentSubagentAsker };

/** How far a subagent got: it waits, then runs, then ends, and never goes back. */
function progress({ state }: PiSubagentSummary) {
  return state.status === "waiting" ? 0 : state.status === "running" ? 1 : 2;
}

/**
 * The pages of older subagents the page read since its socket connected, from the socket's
 * `older` on, and which it would read next; null once none is left.
 */
type EarlierSubagents = {
  agentPath: string;
  from: PiOlderSubagents;
  subagents: readonly PiSubagentSummary[];
  older: PiOlderSubagents | null;
};

/** A page of older subagents that failed to load, and how to load it again. */
export type SubagentsFailure = { message: string; retry: () => Promise<void> };

/**
 * The agent's subagents since Pi ID `shownAfter`, where the thread's history starts, by request
 * ID: those its view socket sent, and older ones, read a page at a time as the reader loads
 * earlier history. A socket that connects again sends its own newest page, so reading starts over
 * from there, leaving no gap.
 */
function useKnownSubagents(
  agentPath: string,
  live: PiAgentSubagentsState,
  shownAfter: number,
): { byRequestId: ReadonlyMap<string, PiSubagentSummary>; failure: SubagentsFailure | null } {
  const [earlier, setEarlier] = useState<EarlierSubagents | null>(null);
  // The page whose read failed, until the reader retries it.
  const [failed, setFailed] = useState<PiOlderSubagents | null>(null);
  const from = live.older;
  const current = earlier?.agentPath === agentPath && earlier.from === from ? earlier : null;
  const next = current === null ? from : current.older;
  const reading = next !== null && next.through > shownAfter && failed !== next;
  useEffect(() => {
    const controller = new AbortController();
    async function read(page: PiOlderSubagents, start: PiOlderSubagents) {
      const query = new URLSearchParams({ cursor: page.cursor });
      const response = await fetch(`${agentPath}/subagents?${query}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Listing subagents failed with status ${response.status}.`);
      }
      // This application-owned resource route returns the manager's page unchanged.
      const read = await response.json<Awaited<ReturnType<typeof subagentsLoader>>>();
      setEarlier((known) => {
        const base =
          known?.agentPath === agentPath && known.from === start
            ? known
            : { agentPath, from: start, subagents: [], older: start };
        // Each page continues the one before it; another read already went on.
        if (base.older !== page) {
          return known;
        }
        return { ...base, subagents: [...base.subagents, ...read.subagents], older: read.older };
      });
    }
    if (reading && from !== null && next !== null) {
      read(next, from).catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          console.error("Reading the agent's earlier subagents failed.", cause);
          setFailed(next);
        }
      });
    }
    return () => {
      controller.abort();
    };
  }, [agentPath, from, next, reading]);
  const byRequestId = useMemo(() => {
    const known = new Map<string, PiSubagentSummary>();
    for (const subagent of [...(current?.subagents ?? []), ...live.byRequestId.values()]) {
      const before = known.get(subagent.requestId);
      if (before === undefined || progress(before) <= progress(subagent)) {
        known.set(subagent.requestId, subagent);
      }
    }
    return known;
  }, [current, live]);
  const failure = useMemo(
    () =>
      failed === null || failed !== next
        ? null
        : {
            message: "Some of the agent's earlier subagents could not be loaded.",
            retry: async () => {
              setFailed(null);
            },
          },
    [failed, next],
  );
  return { byRequestId, failure };
}

function shownAsker(asker: PiSubagentAsker) {
  switch (asker.kind) {
    case "turn":
      return asker;
    case "agent":
      return { kind: "other", name: formatPiAgentName(asker.agentName) } as const;
    case "app":
      return { kind: "other", name: asker.appSlug && capitalize(asker.appSlug) } as const;
    case "person":
      return { kind: "other", name: null } as const;
  }
  throw new Error("Unsupported subagent asker.", { cause: asker satisfies never });
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The agent's subagents for its thread, newest first: those that wait or run, and those that
 * started since Pi ID `shownAfter`, where the thread's history starts; and a page of them that
 * failed to load.
 */
function useAgentSubagents(
  agentPath: string,
  live: PiAgentSubagentsState,
  shownAfter: number,
): { listed: AgentSubagent[]; failure: SubagentsFailure | null } {
  const { byRequestId, failure } = useKnownSubagents(agentPath, live, shownAfter);
  const listed = useMemo(
    () =>
      [...byRequestId.values()]
        .map((subagent) => ({ ...subagent, askedBy: shownAsker(subagent.askedBy) }))
        .sort((left, right) => right.askedAt.localeCompare(left.askedAt)),
    [byRequestId],
  );
  return { listed, failure };
}

function isActive({ state }: AgentSubagent) {
  return state.status === "waiting" || state.status === "running";
}

/** Follows a subagent's conversation on the agent's socket while mounted. */
function useSubagentConversation(
  socket: SubagentSocket,
  requestId: string,
): PiSubagentConversationState {
  const { follow } = socket;
  useEffect(() => follow(requestId), [follow, requestId]);
  return socket.conversations.get(requestId) ?? { status: "connecting" };
}

/** The agent's socket, as the subagents its page shows follow it. */
type SubagentSocket = Pick<
  Extract<PiAgentViewSocket, { status: "ready" }>,
  "follow" | "conversations"
>;

/** What a running subagent does now, as a running turn's header would say it. */
function subagentHeadline(view: ConversationView): string {
  const draft = piConversationDraftAgentMessage(view);
  if (draft === null) {
    return "Working";
  }
  switch (draft.activity) {
    // A model that keeps its reasoning to itself starts for as long as it thinks.
    case "starting":
      return "Working";
    case "writing":
      return "Writing the answer";
    case "tool_calling":
    case "running_tools": {
      const tool = Object.values(draft.tools).at(-1);
      return tool === undefined
        ? "Working"
        : tool.name === "codemode"
          ? "Running code"
          : `Running ${tool.name}`;
    }
    case "thinking": {
      const content: readonly unknown[] = draft.assistant?.content ?? [];
      const thought = content
        .flatMap((block) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "thinking" &&
          "thinking" in block &&
          typeof block.thinking === "string"
            ? [block.thinking]
            : [],
        )
        .at(-1);
      return thought === undefined ? "Thinking" : liveThoughtHeadline(thought);
    }
  }
  throw new Error("Unsupported agent activity.", { cause: draft.activity satisfies never });
}

/** Follows a running subagent's conversation, telling `onHeadline` what it does now. */
function RunningSubagentHeadline({
  socket,
  requestId,
  onHeadline,
}: {
  socket: SubagentSocket;
  requestId: string;
  onHeadline: (requestId: string, headline: string | null) => void;
}) {
  const conversation = useSubagentConversation(socket, requestId);
  const headline = conversation.status === "ready" ? subagentHeadline(conversation.view) : null;
  useEffect(() => {
    onHeadline(requestId, headline);
  }, [onHeadline, requestId, headline]);
  useEffect(
    () => () => {
      onHeadline(requestId, null);
    },
    [onHeadline, requestId],
  );
  return null;
}

/**
 * What each running subagent does now, by request ID, from its conversation, and the components
 * that follow them. An agent runs a few subagents at a time, so this follows a few conversations.
 */
function useRunningHeadlines(socket: SubagentSocket, running: readonly string[]) {
  const [headlines, setHeadlines] = useState<ReadonlyMap<string, string>>(new Map());
  const report = useCallback((requestId: string, headline: string | null) => {
    setHeadlines((current) => {
      if ((current.get(requestId) ?? null) === headline) {
        return current;
      }
      const next = new Map(current);
      if (headline === null) {
        next.delete(requestId);
      } else {
        next.set(requestId, headline);
      }
      return next;
    });
  }, []);
  const followers = running.map((requestId) => (
    <RunningSubagentHeadline
      key={requestId}
      socket={socket}
      requestId={requestId}
      onHeadline={report}
    />
  ));
  return { headlines, followers };
}

function runStatus(subagent: AgentSubagent, headline: string | null): ChatSubagentRunStatus {
  const { state } = subagent;
  switch (state.status) {
    case "waiting":
      return { kind: "queued" };
    case "running":
      return {
        kind: "running",
        headline: headline ?? "Working",
        startedAt: new Date(state.startedAt),
      };
    case "answered":
      return {
        kind: "completed",
        durationMs: new Date(state.answeredAt).getTime() - new Date(state.startedAt).getTime(),
      };
    case "stopped":
      return { kind: "stopped" };
    case "failed":
    case "dropped":
      return { kind: "failed", reason: state.reason };
  }
  throw new Error("Unsupported subagent state.", { cause: state satisfies never });
}

/** Subagents asked for together, shown as one card: by a tool call, or by someone else at once. */
type SubagentBatch = {
  id: string;
  /** Who asked for them, as the card names them; null names no one. */
  asker: string | null;
  /** Oldest first. */
  subagents: AgentSubagent[];
};

/**
 * Places the batches anyone but the agent's own turns asked for among the thread's messages, each
 * as a system message before the first turn that starts after it was asked, so no turn is split.
 * Subagents one asker asks for between two turns are one batch. Those asked while the last turn
 * runs show before it until it ends: assistant-ui takes a running thread that ends in anything but
 * the agent's turn to await a reply, and adds an empty one of its own.
 */
export function withSubagentBatches(
  messages: readonly ThreadMessageLike[],
  subagents: readonly AgentSubagent[],
): { messages: ThreadMessageLike[]; batches: SubagentBatch[] } {
  const asked = subagents
    .flatMap((subagent) =>
      subagent.askedBy.kind === "other"
        ? [{ subagent, asker: subagent.askedBy.name, askedAt: new Date(subagent.askedAt) }]
        : [],
    )
    .sort((left, right) => left.askedAt.getTime() - right.askedAt.getTime());
  // A turn starts with what the agent was given, or, answering events it was given, with the
  // agent's own message, which holds them. A turn that has not started responding has no time
  // yet; it is the latest. Other messages without one, such as a reset, have no place in time.
  const turnStarts = messages.flatMap((message, index) => {
    if (message.role === "assistant" && messages[index - 1]?.role !== "assistant" && index > 0) {
      return [];
    }
    const at =
      message.createdAt?.getTime() ??
      (message.role === "assistant" ? Number.POSITIVE_INFINITY : null);
    return at === null ? [] : [{ index, at }];
  });
  // Where the batches go that no turn started after: the end, or the start of the running turn.
  const newest = messages.at(-1);
  let end = messages.length;
  if (newest?.role === "assistant" && newest.status?.type === "running") {
    end -= 1;
    if (end > 0 && messages[end - 1]?.role !== "assistant") {
      end -= 1;
    }
  }
  const placed: { position: number; batch: SubagentBatch; askedAt: Date }[] = [];
  for (const { subagent, asker, askedAt } of asked) {
    const position = turnStarts.find(({ at }) => at > askedAt.getTime())?.index ?? end;
    const last = placed.at(-1);
    if (last?.position === position && last.batch.asker === asker) {
      last.batch.subagents.push(subagent);
    } else {
      placed.push({
        position,
        askedAt,
        batch: { id: subagent.requestId, asker, subagents: [subagent] },
      });
    }
  }
  const result: ThreadMessageLike[] = [];
  messages.forEach((message, index) => {
    for (const { position, batch, askedAt } of placed) {
      if (position === index) {
        result.push(batchMessage(batch, askedAt));
      }
    }
    result.push(message);
  });
  for (const { position, batch, askedAt } of placed) {
    if (position === messages.length) {
      result.push(batchMessage(batch, askedAt));
    }
  }
  return { messages: result, batches: placed.map(({ batch }) => batch) };
}

/** A system message the thread shows a batch of subagents for. */
export type PiSubagentBatchMessageMetadata = { kind: "subagents"; batchId: string };

function batchMessage(batch: SubagentBatch, askedAt: Date): ThreadMessageLike {
  return {
    id: `pi-subagents-${batch.id}`,
    role: "system",
    content: [{ type: "text", text: batchLabel(batch) }],
    createdAt: askedAt,
    metadata: {
      custom: { kind: "subagents", batchId: batch.id } satisfies PiSubagentBatchMessageMetadata,
    },
  };
}

function batchLabel(batch: SubagentBatch) {
  const count = batch.subagents.length === 1 ? "a subagent" : `${batch.subagents.length} subagents`;
  return batch.asker === null ? `Asked for ${count}` : `${batch.asker} asked for ${count}`;
}

type AgentSubagentsContextValue = {
  agentName: string;
  agentPath: string;
  socket: SubagentSocket;
  /** The batches the agent's own turns asked for, by the tool call that did. */
  byToolCall: ReadonlyMap<string, SubagentBatch>;
  /** The batches anyone else asked for, by ID. */
  outside: ReadonlyMap<string, SubagentBatch>;
  headlines: ReadonlyMap<string, string>;
  /** Tracks whether a batch's card is in view, for the notice above the composer. */
  observe: (batchId: string, card: HTMLElement | null) => void;
  /** The cards of batches still at work, newest last, and which of them are in view. */
  cards: { active: readonly { batchId: string; card: HTMLElement }[]; inView: ReadonlySet<string> };
  activeStatuses: readonly ChatSubagentRunStatus[];
  /** One of the agent's subagents, and its batch's card while the thread shows it. */
  locate: (requestId: string) => { subagent: AgentSubagent; card: HTMLElement | null } | null;
};

const AgentSubagentsContext = createContext<AgentSubagentsContextValue | null>(null);

/**
 * What the agent's page reads of its subagents, for its controls: stopping the agent concerns its
 * subagents too. Its queue says whether any wait, for resuming it.
 */
export type AgentSubagentsSummary = { running: boolean };

/**
 * Reads the agent's subagents for its thread, from its view socket and as the thread's history
 * loads, from Pi ID `shownAfter` on, and summarizes them for the page's controls.
 */
export function useAgentSubagentsState(
  agentPath: string,
  socket: Extract<PiAgentViewSocket, { status: "ready" }>,
  shownAfter: number,
) {
  const { listed, failure } = useAgentSubagents(agentPath, socket.subagents, shownAfter);
  const summary: AgentSubagentsSummary = {
    running: listed.some(({ state }) => state.status === "running"),
  };
  return { socket, listed, summary, failure };
}

export function AgentSubagentsProvider({
  agentName,
  agentPath,
  socket,
  listed,
  outside,
  children,
}: {
  agentName: string;
  agentPath: string;
  socket: SubagentSocket;
  listed: readonly AgentSubagent[];
  /** The batches `withSubagentBatches` placed in the thread. */
  outside: readonly SubagentBatch[];
  children: ReactNode;
}) {
  const running = useMemo(
    () => listed.flatMap(({ requestId, state }) => (state.status === "running" ? [requestId] : [])),
    [listed],
  );
  const { headlines, followers } = useRunningHeadlines(socket, running);
  const byToolCall = useMemo(() => {
    const batches = new Map<string, SubagentBatch>();
    // The list is newest first; cards list their subagents oldest first.
    for (const subagent of [...listed].reverse()) {
      if (subagent.askedBy.kind !== "turn") {
        continue;
      }
      const { toolCallId } = subagent.askedBy;
      const batch = batches.get(toolCallId);
      if (batch) {
        batch.subagents.push(subagent);
      } else {
        batches.set(toolCallId, { id: toolCallId, asker: null, subagents: [subagent] });
      }
    }
    return batches;
  }, [listed]);
  const outsideById = useMemo(() => new Map(outside.map((batch) => [batch.id, batch])), [outside]);

  const [cardElements, setCardElements] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const [inView, setInView] = useState<ReadonlySet<string>>(new Set());
  const observe = useCallback((batchId: string, card: HTMLElement | null) => {
    setCardElements((current) => {
      if ((current.get(batchId) ?? null) === card) {
        return current;
      }
      const next = new Map(current);
      if (card === null) {
        next.delete(batchId);
      } else {
        next.set(batchId, card);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const ids = new Map([...cardElements].map(([batchId, card]) => [card, batchId]));
    const observer = new IntersectionObserver((entries) => {
      setInView((current) => {
        const next = new Set(current);
        for (const entry of entries) {
          const batchId = ids.get(entry.target as HTMLElement);
          if (batchId === undefined) {
            continue;
          }
          if (entry.isIntersecting) {
            next.add(batchId);
          } else {
            next.delete(batchId);
          }
        }
        return next;
      });
    });
    for (const card of cardElements.values()) {
      observer.observe(card);
    }
    return () => {
      observer.disconnect();
    };
  }, [cardElements]);

  const value = useMemo((): AgentSubagentsContextValue => {
    const batches = [...byToolCall.values(), ...outsideById.values()];
    const activeBatches = batches.filter((batch) => batch.subagents.some(isActive));
    const oldestFirst = [...activeBatches].sort(
      (left, right) =>
        new Date(left.subagents[0].askedAt).getTime() -
        new Date(right.subagents[0].askedAt).getTime(),
    );
    return {
      agentName,
      agentPath,
      socket,
      byToolCall,
      outside: outsideById,
      headlines,
      observe,
      cards: {
        active: oldestFirst.flatMap((batch) => {
          const card = cardElements.get(batch.id);
          return card ? [{ batchId: batch.id, card }] : [];
        }),
        inView,
      },
      activeStatuses: activeBatches.flatMap((batch) =>
        batch.subagents.map((subagent) =>
          runStatus(subagent, headlines.get(subagent.requestId) ?? null),
        ),
      ),
      locate: (requestId) => {
        for (const batch of batches) {
          const subagent = batch.subagents.find((listed) => listed.requestId === requestId);
          if (subagent) {
            return { subagent, card: cardElements.get(batch.id) ?? null };
          }
        }
        return null;
      },
    };
  }, [
    agentName,
    agentPath,
    socket,
    byToolCall,
    outsideById,
    headlines,
    observe,
    cardElements,
    inView,
  ]);
  return (
    <AgentSubagentsContext.Provider value={value}>
      {followers}
      {children}
    </AgentSubagentsContext.Provider>
  );
}

function useAgentSubagentsContext() {
  return useContext(AgentSubagentsContext);
}

/** One subagent's transcript, as its row opens it: its work and its answer, not its task again. */
function SubagentRowTranscript({
  agentPath,
  socket,
  subagent,
}: {
  agentPath: string;
  socket: SubagentSocket;
  subagent: AgentSubagent;
}) {
  if (subagent.state.status === "waiting") {
    return <PaneMessage tone="muted">It starts once a slot is free.</PaneMessage>;
  }
  if (subagent.state.status === "dropped") {
    return <PaneMessage tone="failed">It was dropped before it started.</PaneMessage>;
  }
  return <StartedSubagentTranscript agentPath={agentPath} socket={socket} subagent={subagent} />;
}

function StartedSubagentTranscript({
  agentPath,
  socket,
  subagent,
}: {
  agentPath: string;
  socket: SubagentSocket;
  subagent: AgentSubagent;
}) {
  const conversation = useSubagentConversation(socket, subagent.requestId);
  if (conversation.status === "failed") {
    return <PaneMessage tone="failed">{conversation.message}</PaneMessage>;
  }
  if (conversation.status === "connecting") {
    return <PaneSpinner label="Loading the subagent" />;
  }
  return (
    <SubagentTranscript
      path={`${agentPath}/subagents/${encodeURIComponent(subagent.requestId)}`}
      view={conversation.view}
    />
  );
}

function SubagentTranscript({ path, view }: { path: string; view: ConversationView }) {
  const running = isPiConversationRunning(view);
  const history = usePiTranscript(view, useEntryPageReader(`${path}/entries`));
  const { activeContextStart, transcript, hasMore, loading, error, loadMore } = history;
  // The row has no "load earlier", so it loads what the view's window leaves out: a subagent
  // answers one task, so its conversation stays short.
  useEffect(() => {
    if (hasMore && !loading && error === null) {
      void loadMore();
    }
  }, [hasMore, loading, error, loadMore]);
  const { messages, activeContextStartIndex } = useMemo(
    () => piConversationMessages(transcript, activeContextStart),
    [activeContextStart, transcript],
  );
  const draftAgentMessage = useMemo(() => piConversationDraftAgentMessage(view), [view]);
  const { retry } = history;
  const { messages: threadMessages } = useMemo(
    () =>
      createAssistantUiMessages({
        draftAgentMessage,
        messages,
        activeContextStartIndex,
        readyForInput: !running,
        statusText: running ? "Working…" : null,
      }),
    [activeContextStartIndex, draftAgentMessage, messages, running],
  );
  const runtime = useExternalStoreRuntime({
    messages: threadMessages,
    convertMessage: (message) => message,
    isRunning: running,
    // Nobody writes to a subagent; its task was its only prompt.
    onNew: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root asChild>
        <div className="space-y-3">
          {error === null ? null : (
            <ChatHistoryControls
              explanation={null}
              hasMore={false}
              loading={loading}
              error={error}
              onLoadMore={() => {}}
              onRetry={
                retry &&
                (() => {
                  void retry();
                })
              }
            />
          )}
          <ThreadPrimitive.Messages>
            {({ message }) =>
              // The row above shows the task.
              message.role === "assistant" ? (
                <AssistantMessage showThinking showToolCalls showUsage={false} />
              ) : null
            }
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function BatchCard({ batch, title }: { batch: SubagentBatch; title: string }) {
  const context = useAgentSubagentsContext();
  const observe = context?.observe;
  const ref = useCallback(
    (card: HTMLElement | null) => {
      observe?.(batch.id, card);
    },
    [observe, batch.id],
  );
  if (context === null) {
    return null;
  }
  const runs = batch.subagents.map(
    (subagent): ChatSubagentRun => ({
      id: subagent.requestId,
      task: subagent.task,
      status: runStatus(subagent, context.headlines.get(subagent.requestId) ?? null),
      transcript: (
        <SubagentRowTranscript
          agentPath={context.agentPath}
          socket={context.socket}
          subagent={subagent}
        />
      ),
    }),
  );
  return <ChatSubagentGroup ref={ref} title={title} subagents={runs} />;
}

/** The subagents a tool call of the agent's own turn asked for, under it; none for other calls. */
export function ToolCallSubagents({ toolCallId }: { toolCallId: string }) {
  const batch = useAgentSubagentsContext()?.byToolCall.get(toolCallId);
  return batch === undefined ? null : <BatchCard batch={batch} title="Subagents" />;
}

/** The thread's message for a batch anyone but the agent's own turns asked for. */
export function SubagentBatchMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const { batchId } = useAuiState(
    (state) => state.message.metadata.custom as PiSubagentBatchMessageMetadata,
  );
  const batch = useAgentSubagentsContext()?.outside.get(batchId);
  if (batch === undefined) {
    return null;
  }
  return (
    <MessagePrimitive.Root asChild>
      <div className="mb-9">
        <ChatEventDivider marker="notification" time={createdAt ?? null}>
          {batchLabel(batch)}
        </ChatEventDivider>
        <BatchCard batch={batch} title={batch.asker ?? "Subagents"} />
      </div>
    </MessagePrimitive.Root>
  );
}

/** How a subagent's turn ended, by the `pi` event that reports it. */
const REPORT_OUTCOMES = {
  answered: "finished",
  failed: "failed",
  "cut-off": "stopped",
  dropped: "dropped",
} as const;

/** One of the agent's subagents reporting how it ended, as the thread names it. */
export type SubagentReport = {
  task: string;
  outcome: (typeof REPORT_OUTCOMES)[keyof typeof REPORT_OUTCOMES];
  /** Brings the reader to its card; null while the thread does not show the card. */
  show: (() => void) | null;
};

/**
 * Which of the events report one of the agent's own subagents ending, such as a subagent asked to
 * report back when done; null for any other event. The agent's subagents are its scope's.
 */
export function useSubagentReports(
  notifications: readonly PiAgentNotification[],
): (SubagentReport | null)[] {
  const context = useAgentSubagentsContext();
  const { resolvedScope } = useCurrentBackofficeContext();
  const agentScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  return notifications.map(({ event }): SubagentReport | null => {
    const read = readPiAgentEvent(event);
    if (context === null || read === null || read.agentName !== context.agentName) {
      return null;
    }
    if (!Object.hasOwn(REPORT_OUTCOMES, read.kind) || !("requestId" in read)) {
      return null;
    }
    const scope = backofficeContextScopeSchema.safeParse(
      (event.subject as { scope?: unknown } | null)?.scope,
    );
    if (!scope.success || !backofficeContextScopesEqual(scope.data, agentScope)) {
      return null;
    }
    const located = context.locate(read.requestId);
    if (located === null) {
      return null;
    }
    const { card } = located;
    return {
      task: located.subagent.task,
      outcome: REPORT_OUTCOMES[read.kind as keyof typeof REPORT_OUTCOMES],
      show:
        card === null
          ? null
          : () => {
              card.scrollIntoView({ behavior: "smooth", block: "center" });
              card.focus({ preventScroll: true });
            },
    };
  });
}

/** Above the composer while subagents still at work are out of view: how many, and a way there. */
export function SubagentsAtWork() {
  const context = useAgentSubagentsContext();
  const newest = context?.cards.active.at(-1);
  if (context === null || newest === undefined || context.cards.inView.has(newest.batchId)) {
    return null;
  }
  return (
    <ChatSubagentsRunning
      statuses={context.activeStatuses}
      onShow={() => {
        newest.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        newest.card.focus({ preventScroll: true });
      }}
    />
  );
}
