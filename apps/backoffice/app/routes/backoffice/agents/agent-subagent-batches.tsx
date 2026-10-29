import type { PiPromptStatus } from "@fragno-dev/backoffice-api/v0/pi";
import {
  backofficeContextScopeSchema,
  backofficeContextScopesEqual,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { ChatEventDivider } from "@fragno-private/design-system/chat-divider";
import {
  ChatSubagentGroup,
  ChatSubagentsRunning,
  type ChatSubagentRun,
  type ChatSubagentRunStatus,
} from "@fragno-private/design-system/chat-subagent-group";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/pane-message";
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
import type { PiAgentNotification } from "@/fragno/pi/agent/pi-agent-contract";

import type { loader as subagentViewLoader } from "./agent-subagent-view";
import type { AgentSubagent, loader as subagentsLoader } from "./agent-subagents";
import { liveThoughtHeadline, plainText } from "./session-detail/agent-turn";
import {
  createAssistantUiMessages,
  isPiConversationRunning,
  piConversationDraftAgentMessage,
  piConversationMessages,
} from "./session-detail/assistant-runtime";
import { AssistantMessage } from "./session-detail/messages";

// Subagents show in the agent's thread. Those its own turn starts sit in that turn, under the tool
// call that asked for them; those anyone else asks for sit where they were asked, between turns.

/** How often the list is read again while a subagent waits or runs, and otherwise. */
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;
/** How often a running subagent's transcript is read again. */
const TRANSCRIPT_POLL_MS = 1_500;
/** The longest wait between reads of a transcript that keeps failing transiently. */
const TRANSCRIPT_RETRY_MAX_MS = 30_000;

/** Pi settles a subagent its agent's stop cut off as unanswered with this reason. */
const ABORTED_REASON = "aborted";

type AgentSubagents =
  | { status: "loading" }
  | { status: "ready"; subagents: AgentSubagent[] }
  | { status: "failed"; message: string };

function isActive({ status }: AgentSubagent) {
  return status.status === "queued" || status.status === "running";
}

/**
 * The agent's latest subagents, read again often while any waits or runs and seldom otherwise.
 * `revision` reads them at once when it changes, such as when the agent's conversation grows, since
 * its turns start subagents.
 */
function useAgentSubagents(agentPath: string, revision: number): AgentSubagents {
  const [state, setState] = useState<AgentSubagents>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function read() {
      let delay = IDLE_POLL_MS;
      try {
        const response = await fetch(`${agentPath}/subagents`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Listing subagents failed with status ${response.status}.`);
        }
        // This application-owned resource route returns its loader data unchanged.
        const { subagents } = (await response.json()) as Awaited<
          ReturnType<typeof subagentsLoader>
        >;
        // A read that finished as its agent changed would show and poll the previous agent.
        if (controller.signal.aborted) {
          return;
        }
        setState({ status: "ready", subagents });
        delay = subagents.some(isActive) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
      timer = window.setTimeout(() => void read(), delay);
    }
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentPath, revision]);
  return state;
}

type SubagentView =
  | { status: "loading" }
  | { status: "ready"; view: ConversationView | null }
  | { status: "failed"; message: string };

/** A read failed in a way reading again cannot fix, such as a refusal or a malformed answer. */
class PermanentReadError extends Error {}

/**
 * A subagent's conversation, read again while it runs, and while `startable` until it starts.
 * Failures the server or the network may recover from are read again with backoff, keeping what
 * was read; others end the reads.
 */
function useSubagentView(agentPath: string, requestId: string, startable: boolean): SubagentView {
  const [state, setState] = useState<SubagentView>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;
    async function read() {
      let view: ConversationView | null;
      try {
        const response = await fetch(`${agentPath}/subagents/${encodeURIComponent(requestId)}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status >= 400 && response.status < 500) {
          throw new PermanentReadError(
            `Reading the subagent failed with status ${response.status}.`,
          );
        }
        if (!response.ok) {
          throw new Error(`Reading the subagent failed with status ${response.status}.`);
        }
        // This application-owned resource route returns its loader data unchanged.
        const data = (await response.json().catch((cause: unknown) => {
          throw new PermanentReadError("The subagent's transcript could not be read.", { cause });
        })) as Awaited<ReturnType<typeof subagentViewLoader>>;
        view = data.view;
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        if (cause instanceof PermanentReadError) {
          setState({ status: "failed", message: cause.message });
          return;
        }
        failures += 1;
        timer = window.setTimeout(
          () => void read(),
          Math.min(TRANSCRIPT_POLL_MS * 2 ** failures, TRANSCRIPT_RETRY_MAX_MS),
        );
        return;
      }
      failures = 0;
      setState({ status: "ready", view });
      if (view === null ? startable : isPiConversationRunning(view)) {
        timer = window.setTimeout(() => void read(), TRANSCRIPT_POLL_MS);
      }
    }
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentPath, requestId, startable]);
  return state;
}

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

/**
 * What each running subagent does now, by request ID, read again while it runs. An agent runs a
 * few subagents at a time, so this reads a few transcripts.
 */
function useRunningHeadlines(agentPath: string, running: readonly string[]) {
  const [headlines, setHeadlines] = useState<ReadonlyMap<string, string>>(new Map());
  const key = running.join("\n");
  useEffect(() => {
    const requestIds = key === "" ? [] : key.split("\n");
    const controller = new AbortController();
    let timer: number | undefined;
    async function read() {
      const found = await Promise.all(
        requestIds.map(async (requestId) => {
          try {
            const response = await fetch(
              `${agentPath}/subagents/${encodeURIComponent(requestId)}`,
              { headers: { accept: "application/json" }, signal: controller.signal },
            );
            if (!response.ok) {
              return null;
            }
            const { view } = (await response.json()) as Awaited<
              ReturnType<typeof subagentViewLoader>
            >;
            return view === null ? null : ([requestId, subagentHeadline(view)] as const);
          } catch {
            // A headline is a hint; the row says it runs without one.
            return null;
          }
        }),
      );
      if (controller.signal.aborted) {
        return;
      }
      setHeadlines(new Map(found.filter((entry) => entry !== null)));
      timer = window.setTimeout(() => void read(), TRANSCRIPT_POLL_MS);
    }
    if (requestIds.length > 0) {
      void read();
    }
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentPath, key]);
  return headlines;
}

function epoch(iso: string | null) {
  return iso === null ? null : new Date(iso).getTime();
}

function runStatus(subagent: AgentSubagent, headline: string | null): ChatSubagentRunStatus {
  const status: PiPromptStatus = subagent.status;
  switch (status.status) {
    case "queued":
      return { kind: "queued" };
    case "running":
      return {
        kind: "running",
        headline: headline ?? "Working",
        startedAt: new Date(subagent.startedAt ?? subagent.askedAt),
      };
    case "completed": {
      const startedAt = epoch(subagent.startedAt);
      const answeredAt = epoch(subagent.answeredAt);
      return {
        kind: "completed",
        durationMs: startedAt === null || answeredAt === null ? null : answeredAt - startedAt,
        // The row shows the answer's start, which reads as text, not markup.
        answer: plainText(status.answer ?? ""),
      };
    }
    case "failed":
      return status.reason === ABORTED_REASON
        ? { kind: "stopped" }
        : { kind: "failed", reason: status.reason };
  }
  throw new Error("Unsupported subagent status.", { cause: status satisfies never });
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
 * Subagents one asker asks for between two turns are one batch.
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
  // Turns start with what the agent was given; a turn's own messages are the agent's.
  const turnStarts = messages.flatMap((message, index) =>
    message.role === "assistant" ? [] : [{ index, at: message.createdAt?.getTime() ?? 0 }],
  );
  const placed: { position: number; batch: SubagentBatch; askedAt: Date }[] = [];
  for (const { subagent, asker, askedAt } of asked) {
    const position = turnStarts.find(({ at }) => at > askedAt.getTime())?.index ?? messages.length;
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

/** What the agent's page reads of its subagents, for its controls. */
export type AgentSubagentsSummary = { running: boolean; waiting: boolean };

/**
 * Reads the agent's subagents for its thread, and summarizes them for the page's controls:
 * stopping and resuming the agent concern its subagents too.
 */
export function useAgentSubagentsState(agentPath: string, revision: number) {
  const subagents = useAgentSubagents(agentPath, revision);
  const listed = subagents.status === "ready" ? subagents.subagents : [];
  const summary: AgentSubagentsSummary = {
    running: listed.some(({ status }) => status.status === "running"),
    waiting: listed.some(({ status }) => status.status === "queued"),
  };
  return { agentPath, listed, summary };
}

export function AgentSubagentsProvider({
  agentName,
  agentPath,
  listed,
  outside,
  children,
}: {
  agentName: string;
  agentPath: string;
  listed: readonly AgentSubagent[];
  /** The batches `withSubagentBatches` placed in the thread. */
  outside: readonly SubagentBatch[];
  children: ReactNode;
}) {
  const running = useMemo(
    () =>
      listed.flatMap(({ requestId, status }) => (status.status === "running" ? [requestId] : [])),
    [listed],
  );
  const headlines = useRunningHeadlines(agentPath, running);
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
  }, [agentName, agentPath, byToolCall, outsideById, headlines, observe, cardElements, inView]);
  return <AgentSubagentsContext.Provider value={value}>{children}</AgentSubagentsContext.Provider>;
}

function useAgentSubagentsContext() {
  return useContext(AgentSubagentsContext);
}

/** One subagent's transcript, as its row opens it: its work and its answer, not its task again. */
function SubagentRowTranscript({
  agentPath,
  subagent,
}: {
  agentPath: string;
  subagent: AgentSubagent;
}) {
  // Until the list says how it ended, a subagent without a conversation may still start.
  const startable = isActive(subagent);
  const transcript = useSubagentView(agentPath, subagent.requestId, startable);
  if (transcript.status === "loading") {
    return <PaneSpinner label="Loading the subagent" />;
  }
  if (transcript.status === "failed") {
    return <PaneMessage tone="failed">{transcript.message}</PaneMessage>;
  }
  if (transcript.view === null) {
    return (
      <PaneMessage tone="muted">
        {startable ? "It starts once a slot is free." : "It ended before it started."}
      </PaneMessage>
    );
  }
  return <SubagentTranscript view={transcript.view} />;
}

function SubagentTranscript({ view }: { view: ConversationView }) {
  const running = isPiConversationRunning(view);
  const { messages, activeContextStartIndex } = useMemo(
    () => piConversationMessages(view.entries, null),
    [view.entries],
  );
  const draftAgentMessage = useMemo(() => piConversationDraftAgentMessage(view), [view]);
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
      transcript: <SubagentRowTranscript agentPath={context.agentPath} subagent={subagent} />,
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
