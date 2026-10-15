import type { PiManagerAgent, PiPromptReceipt } from "@fragno-dev/backoffice-api/v0/pi";
import { usePostHog } from "@posthog/react/slim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useOutletContext, useSearchParams } from "react-router";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalThreadQueueAdapter,
} from "@assistant-ui/react";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { eq, inArray, useLiveQuery } from "@tanstack/react-db";

import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserCollections,
} from "@/fragno/automation/tanstack/browser-database";
import type { PiAgentCompactionStatus } from "@/fragno/pi/agent/pi-agent-contract";

import type { Route } from "./+types/agent-detail";
import { formatPiAgentName } from "./agent-name";
import { resolvePiAgentRouteScope } from "./agent-scope.server";
import { AgentStartComposer } from "./agent-start-composer";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";
import {
  abortPiManagerAgent,
  compactPiManagerAgent,
  fetchPiManagerAgentDetail,
  fetchPiManagerEntryPage,
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
import { usePiSessionViewStream } from "./session-detail/pi-session-view-stream";
import { SessionThread } from "./session-detail/session-thread";
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
import { SessionWorkspaceSplit } from "./session-detail/workspace-split";

const PI_ENTRY_HISTORY_PAGE_SIZE = 100;
const PI_COMPACTION_POLL_MS = 250;

type PiAgentActionData =
  | { ok: true; intent: "send"; receipt: PiPromptReceipt }
  | { ok: true; intent: "abort" }
  | { ok: true; intent: "compact"; taskId: number }
  | { ok: false; intent: "send" | "abort" | "compact"; error: string };

type SessionWorkflowCollectionsState = {
  collections: AutomationBrowserCollections | null;
  error: string | null;
};

export async function loader(args: Route.LoaderArgs) {
  const { request, params, context } = args;
  const scope = await resolvePiAgentRouteScope(request, context, params);
  const result = await fetchPiManagerAgentDetail(request, context, scope, params.agentName);
  if (!result.detail) {
    throw Response.json(result.agentError, { status: result.status ?? 500 });
  }
  const entryPage: PiManagerEntryPage = result.detail.view
    ? await fetchPiManagerEntryPage(request, context, scope, params.agentName, {
        pageSize: PI_ENTRY_HISTORY_PAGE_SIZE,
      })
    : { entries: [], cursor: null, hasNextPage: false };
  return { ...result.detail, entryPage };
}

export async function action(args: Route.ActionArgs): Promise<PiAgentActionData> {
  const { request, params, context } = args;
  const agentName = params.agentName;
  const scope = await resolvePiAgentRouteScope(request, context, params);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "abort") {
    const error = await abortPiManagerAgent(request, context, scope, agentName);
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
  if (intent !== "send") {
    return { ok: false, intent: "send", error: "Unsupported agent action." };
  }

  const content = formData.get("content");
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, intent, error: "Write a message before sending." };
  }

  const me = await requireBackofficeMe(request, context);
  // An idle agent starts a turn. A busy one takes your message at its next tool boundary when the
  // running turn is yours, and after it otherwise.
  const result = await submitPiManagerPrompt(request, context, scope, agentName, {
    requestId: crypto.randomUUID(),
    content: content.trim(),
    whenBusy: "steer",
    // Personal agents keep the organization that pays for their first turn.
    billingOrganizationId:
      scope.kind === "user" || scope.kind === "system"
        ? (me.activeOrganization?.organization.id ?? null)
        : null,
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

function usePiEntryHistory({
  initialPage,
  pageUrl,
}: {
  initialPage: PiManagerEntryPage;
  pageUrl: string;
}) {
  const [entries, setEntries] = useState(initialPage.entries);
  const [cursor, setCursor] = useState(initialPage.cursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        cursor,
        pageSize: String(PI_ENTRY_HISTORY_PAGE_SIZE),
      });
      const response = await fetch(`${pageUrl}?${query}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Pi history request failed with status ${response.status}.`);
      }
      // This application-owned resource route returns the manager's typed entry page unchanged.
      const page = (await response.json()) as PiManagerEntryPage;
      setEntries((current) => {
        const knownEntryIds = new Set(current.map((entry) => entry.id));
        return [...current, ...page.entries.filter((entry) => !knownEntryIds.has(entry.id))];
      });
      setCursor(page.cursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, pageUrl]);

  return { entries, hasMore: cursor !== null, loading, error, loadMore };
}

function conversationViewWithInactiveHistory(
  view: ConversationView,
  newestFirstHistory: readonly EntryRecord[],
) {
  const activeEntryIds = new Set(view.entries.map((entry) => entry.id));
  const inactiveEntries = newestFirstHistory.filter((entry) => !activeEntryIds.has(entry.id));
  return {
    view: { ...view, entries: [...inactiveEntries].reverse().concat(view.entries) },
    inactiveEntryCount: inactiveEntries.length,
  };
}

function useSessionWorkflowCollections(): SessionWorkflowCollectionsState {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  const source =
    automationCollectionSource.status === "ready" ? automationCollectionSource.source : null;
  const sourceKey = source ? describeAutomationCollectionSource(source).resourceKey : null;
  const [state, setState] = useState<SessionWorkflowCollectionsState>({
    collections: null,
    error:
      automationCollectionSource.status === "unavailable"
        ? automationCollectionSource.message
        : null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!source) {
      setState({
        collections: null,
        error:
          automationCollectionSource.status === "unavailable"
            ? automationCollectionSource.message
            : null,
      });
      return () => {
        cancelled = true;
      };
    }
    setState({ collections: null, error: null });
    void getAutomationBrowserDatabase(source).then(
      ({ collections }) => {
        if (!cancelled) {
          setState({ collections, error: null });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            collections: null,
            error: cause instanceof Error ? cause.message : "Workflow synchronization failed.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [automationCollectionSource, source, sourceKey]);

  return state;
}

function useStartedWorkflowRunIds(
  collections: AutomationBrowserCollections | null,
  sessionWorkflowRunIds: string[],
): ReadonlySet<string> {
  const query = useLiveQuery(
    (builder) => {
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
    [collections?.workflowInstances, collections?.workflowSteps, sessionWorkflowRunIds],
  );
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

export default function BackofficeOrganizationPiAgentDetail({ loaderData }: Route.ComponentProps) {
  const { agent, view, entryPage } = loaderData;
  const { agents, basePath, billingOrganization } = useOutletContext<PiAgentsOutletContext>();
  if (view === null) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AgentsHeader
          basePath={basePath}
          agents={agents}
          selectedAgentName={agent.agentName}
          options={null}
        />
        <AgentStartComposer
          agentName={agent.agentName}
          description={agent.description}
          billingOrganization={billingOrganization}
        />
      </div>
    );
  }
  // Agent-owned client state survives same-agent revalidation and resets on agent navigation.
  return (
    <BackofficeOrganizationPiAgent
      key={`${basePath}/${agent.agentName}`}
      agent={agent}
      view={view}
      entryPage={entryPage}
    />
  );
}

function BackofficeOrganizationPiAgent({
  agent,
  view,
  entryPage,
}: {
  agent: PiManagerAgent;
  view: ConversationView;
  entryPage: PiManagerEntryPage;
}) {
  const posthog = usePostHog();
  const {
    agents,
    availableModelOptions,
    basePath,
    resolvedScope,
    updateWorkspaceState,
    workspaceStates,
  } = useOutletContext<PiAgentsOutletContext>();
  const agentPath = `${basePath}/${encodeURIComponent(agent.agentName)}`;
  const fetcher = useFetcher<PiAgentActionData>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [composerAction, setComposerAction] = useState<"message" | "compact">("message");
  const [pendingCompactionTaskId, setPendingCompactionTaskId] = useState<number | null>(null);
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  const acceptedCompactionTaskIdRef = useRef<number | null>(null);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const { displayOptions, updateDisplayOption } = useSessionDisplayOptions();
  const streamedView = usePiSessionViewStream({
    initialView: view,
    streamUrl: `${agentPath}/view-stream`,
  });
  const history = usePiEntryHistory({
    initialPage: entryPage,
    pageUrl: `${agentPath}/entries`,
  });
  const transcript = useMemo(
    () => conversationViewWithInactiveHistory(streamedView, history.entries),
    [history.entries, streamedView],
  );
  const submittingCompaction =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "compact";
  const running =
    isPiConversationRunning(streamedView) ||
    submittingCompaction ||
    pendingCompactionTaskId !== null;
  const compacting =
    isPiConversationCompacting(streamedView) ||
    submittingCompaction ||
    pendingCompactionTaskId !== null;
  const messages = useMemo(() => piConversationMessages(transcript.view), [transcript.view]);
  const draftAgentMessage = useMemo(
    () => piConversationDraftAgentMessage(streamedView),
    [streamedView],
  );
  const conversationQueue = useMemo(() => piConversationQueue(streamedView), [streamedView]);
  const contextTokens = useMemo(() => estimatePiContextTokens(streamedView), [streamedView]);
  const statusText = compacting ? "Compacting…" : running ? "Working…" : null;
  const assistantMessages = useMemo(
    () =>
      createAssistantUiMessages({
        draftAgentMessage,
        messages,
        readyForInput: !running,
        statusText,
      }),
    [draftAgentMessage, messages, running, statusText],
  );
  const initialPromptError = searchParams.get("initialPromptError");
  const actionError = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const sendError =
    fetcher.data?.intent === "compact" ? initialPromptError : (actionError ?? initialPromptError);
  // The composer always asks to steer; Pi queues it instead behind someone else's running turn.
  const sentReceipt =
    fetcher.data?.ok && fetcher.data.intent === "send" ? fetcher.data.receipt : null;
  const sendNotice =
    sentReceipt?.whenBusy === "followUp" &&
    conversationQueue.modes.has(String(sentReceipt.submissionId))
      ? "Someone else's turn is running. Your message will run after it."
      : null;
  const submitting = fetcher.state !== "idle";

  const workflowCollections = useSessionWorkflowCollections();
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
      void fetcher.submit({ intent: "send", content: text }, { method: "post" });
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
    [posthog, fetcher, initialPromptError, running, agent.agentName, setSearchParams],
  );

  // Pi owns the queue in `pi.inbox`; this adapter keeps the composer usable during a run.
  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: conversationQueue.items,
      enqueue: (message) => {
        void handleSend(message);
      },
      // Pi decides each queued input's mode when it is admitted.
      steer: () => undefined,
      // The thread renders no remove control; Pi exposes no withdrawal route yet.
      remove: () => undefined,
      // Aborting the agent withdraws queued input on the server.
      clear: () => undefined,
    }),
    [handleSend, conversationQueue.items],
  );

  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: (message) => message,
    isRunning: running,
    isSendDisabled: submitting,
    onNew: handleSend,
    queue,
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
    void fetcher.submit({ intent: "abort" }, { method: "post" });
  }, [fetcher]);

  // The definition can change models between turns; the conversation's stored agent is current.
  // Pi's agent document stores the conversation's model choice as a provider and model id.
  const conversationModel = (
    streamedView.docs["pi.agent"] as { model?: { provider: string; modelId: string } } | undefined
  )?.model;
  const sessionModel = availableModelOptions.find(
    (model) =>
      model.provider === conversationModel?.provider && model.modelId === conversationModel.modelId,
  );
  const modelLabel = sessionModel?.label ?? conversationModel?.modelId ?? null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <h2 className="sr-only">{formatPiAgentName(agent.agentName)}</h2>
        <AgentsHeader
          basePath={basePath}
          agents={agents}
          selectedAgentName={agent.agentName}
          options={
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
          }
        />

        <SessionWorkspaceNavigationProvider value={workspaceNavigation}>
          <SessionWorkspaceSplit
            storageKey={`backoffice:pi-agent-workspace:${basePath}`}
            left={
              <SessionThread
                disabledReason={null}
                error={sendError}
                notice={sendNotice}
                queueModes={conversationQueue.modes}
                modelLabel={modelLabel}
                needsNudge={false}
                onCompact={handleCompact}
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
                  window: sessionModel?.contextWindow ?? null,
                }}
                inactiveHistoryCount={transcript.inactiveEntryCount}
                hasMoreHistory={history.hasMore}
                historyLoading={history.loading}
                historyError={history.error}
                onComposerActionChange={setComposerAction}
                onLoadMoreHistory={history.loadMore}
              />
            }
            right={
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
