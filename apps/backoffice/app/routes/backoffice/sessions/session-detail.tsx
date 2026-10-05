import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useOutletContext, useSearchParams } from "react-router";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { eq, inArray, useLiveQuery } from "@tanstack/react-db";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserCollections,
} from "@/fragno/automation/tanstack/browser-database";
import type { PiAgentCompactionStatus } from "@/fragno/pi-manager/pi-agent-contract";

import type { Route } from "./+types/session-detail";
import {
  abortPiManagerSession,
  compactPiManagerSession,
  fetchPiManagerEntryPage,
  fetchPiManagerSessionDetail,
  submitPiManagerPrompt,
  type PiManagerEntryPage,
} from "./data";
import {
  createAssistantUiMessages,
  getAppendMessageText,
  piConversationDraftAgentMessage,
  piConversationMessages,
} from "./session-detail/assistant-runtime";
import { SessionDisplayOptions } from "./session-detail/display-options";
import { usePiSessionViewStream } from "./session-detail/pi-session-view-stream";
import { SessionHeader } from "./session-detail/session-header";
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
import { resolvePiSessionRouteScope } from "./session-scope.server";
import type { PiSessionsOutletContext } from "./session-types";

const PI_ENTRY_HISTORY_PAGE_SIZE = 100;
const PI_COMPACTION_POLL_MS = 250;

type PiSessionActionData =
  | { ok: true; intent: "send"; requestId: string }
  | { ok: true; intent: "abort" }
  | { ok: true; intent: "compact"; taskId: number }
  | { ok: false; intent: "send" | "abort" | "compact"; error: string };

type SessionWorkflowCollectionsState = {
  collections: AutomationBrowserCollections | null;
  error: string | null;
};

export async function loader(args: Route.LoaderArgs) {
  const { request, params, context } = args;
  const sessionId = params.sessionId;
  if (!sessionId) {
    throw new Response("Not Found", { status: 404 });
  }
  const scope = await resolvePiSessionRouteScope(request, context, params);
  const [result, entryPage] = await Promise.all([
    fetchPiManagerSessionDetail(request, context, scope, sessionId),
    fetchPiManagerEntryPage(request, context, scope, sessionId, {
      pageSize: PI_ENTRY_HISTORY_PAGE_SIZE,
    }),
  ]);
  if (!result.detail) {
    throw Response.json(result.sessionError, { status: result.status ?? 500 });
  }
  return { ...result.detail, entryPage };
}

export async function action(args: Route.ActionArgs): Promise<PiSessionActionData> {
  const { request, params, context } = args;
  const sessionId = params.sessionId;
  if (!sessionId) {
    throw new Response("Not Found", { status: 404 });
  }
  const scope = await resolvePiSessionRouteScope(request, context, params);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "abort") {
    const error = await abortPiManagerSession(request, context, scope, sessionId);
    return error ? { ok: false, intent, error } : { ok: true, intent };
  }
  if (intent === "compact") {
    const rawInstructions = formData.get("instructions");
    const instructions =
      typeof rawInstructions === "string" && rawInstructions.trim() ? rawInstructions.trim() : null;
    const result = await compactPiManagerSession(request, context, scope, sessionId, instructions);
    return result.error || !result.taskId
      ? { ok: false, intent, error: result.error ?? "Failed to compact session." }
      : { ok: true, intent, taskId: result.taskId };
  }
  if (intent !== "send") {
    return { ok: false, intent: "send", error: "Unsupported Pi session action." };
  }

  const content = formData.get("content");
  const whenBusy = formData.get("whenBusy");
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, intent, error: "Write a message before sending." };
  }
  if (whenBusy !== "followUp" && whenBusy !== "steer" && whenBusy !== "reject") {
    return { ok: false, intent, error: "Message mode is invalid." };
  }

  const result = await submitPiManagerPrompt(request, context, scope, sessionId, {
    requestId: crypto.randomUUID(),
    content: content.trim(),
    whenBusy,
  });
  return result.error || !result.requestId
    ? { ok: false, intent, error: result.error ?? "Failed to send message." }
    : { ok: true, intent, requestId: result.requestId };
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

export default function BackofficeOrganizationPiSessionDetail(props: Route.ComponentProps) {
  const session = props.loaderData.session;
  const sessionStateKey = `${backofficeContextScopeRoutePath(session.scope)}/${encodeURIComponent(session.sessionId)}`;
  // Session-owned client state survives same-session revalidation and resets on session navigation.
  return <BackofficeOrganizationPiSession key={sessionStateKey} {...props} />;
}

function BackofficeOrganizationPiSession({ loaderData }: Route.ComponentProps) {
  const { session, view, entryPage } = loaderData;
  const {
    availableModelOptions,
    basePath,
    resolvedScope,
    startNewSession,
    updateWorkspaceState,
    workspaceStates,
  } = useOutletContext<PiSessionsOutletContext>();
  const fetcher = useFetcher<PiSessionActionData>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [commandKind, setCommandKind] = useState<"followUp" | "steer">("followUp");
  const [composerAction, setComposerAction] = useState<"message" | "compact">("message");
  const [pendingCompactionTaskId, setPendingCompactionTaskId] = useState<number | null>(null);
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  const acceptedCompactionTaskIdRef = useRef<number | null>(null);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const { displayOptions, updateDisplayOption } = useSessionDisplayOptions();
  const streamedView = usePiSessionViewStream({
    initialView: view,
    streamUrl: `${basePath}/${encodeURIComponent(session.sessionId)}/view-stream`,
  });
  const history = usePiEntryHistory({
    initialPage: entryPage,
    pageUrl: `${basePath}/${encodeURIComponent(session.sessionId)}/entries`,
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
  const workspaceState = workspaceStates[session.sessionId] ?? createSessionWorkspaceState();
  const workspaceItemIds = useMemo(
    () => new Set(workspaceItems.map((item) => item.id)),
    [workspaceItems],
  );

  useEffect(() => {
    updateWorkspaceState(session.sessionId, (current) =>
      autoOpenNewWorkflowWorkspaceItem(current, workspaceItems),
    );
  }, [session.sessionId, updateWorkspaceState, workspaceItems]);

  const toggleWorkspaceItem = useCallback(
    (itemId: string) => {
      if (!workspaceItemIds.has(itemId)) {
        return;
      }
      updateWorkspaceState(session.sessionId, (current) =>
        toggleSessionWorkspaceItem(current, itemId),
      );
    },
    [session.sessionId, updateWorkspaceState, workspaceItemIds],
  );
  const closeWorkspace = useCallback(() => {
    updateWorkspaceState(session.sessionId, (current) => ({ ...current, open: false }));
  }, [session.sessionId, updateWorkspaceState]);
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
      void fetcher.submit(
        { intent: "send", content: text, whenBusy: running ? commandKind : "reject" },
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
    [commandKind, fetcher, initialPromptError, running, setSearchParams],
  );

  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: (message) => message,
    isRunning: running,
    isSendDisabled: submitting,
    onNew: handleSend,
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
    const statusUrl = `${basePath}/${encodeURIComponent(session.sessionId)}/compactions/${encodeURIComponent(String(pendingCompactionTaskId))}`;
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
  }, [basePath, pendingCompactionTaskId, session.sessionId]);

  const handleCompact = useCallback(() => {
    if (running) {
      return;
    }
    const instructions = runtimeRef.current?.thread.composer.getState().text.trim() ?? "";
    setCompactionError(null);
    setCompactionNotice(null);
    void fetcher.submit({ intent: "compact", instructions }, { method: "post" });
  }, [fetcher, running]);

  const handleStop = useCallback(() => {
    void fetcher.submit({ intent: "abort" }, { method: "post" });
  }, [fetcher]);

  const modelLabel =
    availableModelOptions.find(
      (model) =>
        model.provider === session.model.provider && model.modelId === session.model.modelId,
    )?.label ?? session.model.modelId;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <SessionHeader
          newSessionHref={basePath}
          onStartNewSession={startNewSession}
          session={{ id: session.sessionId, name: session.name }}
          options={
            <SessionDisplayOptions
              exportHref={`${basePath}/${encodeURIComponent(session.sessionId)}/export`}
              exportFilename={`pi-session-${session.sessionId}.jsonl`}
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
            storageKey={`backoffice:pi-session-workspace:${basePath}`}
            left={
              <SessionThread
                disabledReason={null}
                error={sendError}
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
                commandKind={commandKind}
                composerAction={composerAction}
                compacting={compacting}
                compactionError={
                  fetcher.data?.intent === "compact" && !fetcher.data.ok
                    ? fetcher.data.error
                    : compactionError
                }
                compactionNotice={compactionNotice}
                contextTokens={0}
                showContextUsage={false}
                inactiveHistoryCount={transcript.inactiveEntryCount}
                hasMoreHistory={history.hasMore}
                historyLoading={history.loading}
                historyError={history.error}
                onCommandKindChange={setCommandKind}
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
