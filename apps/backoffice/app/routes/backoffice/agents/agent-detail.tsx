import type { PiManagerAgent, PiPromptReceipt } from "@fragno-dev/backoffice-api/v0/pi";
import { ChatComposerModel } from "@fragno-private/design-system/chat-composer";
import { ChatWorkspaceSplit } from "@fragno-private/design-system/chat-workspace-split";
import { PaneMessage } from "@fragno-private/design-system/pane-message";
import { usePostHog } from "@posthog/react/slim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useFetcher,
  useOutletContext,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalThreadQueueAdapter,
} from "@assistant-ui/react";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { eq, inArray, useLiveQuery } from "@tanstack/react-db";

import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import type { AutomationBrowserCollections } from "@/fragno/automation/tanstack/browser-database";
import { useAutomationBrowserCollections } from "@/fragno/automation/tanstack/use-automation-browser-collections";
import type { PiAgentCompactionStatus, PiThinkingLevel } from "@/fragno/pi/agent/pi-agent-contract";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-detail";
import { isPiConversationSubmission } from "./agent-conversation-submission";
import {
  AgentModelMenu,
  agentModelChoiceFormFields,
  agentModelChoiceFromFormData,
  availableAgentModelChoice,
  defaultAgentModelChoice,
  type AgentModelChoice,
} from "./agent-model-menu";
import { AgentPermissions } from "./agent-permissions";
import { AgentStartComposer } from "./agent-start-composer";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";
import {
  fetchPiManagerAgent,
  resumePiManagerAgent,
  compactPiManagerAgent,
  resetPiManagerAgent,
  stopPiManagerAgent,
  submitPiManagerPrompt,
  type PiManagerEntryPage,
} from "./data";
import {
  createAssistantUiMessages,
  getAppendMessageText,
  piConversationDraftAgentMessage,
  piConversationMessages,
  piConversationQueue,
} from "./session-detail/assistant-runtime";
import { estimatePiContextTokens } from "./session-detail/context-usage";
import { SessionDisplayOptions } from "./session-detail/display-options";
import {
  usePiSessionViewStream,
  type PiAgentQueueState,
} from "./session-detail/pi-session-view-stream";
import { createReson8DictationAdapter } from "./session-detail/reson8-dictation";
import { SessionThread, type ComposerAction } from "./session-detail/session-thread";
import {
  SessionWorkspaceNavigationProvider,
  type SessionWorkspaceNavigation,
} from "./session-detail/workspace-context";
import {
  autoOpenNewWorkflowWorkspaceItem,
  createSessionWorkspaceState,
  toggleSessionWorkspaceItem,
} from "./session-detail/workspace-model";
import { SessionWorkspacePanel } from "./session-detail/workspace-panel";
import {
  getSessionWorkflowRunIds,
  projectSessionWorkspaceItems,
} from "./session-detail/workspace-projection";

const PI_ENTRY_HISTORY_PAGE_SIZE = 100;
const PI_COMPACTION_POLL_MS = 250;

type PiAgentActionData =
  | { ok: true; intent: "start" | "send"; receipt: PiPromptReceipt }
  | { ok: true; intent: "stop" | "resume" | "reset" }
  | { ok: true; intent: "compact"; taskId: number }
  | {
      ok: false;
      intent: "start" | "send" | "stop" | "resume" | "reset" | "compact";
      error: string;
    };

export async function action(args: Route.ActionArgs): Promise<PiAgentActionData> {
  const { request, params, context } = args;
  const agentName = params.agentName;
  const { scope } = requireRouteScope(context).execution;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "stop") {
    const error = await stopPiManagerAgent(request, context, scope, agentName);
    return error ? { ok: false, intent, error } : { ok: true, intent };
  }
  if (intent === "resume") {
    const error = await resumePiManagerAgent(request, context, scope, agentName);
    return error ? { ok: false, intent, error } : { ok: true, intent };
  }
  if (intent === "reset") {
    const error = await resetPiManagerAgent(request, context, scope, agentName);
    return error ? { ok: false, intent, error } : { ok: true, intent };
  }
  if (intent === "compact") {
    const rawInstructions = formData.get("instructions");
    const instructions =
      typeof rawInstructions === "string" && rawInstructions.trim() ? rawInstructions.trim() : null;
    const result = await compactPiManagerAgent(request, context, scope, agentName, instructions);
    return result.error || !result.taskId
      ? { ok: false, intent, error: result.error ?? "Failed to compact the conversation." }
      : { ok: true, intent, taskId: result.taskId };
  }
  // Starting is sending the first turn; the separate intent reloads the agent, which it provisions.
  if (intent !== "start" && intent !== "send") {
    return { ok: false, intent: "send", error: "Unsupported agent action." };
  }

  const content = formData.get("content");
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, intent, error: "Write a message before sending." };
  }

  // Your message joins your own running turn at its next tool boundary; otherwise it waits in the
  // agent's queue for a turn of its own. Sending to a stopped agent resumes its queue.
  const result = await submitPiManagerPrompt(request, context, scope, agentName, {
    requestId: crypto.randomUUID(),
    content: content.trim(),
    whenBusy: "steer",
    whenPaused: "resume",
    model: agentModelChoiceFromFormData(formData),
  });
  return result.error === null
    ? { ok: true, intent, receipt: result.receipt }
    : { ok: false, intent, error: result.error };
}

function isPiConversationRunning(view: ConversationView) {
  const live = view.docs["pi.live"];
  if (live && Object.keys(live).length > 0) {
    return true;
  }
  const inbox = view.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined;
  return (inbox?.items?.length ?? 0) > 0;
}

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
    entries: history?.entries ?? [],
    hasMore: history?.nextPage != null,
    loading,
    error,
    loadMore,
  };
}

function conversationViewWithInactiveHistory(
  view: ConversationView,
  newestFirstHistory: readonly EntryRecord[],
) {
  // The active view leads with its compaction marker; the transcript shows it where it happened.
  return {
    ...view,
    entries: [...newestFirstHistory, ...view.entries].sort((a, b) => a.id - b.id),
  };
}

function useStartedWorkflowRunIds(
  collections: AutomationBrowserCollections | null,
  sessionWorkflowRunIds: string[],
): ReadonlySet<string> {
  const query = useLiveQuery({
    query: (builder) => {
      if (!collections || sessionWorkflowRunIds.length === 0) {
        return undefined;
      }
      return builder
        .from({ step: collections.workflowSteps })
        .innerJoin({ instance: collections.workflowInstances }, ({ step, instance }) =>
          eq(step.instanceRef, instance.id),
        )
        .where(({ instance }) => eq(instance.workflowName, CODEMODE_WORKFLOW))
        .where(({ instance }) => inArray(instance.instanceId, sessionWorkflowRunIds))
        .select(({ instance }) => ({ instanceId: instance.instanceId }));
    },
  });
  return useMemo(
    () => new Set((query.data ?? []).map(({ instanceId }) => instanceId)),
    [query.data],
  );
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

export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgent(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
}

export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return isPiConversationSubmission(formData) ? false : defaultShouldRevalidate;
}

export default function BackofficeOrganizationPiAgentDetail({
  loaderData,
  params,
}: Route.ComponentProps) {
  const { directory, basePath, usageLabel } = useOutletContext<PiAgentsOutletContext>();
  if (!loaderData.found) {
    return (
      <AgentStatusPane selectedAgentName={params.agentName} tone="failed">
        {loaderData.message}
      </AgentStatusPane>
    );
  }
  const { agent } = loaderData;
  if (!agent.provisioned) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AgentsHeader
          basePath={basePath}
          directory={directory}
          selectedAgentName={agent.agentName}
          options={null}
        />
        <AgentStartComposer
          agentName={agent.agentName}
          builtIn={agent.managedBy?.kind === "built-in"}
          description={agent.description}
          permissions={agent.permissions}
          usageLabel={usageLabel}
        />
      </div>
    );
  }
  // Agent-owned client state survives same-agent revalidation and resets on agent navigation.
  return (
    <BackofficeOrganizationPiAgentStream key={`${basePath}/${agent.agentName}`} agent={agent} />
  );
}

function AgentStatusPane({
  selectedAgentName,
  tone,
  children,
}: {
  selectedAgentName: string;
  tone: "muted" | "failed";
  children: string;
}) {
  const { directory, basePath } = useOutletContext<PiAgentsOutletContext>();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <AgentsHeader
        basePath={basePath}
        directory={directory}
        selectedAgentName={selectedAgentName}
        options={null}
      />
      <PaneMessage tone={tone}>{children}</PaneMessage>
    </div>
  );
}

/** The conversation renders from the view stream; its first frame is the whole view. */
function BackofficeOrganizationPiAgentStream({ agent }: { agent: PiManagerAgent }) {
  const { basePath } = useOutletContext<PiAgentsOutletContext>();
  const stream = usePiSessionViewStream(
    `${basePath}/${encodeURIComponent(agent.agentName)}/view-stream`,
  );
  if (stream.status === "connecting") {
    return (
      <AgentStatusPane selectedAgentName={agent.agentName} tone="muted">
        Loading conversation…
      </AgentStatusPane>
    );
  }
  if (stream.status === "failed") {
    return (
      <AgentStatusPane selectedAgentName={agent.agentName} tone="failed">
        {stream.message}
      </AgentStatusPane>
    );
  }
  return <BackofficeOrganizationPiAgent agent={agent} view={stream.view} queue={stream.queue} />;
}

function BackofficeOrganizationPiAgent({
  agent,
  view,
  queue: agentQueue,
}: {
  agent: PiManagerAgent;
  view: ConversationView;
  queue: PiAgentQueueState;
}) {
  const posthog = usePostHog();
  const {
    directory,
    availableModelOptions,
    basePath,
    dictationMountRoute,
    resolvedScope,
    updateWorkspaceState,
    workspaceStates,
  } = useOutletContext<PiAgentsOutletContext>();
  const agentPath = `${basePath}/${encodeURIComponent(agent.agentName)}`;
  const fetcher = useFetcher<PiAgentActionData>();
  // Null until the reader picks one; their messages then carry it.
  const [pickedModel, setPickedModel] = useState<AgentModelChoice | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [composerAction, setComposerAction] = useState<ComposerAction>("message");
  const [pendingCompactionTaskId, setPendingCompactionTaskId] = useState<number | null>(null);
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  const acceptedCompactionTaskIdRef = useRef<number | null>(null);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const { displayOptions, updateDisplayOption } = useSessionDisplayOptions();
  const activeContextStart = piActiveContextStart(view);
  const history = usePiEntryHistory({
    before: activeContextStart,
    pageUrl: `${agentPath}/entries`,
  });
  const transcript = useMemo(
    () => conversationViewWithInactiveHistory(view, history.entries),
    [history.entries, view],
  );
  const submittingCompaction =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "compact";
  const running =
    isPiConversationRunning(view) || submittingCompaction || pendingCompactionTaskId !== null;
  const compacting =
    isPiConversationCompacting(view) || submittingCompaction || pendingCompactionTaskId !== null;
  const { messages, activeContextStartIndex } = useMemo(
    () => piConversationMessages(transcript, activeContextStart),
    [activeContextStart, transcript],
  );
  const draftAgentMessage = useMemo(() => piConversationDraftAgentMessage(view), [view]);
  const conversationQueue = useMemo(
    () => piConversationQueue(view, agentQueue.items),
    [view, agentQueue.items],
  );
  const contextTokens = useMemo(() => estimatePiContextTokens(view), [view]);
  const statusText = compacting ? "Compacting…" : running ? "Working…" : null;
  const { messages: assistantMessages, activeContextStartMessageId } = useMemo(
    () =>
      createAssistantUiMessages({
        draftAgentMessage,
        messages,
        activeContextStartIndex,
        readyForInput: !running,
        statusText,
      }),
    [activeContextStartIndex, draftAgentMessage, messages, running, statusText],
  );
  const initialPromptError = searchParams.get("initialPromptError");
  const actionError = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const sendError =
    fetcher.data?.intent === "compact" ? initialPromptError : (actionError ?? initialPromptError);
  const submitting = fetcher.state !== "idle";

  const workflowCollections = useAutomationBrowserCollections();
  const sessionWorkflowRunIds = useMemo(
    () => getSessionWorkflowRunIds({ draftAgentMessage, messages }),
    [draftAgentMessage, messages],
  );
  const startedWorkflowRunIds = useStartedWorkflowRunIds(
    workflowCollections.collections,
    sessionWorkflowRunIds,
  );
  const workspaceItems = useMemo(
    () =>
      projectSessionWorkspaceItems({
        draftAgentMessage,
        messages,
        startedWorkflowRunIds,
      }),
    [draftAgentMessage, messages, startedWorkflowRunIds],
  );
  const workspaceState = workspaceStates[agent.agentName] ?? createSessionWorkspaceState();
  const workspaceItemIds = useMemo(
    () => new Set(workspaceItems.map((item) => item.id)),
    [workspaceItems],
  );

  useEffect(() => {
    updateWorkspaceState(agent.agentName, (current) =>
      autoOpenNewWorkflowWorkspaceItem(current, workspaceItems),
    );
  }, [agent.agentName, updateWorkspaceState, workspaceItems]);

  const toggleWorkspaceItem = useCallback(
    (itemId: string) => {
      if (!workspaceItemIds.has(itemId)) {
        return;
      }
      updateWorkspaceState(agent.agentName, (current) =>
        toggleSessionWorkspaceItem(current, itemId),
      );
    },
    [agent.agentName, updateWorkspaceState, workspaceItemIds],
  );
  const closeWorkspace = useCallback(() => {
    updateWorkspaceState(agent.agentName, (current) => ({ ...current, open: false }));
  }, [agent.agentName, updateWorkspaceState]);
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
  const builtIn = agent.managedBy?.kind === "built-in";
  const shownModel = builtIn
    ? (pickedModel ?? conversationChoice ?? defaultAgentModelChoice(availableModelOptions))
    : null;
  const sentModel = pickedModel ?? (conversationChoice ? null : shownModel);

  const handleSend = useCallback(
    async (message: AppendMessage) => {
      const text = getAppendMessageText(message);
      if (!text) {
        return;
      }
      if (posthog) {
        posthog.capture("agent_message_sent", {
          agent_name: agent.agentName,
          agent_running: running,
        });
      }
      void fetcher.submit(
        {
          intent: "send",
          content: text,
          ...(sentModel ? agentModelChoiceFormFields(sentModel) : {}),
        },
        { method: "post" },
      );
      if (initialPromptError) {
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete("initialPromptError");
            return next;
          },
          { replace: true },
        );
      }
    },
    [posthog, fetcher, initialPromptError, running, agent.agentName, setSearchParams, sentModel],
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
    isSendDisabled: submitting,
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

  useEffect(() => {
    if (
      !fetcher.data?.ok ||
      fetcher.data.intent !== "compact" ||
      acceptedCompactionTaskIdRef.current === fetcher.data.taskId
    ) {
      return;
    }
    acceptedCompactionTaskIdRef.current = fetcher.data.taskId;
    setPendingCompactionTaskId(fetcher.data.taskId);
    setCompactionError(null);
    setCompactionNotice(null);
  }, [fetcher.data]);

  useEffect(() => {
    if (!pendingCompactionTaskId) {
      return undefined;
    }
    const controller = new AbortController();
    const statusUrl = `${agentPath}/compactions/${encodeURIComponent(String(pendingCompactionTaskId))}`;
    async function observePiCompactionCompletion() {
      try {
        const status = await waitForPiCompaction(statusUrl, controller.signal);
        if (status.status === "completed") {
          runtimeRef.current?.thread.composer.setText("");
          setComposerAction("message");
          setCompactionError(null);
          setCompactionNotice(null);
        } else if (status.status === "unchanged") {
          setCompactionError(null);
          setCompactionNotice(status.message ?? "Pi context did not need compaction.");
        } else {
          setCompactionError(status.message ?? "Context compaction failed.");
          setCompactionNotice(null);
        }
        setPendingCompactionTaskId(null);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setCompactionError(cause instanceof Error ? cause.message : String(cause));
          setCompactionNotice(null);
          setPendingCompactionTaskId(null);
        }
      }
    }

    void observePiCompactionCompletion();
    return () => {
      controller.abort();
    };
  }, [agentPath, pendingCompactionTaskId]);

  const handleCompact = useCallback(() => {
    if (running) {
      return;
    }
    const instructions = runtimeRef.current?.thread.composer.getState().text.trim() ?? "";
    setCompactionError(null);
    setCompactionNotice(null);
    if (posthog) {
      posthog.capture("agent_compaction_requested", {
        agent_name: agent.agentName,
        has_instructions: Boolean(instructions),
      });
    }
    void fetcher.submit({ intent: "compact", instructions }, { method: "post" });
  }, [posthog, fetcher, running, agent.agentName]);

  const handleStop = useCallback(() => {
    void fetcher.submit({ intent: "stop" }, { method: "post" });
  }, [fetcher]);
  const handleResume = useCallback(() => {
    void fetcher.submit({ intent: "resume" }, { method: "post" });
  }, [fetcher]);
  const handleClear = useCallback(() => {
    if (running) {
      return;
    }
    setCompactionError(null);
    setCompactionNotice(null);
    if (posthog) {
      posthog.capture("agent_context_reset_requested", { agent_name: agent.agentName });
    }
    void fetcher.submit({ intent: "reset" }, { method: "post" });
    setComposerAction("message");
  }, [posthog, fetcher, running, agent.agentName]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <h2 className="sr-only">{formatPiAgentName(agent.agentName)}</h2>
        <AgentsHeader
          basePath={basePath}
          directory={directory}
          selectedAgentName={agent.agentName}
          options={
            <>
              <AgentPermissions
                permissions={agent.permissions}
                className="hidden max-w-72 truncate text-sm sm:block"
              />
              <SessionDisplayOptions
                exportHref={`${agentPath}.jsonl`}
                exportFilename={`pi-agent-${agent.agentName}.jsonl`}
                showToolCalls={displayOptions.showToolCalls}
                showThinking={displayOptions.showThinking}
                showUsage={displayOptions.showUsage}
                onShowToolCallsChange={updateDisplayOption("showToolCalls")}
                onShowThinkingChange={updateDisplayOption("showThinking")}
                onShowUsageChange={updateDisplayOption("showUsage")}
              />
            </>
          }
        />

        <SessionWorkspaceNavigationProvider value={workspaceNavigation}>
          <ChatWorkspaceSplit
            storageKey={`backoffice:pi-agent-workspace:${basePath}`}
            conversation={
              <SessionThread
                dictation={dictation !== undefined}
                disabledReason={null}
                error={sendError}
                queueLabels={conversationQueue.labels}
                paused={agentQueue.paused && agentQueue.items.length > 0}
                onResume={handleResume}
                model={
                  shownModel ? (
                    <AgentModelMenu
                      choice={shownModel}
                      availableModels={availableModelOptions}
                      onChoose={setPickedModel}
                    />
                  ) : modelLabel === null ? null : (
                    <ChatComposerModel>{modelLabel}</ChatComposerModel>
                  )
                }
                needsNudge={false}
                onCompact={handleCompact}
                onClear={handleClear}
                onContinue={() => undefined}
                onStop={handleStop}
                readyForInput={!running}
                running={running}
                showThinking={displayOptions.showThinking}
                showToolCalls={displayOptions.showToolCalls}
                showUsage={displayOptions.showUsage}
                statusText={statusText}
                composerAction={composerAction}
                compacting={compacting}
                compactionError={
                  fetcher.data?.intent === "compact" && !fetcher.data.ok
                    ? fetcher.data.error
                    : compactionError
                }
                compactionNotice={compactionNotice}
                contextUsage={{
                  tokens: contextTokens,
                  window: (shownModel?.model ?? sessionModel)?.contextWindow ?? null,
                }}
                activeContextStartMessageId={activeContextStartMessageId}
                hasMoreHistory={history.hasMore}
                historyLoading={history.loading}
                historyError={history.error}
                onComposerActionChange={setComposerAction}
                onLoadMoreHistory={history.loadMore}
              />
            }
            workspace={
              workspaceState.open && selectedWorkspaceItem ? (
                <SessionWorkspacePanel
                  key={selectedWorkspaceItem.id}
                  item={selectedWorkspaceItem}
                  workflowCollections={workflowCollections.collections ?? undefined}
                  workflowCollectionsError={workflowCollections.error}
                  resolvedScope={resolvedScope}
                  onClose={closeWorkspace}
                />
              ) : null
            }
          />
        </SessionWorkspaceNavigationProvider>
      </div>
    </AssistantRuntimeProvider>
  );
}
