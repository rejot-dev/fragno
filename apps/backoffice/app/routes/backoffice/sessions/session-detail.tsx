import { estimatePiContextUsage } from "@fragno-dev/pi-harness/context-usage";
import type { PiSession } from "@fragno-dev/pi-harness/types";
import type { PiWorkflowSessionProjectionState } from "@fragno-dev/pi-harness/workflow-session-projection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useParams, useSearchParams } from "react-router";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";

import { createPiClient } from "@/fragno/pi/pi-client";
import { findPiModelOption, piSessionModel } from "@/fragno/pi/pi-shared";
import { piSessionActivityLabel } from "@/fragno/pi/session-activity";
import { projectPiSessionInteraction } from "@/fragno/pi/session-interaction";
import { usePiSessionProjection } from "@/fragno/pi/tanstack/use-session-projection";
import { scopedPublicMountPath } from "@/fragno/scoped-public-fragment-routes";

import {
  createAssistantUiMessages,
  getAppendMessageText,
} from "./session-detail/assistant-runtime";
import { SessionDisplayOptions } from "./session-detail/display-options";
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
import { projectSessionWorkspaceItems } from "./session-detail/workspace-projection";
import { SessionWorkspaceSplit } from "./session-detail/workspace-split";
import type { PiSessionsOutletContext } from "./session-types";

const TERMINAL_SESSION_LABELS: Record<string, string> = {
  complete: "Session completed",
  errored: "Session disabled",
  terminated: "Session stopped",
};

function getSessionStatusText({
  disabledReason,
  compacting,
  sending,
  projectedStatusText,
}: {
  disabledReason: string | null;
  compacting: boolean;
  sending: boolean;
  projectedStatusText: string | null;
}): string | null {
  if (disabledReason !== null) {
    return disabledReason;
  }
  if (compacting) {
    return "Compacting…";
  }
  if (sending) {
    return "Sending…";
  }
  return projectedStatusText;
}

function getSessionModelLabel(session: PiSession) {
  const model = piSessionModel(session.metadata);
  return model
    ? (findPiModelOption(model.provider, model.name)?.label ?? model.name)
    : session.workflowName;
}

function getWorkspaceStateKey(scope: PiSessionsOutletContext["scope"], session: PiSession) {
  return [scope.orgId, session.workflowName, session.id].map(encodeURIComponent).join(":");
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

export default function BackofficeOrganisationPiSessionDetail() {
  const { workflowName, sessionId } = useParams();
  const { scope, persistenceSource } = useOutletContext<PiSessionsOutletContext>();

  if (!workflowName || !sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  return (
    <SynchronizedPiSessionDetail
      key={`${scope.orgId}:${workflowName}:${sessionId}`}
      scope={scope}
      source={persistenceSource}
      workflowName={workflowName}
      sessionId={sessionId}
    />
  );
}

function PiSessionDetailLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--bo-muted)]">
      <span className="mr-2 size-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
      Loading local Pi session…
    </div>
  );
}

function SessionProjectionError({ error }: { error: string | null }) {
  return error ? (
    <div className="mx-4 mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-sm text-[var(--bo-failed)]">
      {error}
    </div>
  ) : null;
}

function SynchronizedPiSessionDetail({
  scope,
  source,
  workflowName,
  sessionId,
}: {
  scope: PiSessionsOutletContext["scope"];
  source: PiSessionsOutletContext["persistenceSource"];
  workflowName: string;
  sessionId: string;
}) {
  const {
    session,
    projection,
    instanceStatus,
    error: projectionError,
    isLoading,
  } = usePiSessionProjection({
    source,
    workflowName,
    sessionId,
  });

  if (!session) {
    return isLoading ? (
      <PiSessionDetailLoading />
    ) : (
      <div className="m-4 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] p-4 text-sm text-[var(--bo-failed)]">
        {projectionError ?? `Pi session ${workflowName}/${sessionId} was not found.`}
      </div>
    );
  }

  return (
    <PiSessionDetailView
      scope={scope}
      session={session}
      projection={projection}
      projectionError={projectionError}
      instanceStatus={instanceStatus}
    />
  );
}

function PiSessionDetailView({
  scope,
  session,
  projection,
  projectionError,
  instanceStatus,
}: {
  scope: PiSessionsOutletContext["scope"];
  session: PiSession;
  projection: PiWorkflowSessionProjectionState;
  projectionError: string | null;
  instanceStatus: string | null;
}) {
  const { workspaceStates, updateWorkspaceState, workflowCollections, workflowCollectionsError } =
    useOutletContext<PiSessionsOutletContext>();
  const { displayOptions, updateDisplayOption } = useSessionDisplayOptions();
  const [commandKind, setCommandKind] = useState<"followUp" | "steer">("followUp");
  const [composerAction, setComposerAction] = useState<"message" | "compact">("message");
  const [submittingCompaction, setSubmittingCompaction] = useState(false);
  const [pendingCompactionCommandId, setPendingCompactionCommandId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const pi = useMemo(() => createPiClient(scope), [scope]);
  const commandSession = pi.useCommandSession();
  const messages = projection.timelineMessages;
  const contextMessages = projection.contextMessages;
  const contextUsage = useMemo(() => estimatePiContextUsage(contextMessages), [contextMessages]);
  const sending = commandSession.loading ?? false;
  const disabledReason = instanceStatus ? (TERMINAL_SESSION_LABELS[instanceStatus] ?? null) : null;
  const sessionDisabled = disabledReason !== null;
  const initialPromptError = searchParams.get("initialPromptError");
  const sendError = sessionDisabled ? null : (commandSession.error?.message ?? initialPromptError);
  const pendingCompactionOutcome = pendingCompactionCommandId
    ? (projection.compactOutcomesByCommandId[pendingCompactionCommandId] ?? null)
    : null;
  const { compacting, readyForInput, running, needsNudge } = projectPiSessionInteraction({
    sessionDisabled,
    sending,
    localCompactionPending:
      submittingCompaction ||
      (pendingCompactionCommandId !== null && pendingCompactionOutcome === null),
    projection,
  });
  const statusText = getSessionStatusText({
    disabledReason,
    compacting,
    sending,
    projectedStatusText:
      projection.status === "loading" ? "Loading…" : piSessionActivityLabel(projection.activity),
  });

  const modelLabel = getSessionModelLabel(session);

  const assistantMessages = useMemo(
    () =>
      createAssistantUiMessages({
        draftAgentMessage: projection.draftAgentMessage,
        messages,
        readyForInput: projection.readyForInput,
        statusText,
      }),
    [messages, projection.draftAgentMessage, projection.readyForInput, statusText],
  );
  const workspaceItems = useMemo(
    () =>
      projectSessionWorkspaceItems({
        draftAgentMessage: projection.draftAgentMessage,
        messages,
      }),
    [messages, projection.draftAgentMessage],
  );
  const workspaceStateKey = getWorkspaceStateKey(scope, session);
  const workspaceState = workspaceStates[workspaceStateKey] ?? createSessionWorkspaceState();
  const workspaceItemIds = useMemo(
    () => new Set(workspaceItems.map((item) => item.id)),
    [workspaceItems],
  );

  useEffect(() => {
    updateWorkspaceState(workspaceStateKey, (current) =>
      autoOpenNewWorkflowWorkspaceItem(current, workspaceItems),
    );
  }, [updateWorkspaceState, workspaceItems, workspaceStateKey]);

  const toggleWorkspaceItem = useCallback(
    (itemId: string) => {
      if (!workspaceItemIds.has(itemId)) {
        return;
      }
      updateWorkspaceState(workspaceStateKey, (current) =>
        toggleSessionWorkspaceItem(current, itemId),
      );
    },
    [updateWorkspaceState, workspaceItemIds, workspaceStateKey],
  );
  const closeWorkspace = useCallback(() => {
    updateWorkspaceState(workspaceStateKey, (current) => ({ ...current, open: false }));
  }, [updateWorkspaceState, workspaceStateKey]);

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
      if (!text || sessionDisabled) {
        return;
      }
      try {
        await commandSession.mutate({
          path: { workflowName: session.workflowName, sessionId: session.id },
          body: {
            kind: projection.readyForInput ? "prompt" : commandKind,
            input: { text },
          },
        });
      } catch (error) {
        const composer = runtimeRef.current?.thread.composer;
        if (composer?.getState().text === "") {
          composer.setText(text);
        }
        throw error;
      }

      if (initialPromptError) {
        setSearchParams(
          (currentSearchParams) => {
            const nextSearchParams = new URLSearchParams(currentSearchParams);
            nextSearchParams.delete("initialPromptError");
            return nextSearchParams;
          },
          { replace: true },
        );
      }
    },
    [
      commandKind,
      commandSession,
      initialPromptError,
      projection.readyForInput,
      sessionDisabled,
      session.id,
      session.workflowName,
      setSearchParams,
    ],
  );

  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: (message) => message,
    isRunning: false,
    isSendDisabled: sending || sessionDisabled,
    onNew: handleSend,
  });

  useEffect(() => {
    runtimeRef.current = runtime;
    return () => {
      runtimeRef.current = null;
    };
  }, [runtime]);

  const handleCompact = useCallback(async () => {
    if (!readyForInput) {
      return;
    }

    const composer = runtimeRef.current?.thread.composer;
    const customInstructions = composer?.getState().text.trim();
    setSubmittingCompaction(true);
    try {
      const acknowledgement = await commandSession.mutate({
        path: { workflowName: session.workflowName, sessionId: session.id },
        body: {
          kind: "compact",
          input: customInstructions ? { customInstructions } : {},
        },
      });
      if (acknowledgement && !Array.isArray(acknowledgement)) {
        setPendingCompactionCommandId(acknowledgement.commandId);
      }
    } catch {
      // The mutator exposes submission failures through commandSession.error.
    } finally {
      setSubmittingCompaction(false);
    }
  }, [commandSession, readyForInput, session.id, session.workflowName]);

  const handledCompactionCommandIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      pendingCompactionCommandId === null ||
      pendingCompactionOutcome?.status !== "succeeded" ||
      handledCompactionCommandIdRef.current === pendingCompactionCommandId
    ) {
      return;
    }

    handledCompactionCommandIdRef.current = pendingCompactionCommandId;
    runtimeRef.current?.thread.composer.setText("");
  }, [pendingCompactionCommandId, pendingCompactionOutcome]);

  const selectedComposerAction =
    pendingCompactionOutcome?.status === "succeeded" ? "message" : composerAction;
  const handleComposerActionChange = (action: "message" | "compact") => {
    setPendingCompactionCommandId(null);
    setComposerAction(action);
  };

  const handleContinue = () =>
    commandSession.mutate({
      path: { workflowName: session.workflowName, sessionId: session.id },
      body: { kind: "prompt", input: { text: "Continue." } },
    });

  const handleStop = () =>
    commandSession.mutate({
      path: { workflowName: session.workflowName, sessionId: session.id },
      body: { kind: "abort", reason: "Stopped from backoffice UI" },
    });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <SessionHeader
          session={session}
          modelLabel={modelLabel}
          options={
            <SessionDisplayOptions
              exportHref={`${scopedPublicMountPath({ publicPrefix: "/api/pi", scope })}/workflows/${encodeURIComponent(session.workflowName)}/sessions/${encodeURIComponent(session.id)}/export/pi-jsonl`}
              exportFilename={`pi-session-${session.id}.jsonl`}
              showToolCalls={displayOptions.showToolCalls}
              showThinking={displayOptions.showThinking}
              showUsage={displayOptions.showUsage}
              onShowToolCallsChange={updateDisplayOption("showToolCalls")}
              onShowThinkingChange={updateDisplayOption("showThinking")}
              onShowUsageChange={updateDisplayOption("showUsage")}
            />
          }
        />

        <SessionProjectionError error={projectionError} />

        <SessionWorkspaceNavigationProvider value={workspaceNavigation}>
          <SessionWorkspaceSplit
            storageKey={`backoffice:pi-session-workspace:${scope.orgId}`}
            left={
              <SessionThread
                disabledReason={disabledReason}
                error={sendError}
                modelLabel={modelLabel}
                needsNudge={needsNudge}
                onCompact={handleCompact}
                onContinue={handleContinue}
                onStop={handleStop}
                readyForInput={readyForInput}
                running={running}
                showThinking={displayOptions.showThinking}
                showToolCalls={displayOptions.showToolCalls}
                showUsage={displayOptions.showUsage}
                statusText={statusText}
                commandKind={commandKind}
                composerAction={selectedComposerAction}
                compacting={compacting}
                compactOutcome={projection.latestCommandCompactOutcome}
                contextTokens={contextUsage.tokens}
                onCommandKindChange={setCommandKind}
                onComposerActionChange={handleComposerActionChange}
              />
            }
            right={
              workspaceState.open && selectedWorkspaceItem ? (
                <SessionWorkspacePanel
                  key={selectedWorkspaceItem.id}
                  item={selectedWorkspaceItem}
                  workflowCollections={workflowCollections}
                  workflowCollectionsError={workflowCollectionsError}
                  orgId={scope.orgId}
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
