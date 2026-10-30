import type { PiManagerAgent, PiPromptReceipt } from "@fragno-dev/backoffice-api/v0/pi";
import { ChatComposerModel } from "@fragno-private/design-system/chat-composer";
import { ChatWorkspaceSplit } from "@fragno-private/design-system/chat-workspace-split";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/pane-message";
import { usePostHog } from "@posthog/react/slim";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalThreadQueueAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { FileScopeProvider } from "@/components/backoffice/file-scope";
import { estimatePiContextTokens } from "@/fragno/pi/agent/context-usage";
import type {
  PiAgentCompactionStatus,
  PiAvailableModel,
  PiThinkingLevel,
} from "@/fragno/pi/agent/pi-agent-contract";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import { agentAttachmentTarget, useAgentAttachments } from "./agent-attachments";
import type { action as compactionsAction } from "./agent-compactions";
import type { action as messagesAction } from "./agent-messages";
import {
  AgentModelMenu,
  agentModelChoiceFormFields,
  availableAgentModelChoice,
  defaultAgentModelChoice,
  type AgentModelChoice,
} from "./agent-model-menu";
import {
  AgentSubagentsProvider,
  useAgentSubagentsState,
  withSubagentBatches,
} from "./agent-subagent-batches";
import type { PiManagerEntryPage } from "./data";
import {
  createAssistantUiMessages,
  getAppendMessageText,
  isPiConversationRunning,
  piConversationDraftAgentMessage,
  piConversationMessages,
  piConversationQueue,
  type PiConversationMessage,
  type PiDraftAgentMessage,
  type PiUserMessageMetadata,
} from "./session-detail/assistant-runtime";
import { SessionDisplayOptions } from "./session-detail/display-options";
import { usePiPendingMessages } from "./session-detail/pending-messages";
import {
  usePiSessionViewSocket,
  type PiAgentQueueState,
} from "./session-detail/pi-session-view-socket";
import { createReson8DictationAdapter } from "./session-detail/reson8-dictation";
import { SessionThread, type ComposerAction } from "./session-detail/session-thread";
import { SessionWorkflowsProvider } from "./session-detail/session-workflow";
import {
  SessionWorkspaceNavigationProvider,
  type SessionWorkspaceNavigation,
} from "./session-detail/workspace-context";
import {
  toggleSessionWorkspaceItem,
  type SessionWorkspaceState,
  type SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";
import { SessionWorkspacePanel } from "./session-detail/workspace-panel";
import { projectSessionWorkspaceItems } from "./session-detail/workspace-projection";

const PI_ENTRY_HISTORY_PAGE_SIZE = 100;
const PI_COMPACTION_POLL_MS = 250;

export type PiAgentActionData =
  | { ok: true; intent: "start"; receipt: PiPromptReceipt }
  | { ok: true; intent: "stop" | "resume" | "reset" }
  | { ok: false; intent: "start" | "stop" | "resume" | "reset"; error: string };

/** What the conversation produced, opened beside it. */
export type AgentConversationWorkspace = {
  storageKey: string;
  state: SessionWorkspaceState;
  update: (update: SessionWorkspaceStateUpdate) => void;
};

type AgentConversationProps = {
  /** A provisioned agent. */
  agent: PiManagerAgent;
  /** The agent's detail route, which owns its actions and resource routes. */
  agentPath: string;
  availableModelOptions: PiAvailableModel[];
  dictationMountRoute: string | null;
  /** Renders the frame's header with the conversation's options, which are null until it loads. */
  header: (options: ReactNode | null) => ReactNode;
  /** Null where there is no room beside the conversation. */
  workspace: AgentConversationWorkspace | null;
  /** Where the conversation's workspace files, such as the files its messages carry, live. */
  resolvedScope: BackofficeResolvedScope;
};

function isPiConversationCompacting(view: ConversationView) {
  const live = view.docs["pi.live"] as { compactions?: readonly unknown[] } | undefined;
  return (live?.compactions?.length ?? 0) > 0;
}

function useSessionDisplayOptions() {
  const [displayOptions, setDisplayOptions] = useState({
    showToolCalls: true,
    showThinking: true,
    showUsage: false,
  });
  const updateDisplayOption = (key: keyof typeof displayOptions) => (value: boolean) => {
    setDisplayOptions((current) => ({ ...current, [key]: value }));
  };
  return { displayOptions, updateDisplayOption };
}

/** Where the active context begins, when a compaction or reset cut it off from earlier history. */
function piActiveContextStart(view: ConversationView): number | null {
  // Pi's view leads with its newest head marker, and only head markers carry `head`.
  return view.entries[0]?.head ?? null;
}

type PiEntryHistory = {
  before: number;
  /** Newest first. */
  entries: EntryRecord[];
  /** Null once the conversation's oldest entry arrived. */
  nextPage: { cursor: string | null } | null;
};

// One shared empty history, so memos that depend on it hold while there is none.
const NO_HISTORY_ENTRIES: readonly EntryRecord[] = [];

/** Earlier history is fetched only on request, a page at a time. */
function usePiEntryHistory({ before, pageUrl }: { before: number | null; pageUrl: string }) {
  const [loaded, setLoaded] = useState<PiEntryHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new compaction moves the active context; history loaded before it would leave a gap.
  const history = useMemo<PiEntryHistory | null>(
    () =>
      before === null
        ? null
        : loaded?.before === before
          ? loaded
          : { before, entries: [], nextPage: { cursor: null } },
    [before, loaded],
  );

  const loadMore = useCallback(async () => {
    if (!history?.nextPage || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        before: String(history.before),
        pageSize: String(PI_ENTRY_HISTORY_PAGE_SIZE),
      });
      if (history.nextPage.cursor) {
        query.set("cursor", history.nextPage.cursor);
      }
      const response = await fetch(`${pageUrl}?${query}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Pi history request failed with status ${response.status}.`);
      }
      // This application-owned resource route returns the manager's typed entry page unchanged.
      const page = (await response.json()) as PiManagerEntryPage;
      setLoaded({
        before: history.before,
        entries: [...history.entries, ...page.entries],
        nextPage: page.cursor === null ? null : { cursor: page.cursor },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [history, loading, pageUrl]);

  return {
    entries: history?.entries ?? NO_HISTORY_ENTRIES,
    hasMore: history?.nextPage != null,
    loading,
    error,
    loadMore,
  };
}

function transcriptWithInactiveHistory(
  entries: ConversationView["entries"],
  newestFirstHistory: readonly EntryRecord[],
) {
  // The active view leads with its compaction marker; the transcript shows it where it happened.
  return [...newestFirstHistory, ...entries].sort((a, b) => a.id - b.id);
}

async function waitForPiCompaction(url: string, signal: AbortSignal) {
  for (;;) {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal });
    if (!response.ok) {
      throw new Error(`Pi compaction status request failed with status ${response.status}.`);
    }
    // This application-owned resource route returns the manager's public compaction projection.
    const status = (await response.json()) as PiAgentCompactionStatus;
    if (status.status !== "running") {
      return status;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, PI_COMPACTION_POLL_MS);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Pi compaction polling was aborted."),
          );
        },
        { once: true },
      );
    });
  }
}

async function startPiCompaction(url: string, instructions: string, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ instructions }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Pi compaction request failed with status ${response.status}.`);
  }
  // This application-owned resource route returns its action data unchanged.
  const result = (await response.json()) as Awaited<ReturnType<typeof compactionsAction>>;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.taskId;
}

async function postPiAgentMessage(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) {
    throw new Error(`Pi message request failed with status ${response.status}.`);
  }
  // This application-owned resource route returns its action data unchanged.
  return await response.json<Awaited<ReturnType<typeof messagesAction>>>();
}

/** A compaction requested here; the view stream shows every running compaction, wherever started. */
type PiCompactionRequest =
  | { status: "idle" }
  | { status: "compacting" }
  | { status: "unchanged"; message: string }
  | { status: "failed"; message: string };

/** Requests a compaction and follows its task until it settles, from the event that asked for it. */
function usePiCompaction(agentPath: string, onCompleted: () => void) {
  const [request, setRequest] = useState<PiCompactionRequest>({ status: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const compact = useCallback(
    async (instructions: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setRequest({ status: "compacting" });
      try {
        const taskId = await startPiCompaction(
          `${agentPath}/compactions`,
          instructions,
          controller.signal,
        );
        const status = await waitForPiCompaction(
          `${agentPath}/compactions/${encodeURIComponent(String(taskId))}`,
          controller.signal,
        );
        if (status.status === "completed") {
          onCompleted();
          setRequest({ status: "idle" });
        } else if (status.status === "unchanged") {
          setRequest({
            status: "unchanged",
            message: status.message ?? "Pi context did not need compaction.",
          });
        } else {
          setRequest({ status: "failed", message: status.message ?? "Context compaction failed." });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setRequest({
            status: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    },
    [agentPath, onCompleted],
  );
  const dismiss = useCallback(() => {
    setRequest({ status: "idle" });
  }, []);
  return { request, compact, dismiss };
}

/** The conversation renders from the view socket; its first view is the whole conversation. */
export function AgentConversation(props: AgentConversationProps) {
  const stream = usePiSessionViewSocket(`${props.agentPath}/view-socket`);
  if (stream.status === "connecting") {
    return (
      <AgentConversationStatus header={props.header}>
        <PaneSpinner label="Loading conversation" />
      </AgentConversationStatus>
    );
  }
  if (stream.status === "failed") {
    return (
      <AgentConversationStatus header={props.header}>
        <PaneMessage tone="failed">{stream.message}</PaneMessage>
      </AgentConversationStatus>
    );
  }
  return <AgentConversationThread {...props} view={stream.view} queue={stream.queue} />;
}

function AgentConversationStatus({
  header,
  children,
}: {
  header: (options: ReactNode | null) => ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {header(null)}
      {children}
    </div>
  );
}

/** The model answering the conversation, and for built-in agents the reader's choice of the next. */
function useConversationModel({
  agent,
  view,
  availableModelOptions,
}: {
  agent: PiManagerAgent;
  view: ConversationView;
  availableModelOptions: PiAvailableModel[];
}) {
  // Null until the reader picks one; their messages then carry it.
  const [pickedModel, setPickedModel] = useState<AgentModelChoice | null>(null);
  // The definition can change models between turns; the conversation's stored agent is current.
  // Pi's agent document stores the conversation's model as a provider and model id.
  const conversationAgent = view.docs["pi.agent"] as
    | { model?: { provider: string; modelId: string }; thinkingLevel?: PiThinkingLevel }
    | undefined;
  const conversationModel = conversationAgent?.model;
  const sessionModel = availableModelOptions.find(
    (model) =>
      model.provider === conversationModel?.provider && model.modelId === conversationModel.modelId,
  );
  const modelLabel = sessionModel?.label ?? conversationModel?.modelId ?? null;
  // Built-in agents run the model their messages choose. The menu starts on the conversation's,
  // and on the default when that is no longer available, which the next message then switches to.
  const conversationChoice =
    conversationModel && conversationAgent?.thinkingLevel
      ? availableAgentModelChoice(
          { ...conversationModel, thinkingLevel: conversationAgent.thinkingLevel },
          availableModelOptions,
        )
      : null;
  const shown =
    agent.steward.kind === "backoffice"
      ? (pickedModel ?? conversationChoice ?? defaultAgentModelChoice(availableModelOptions))
      : null;
  return {
    /** What the next message sends; null keeps the conversation's model. */
    sent: pickedModel ?? (conversationChoice ? null : shown),
    control: shown ? (
      <AgentModelMenu
        choice={shown}
        availableModels={availableModelOptions}
        onChoose={setPickedModel}
      />
    ) : modelLabel === null ? null : (
      <ChatComposerModel>{modelLabel}</ChatComposerModel>
    ),
    contextWindow: (shown?.model ?? sessionModel)?.contextWindow ?? null,
  };
}

function AgentConversationThread({
  agent,
  agentPath,
  availableModelOptions,
  dictationMountRoute,
  header,
  workspace,
  resolvedScope,
  view,
  queue: agentQueue,
}: AgentConversationProps & { view: ConversationView; queue: PiAgentQueueState }) {
  const posthog = usePostHog();
  const fetcher = useFetcher<PiAgentActionData>();
  const [composerAction, setComposerAction] = useState<ComposerAction>("message");
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const clearCompactionInstructions = useCallback(() => {
    runtimeRef.current?.thread.composer.setText("");
    setComposerAction("message");
  }, []);
  const compaction = usePiCompaction(agentPath, clearCompactionInstructions);
  const requestingCompaction = compaction.request.status === "compacting";
  const { displayOptions, updateDisplayOption } = useSessionDisplayOptions();
  const activeContextStart = piActiveContextStart(view);
  const history = usePiEntryHistory({
    before: activeContextStart,
    pageUrl: `${agentPath}/entries`,
  });
  // Keyed on the entries, which a commit that changes only documents, such as each streamed
  // partial, leaves as they were; rebuilding the transcript costs the whole conversation.
  const transcript = useMemo(
    () => transcriptWithInactiveHistory(view.entries, history.entries),
    [history.entries, view.entries],
  );
  const running = isPiConversationRunning(view) || requestingCompaction;
  const compacting = isPiConversationCompacting(view) || requestingCompaction;
  const { messages, activeContextStartIndex } = useMemo(
    () => piConversationMessages(transcript, activeContextStart),
    [activeContextStart, transcript],
  );
  const draftAgentMessage = useMemo(() => piConversationDraftAgentMessage(view), [view]);
  const {
    messages: pendingMessages,
    add: addPendingMessage,
    withdraw: withdrawPendingMessage,
  } = usePiPendingMessages(view, agentQueue.items);
  // A message sent during a run waits in the queue; otherwise it starts a turn in the thread.
  const conversationQueue = useMemo(() => {
    const queue = piConversationQueue(view, agentQueue.items);
    if (!running) {
      return queue;
    }
    const labels = new Map(queue.labels);
    const sending = pendingMessages.map(({ requestId, text }) => {
      const id = `pending:${requestId}`;
      labels.set(id, "Sending");
      return { id, prompt: text };
    });
    return { items: [...queue.items, ...sending], labels };
  }, [view, agentQueue.items, running, pendingMessages]);
  const contextTokens = useMemo(() => estimatePiContextTokens(view.entries), [view.entries]);
  const statusText = compacting ? "Compacting…" : running ? "Working…" : null;
  const subagents = useAgentSubagentsState(agentPath, view.entries.length);
  const { assistantMessages, activeContextStartMessageId, subagentBatches } = useMemo(() => {
    const converted = createAssistantUiMessages({
      draftAgentMessage,
      messages,
      activeContextStartIndex,
      readyForInput: !running,
      statusText,
    });
    const placed = withSubagentBatches(converted.messages, subagents.listed);
    const sending = running
      ? []
      : pendingMessages.map(
          ({ requestId, text }): ThreadMessageLike => ({
            id: `pending-${requestId}`,
            role: "user",
            content: [{ type: "text", text }],
            metadata: {
              custom: { kind: "user", attachments: [] } satisfies PiUserMessageMetadata,
            },
          }),
        );
    return {
      assistantMessages: [...placed.messages, ...sending],
      activeContextStartMessageId: converted.activeContextStartMessageId,
      subagentBatches: placed.batches,
    };
  }, [
    activeContextStartIndex,
    draftAgentMessage,
    messages,
    running,
    statusText,
    subagents.listed,
    pendingMessages,
  ]);
  const attachments = useAgentAttachments(
    useMemo(
      () => agentAttachmentTarget(resolvedScope, agent.agentName, agent.permissions),
      [resolvedScope, agent.agentName, agent.permissions],
    ),
  );
  const takeAttachments = attachments?.take ?? null;
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;
  const model = useConversationModel({ agent, view, availableModelOptions });
  // The agent's route owns its actions, wherever its conversation is shown.
  const submitAction = useCallback(
    (data: Record<string, string>) => {
      void fetcher.submit(data, { method: "post", action: agentPath });
    },
    [fetcher, agentPath],
  );

  // A message shows at once, then waits for the files it carries to upload, and goes with those
  // that did.
  const send = useCallback(
    async (text: string) => {
      setAttachmentError(null);
      setMessageError(null);
      const requestId = crypto.randomUUID();
      if (text) {
        addPendingMessage(requestId, text);
      }
      const files = takeAttachments === null ? null : await takeAttachments();
      if (files !== null && files.failed.length > 0) {
        setAttachmentError(`Not attached, because the upload failed: ${files.failed.join(", ")}.`);
      }
      const locations = files?.locations ?? [];
      if (!text && locations.length === 0) {
        return;
      }
      if (posthog) {
        posthog.capture("agent_message_sent", {
          agent_name: agent.agentName,
          agent_running: running,
        });
      }
      setSendingMessage(true);
      const error = await postPiAgentMessage(`${agentPath}/messages`, {
        requestId,
        content: text,
        ...(locations.length === 0 ? {} : { attachments: JSON.stringify(locations) }),
        ...(model.sent ? agentModelChoiceFormFields(model.sent) : {}),
      }).then(
        (result) => (result.ok ? null : result.error),
        (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
      );
      setSendingMessage(false);
      setMessageError(error);
      if (error !== null) {
        withdrawPendingMessage(requestId);
        // The text returns to the composer unless the reader already started another message.
        const composer = runtimeRef.current?.thread.composer;
        if (composer?.getState().text === "") {
          composer.setText(text);
        }
      }
    },
    [
      takeAttachments,
      posthog,
      addPendingMessage,
      withdrawPendingMessage,
      agentPath,
      running,
      agent.agentName,
      model.sent,
    ],
  );
  const handleSend = useCallback(
    async (message: AppendMessage) => {
      await send(getAppendMessageText(message));
    },
    [send],
  );

  // The agent's queue and Pi's `pi.inbox` own what waits; this adapter keeps the composer usable
  // during a run.
  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: conversationQueue.items,
      enqueue: (message) => {
        void handleSend(message);
      },
      // The server decides whether a message steers or waits when it is submitted.
      steer: () => undefined,
      // The thread renders no remove control; queued items cannot be withdrawn yet.
      remove: () => undefined,
      // Aborting the agent withdraws queued input on the server.
      clear: () => undefined,
    }),
    [handleSend, conversationQueue.items],
  );

  const dictation = useMemo(
    () => (dictationMountRoute ? createReson8DictationAdapter(dictationMountRoute) : undefined),
    [dictationMountRoute],
  );
  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: (message) => message,
    isRunning: running,
    // A message waiting for its uploads would otherwise be overtaken by the next one. A stop or
    // reset in flight could withdraw or clear a message that reached the agent first.
    isSendDisabled: sendingMessage || attachments?.sending === true || fetcher.state !== "idle",
    onNew: handleSend,
    queue,
    adapters: { dictation },
  });

  useEffect(() => {
    runtimeRef.current = runtime;
    return () => {
      runtimeRef.current = null;
    };
  }, [runtime]);

  const handleCompact = useCallback(() => {
    // One compaction at a time: another would summarize the same history again.
    if (running || compacting) {
      return;
    }
    const instructions = runtimeRef.current?.thread.composer.getState().text.trim() ?? "";
    if (posthog) {
      posthog.capture("agent_compaction_requested", {
        agent_name: agent.agentName,
        has_instructions: Boolean(instructions),
      });
    }
    void compaction.compact(instructions);
  }, [posthog, compaction, running, compacting, agent.agentName]);

  const handleStop = useCallback(() => {
    submitAction({ intent: "stop" });
  }, [submitAction]);
  const handleResume = useCallback(() => {
    submitAction({ intent: "resume" });
  }, [submitAction]);
  const handleClear = useCallback(() => {
    if (running) {
      return;
    }
    compaction.dismiss();
    if (posthog) {
      posthog.capture("agent_context_reset_requested", { agent_name: agent.agentName });
    }
    submitAction({ intent: "reset" });
    setComposerAction("message");
  }, [posthog, submitAction, compaction, running, agent.agentName]);

  const conversation = (
    <AgentSubagentsProvider
      agentName={agent.agentName}
      agentPath={agentPath}
      listed={subagents.listed}
      outside={subagentBatches}
    >
      <SessionThread
        dictation={dictation !== undefined}
        attachments={
          attachments === null
            ? null
            : {
                items: attachments.items,
                add: attachments.add,
                sendFiles: () => void send(""),
                sending: attachments.sending,
              }
        }
        disabledReason={null}
        error={attachments?.refusal ?? attachmentError ?? messageError ?? actionError}
        queueLabels={conversationQueue.labels}
        // Stopping and resuming the agent concern its subagents too.
        paused={agentQueue.paused && (agentQueue.items.length > 0 || subagents.summary.waiting)}
        onResume={handleResume}
        model={model.control}
        needsNudge={false}
        onCompact={handleCompact}
        onClear={handleClear}
        onContinue={() => undefined}
        onStop={handleStop}
        readyForInput={!running}
        running={running}
        subagentsRunning={subagents.summary.running}
        showThinking={displayOptions.showThinking}
        showToolCalls={displayOptions.showToolCalls}
        showUsage={displayOptions.showUsage}
        statusText={statusText}
        composerAction={composerAction}
        compacting={compacting}
        compactionError={compaction.request.status === "failed" ? compaction.request.message : null}
        compactionNotice={
          compaction.request.status === "unchanged" ? compaction.request.message : null
        }
        contextUsage={{
          tokens: contextTokens,
          window: model.contextWindow,
        }}
        activeContextStartMessageId={activeContextStartMessageId}
        hasMoreHistory={history.hasMore}
        historyLoading={history.loading}
        historyError={history.error}
        onComposerActionChange={setComposerAction}
        onLoadMoreHistory={history.loadMore}
      />
    </AgentSubagentsProvider>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <FileScopeProvider scope={resolvedScope}>
        <SessionWorkflowsProvider>
          <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <h2 className="sr-only">{formatPiAgentName(agent.agentName)}</h2>
            {header(
              <SessionDisplayOptions
                exportHref={`${agentPath}.jsonl`}
                exportFilename={`pi-agent-${agent.agentName}.jsonl`}
                showToolCalls={displayOptions.showToolCalls}
                showThinking={displayOptions.showThinking}
                showUsage={displayOptions.showUsage}
                onShowToolCallsChange={updateDisplayOption("showToolCalls")}
                onShowThinkingChange={updateDisplayOption("showThinking")}
                onShowUsageChange={updateDisplayOption("showUsage")}
              />,
            )}
            {workspace ? (
              <AgentConversationWithWorkspace
                workspace={workspace}
                messages={messages}
                draftAgentMessage={draftAgentMessage}
                conversation={conversation}
              />
            ) : (
              conversation
            )}
          </div>
        </SessionWorkflowsProvider>
      </FileScopeProvider>
    </AssistantRuntimeProvider>
  );
}

function AgentConversationWithWorkspace({
  workspace,
  messages,
  draftAgentMessage,
  conversation,
}: {
  workspace: AgentConversationWorkspace;
  messages: readonly PiConversationMessage[];
  draftAgentMessage: PiDraftAgentMessage | null;
  conversation: ReactNode;
}) {
  const { state: workspaceState, update: updateWorkspaceState } = workspace;
  const workspaceItems = useMemo(
    () => projectSessionWorkspaceItems({ draftAgentMessage, messages }),
    [draftAgentMessage, messages],
  );
  const workspaceItemIds = useMemo(
    () => new Set(workspaceItems.map((item) => item.id)),
    [workspaceItems],
  );

  const toggleWorkspaceItem = useCallback(
    (itemId: string) => {
      if (!workspaceItemIds.has(itemId)) {
        return;
      }
      updateWorkspaceState((current) => toggleSessionWorkspaceItem(current, itemId));
    },
    [updateWorkspaceState, workspaceItemIds],
  );
  const closeWorkspace = useCallback(() => {
    updateWorkspaceState((current) => ({ ...current, open: false }));
  }, [updateWorkspaceState]);
  const workspaceNavigation = useMemo<SessionWorkspaceNavigation>(
    () => ({
      hasItem: (itemId) => workspaceItemIds.has(itemId),
      isItemSelected: (itemId) => workspaceState.open && workspaceState.selectedItemId === itemId,
      toggleItem: toggleWorkspaceItem,
    }),
    [toggleWorkspaceItem, workspaceItemIds, workspaceState.open, workspaceState.selectedItemId],
  );
  const selectedWorkspaceItem = workspaceItems.find(
    (item) => item.id === workspaceState.selectedItemId,
  );

  return (
    <SessionWorkspaceNavigationProvider value={workspaceNavigation}>
      <ChatWorkspaceSplit
        storageKey={workspace.storageKey}
        conversation={conversation}
        workspace={
          workspaceState.open && selectedWorkspaceItem ? (
            <SessionWorkspacePanel
              key={selectedWorkspaceItem.id}
              item={selectedWorkspaceItem}
              onClose={closeWorkspace}
            />
          ) : null
        }
      />
    </SessionWorkspaceNavigationProvider>
  );
}
