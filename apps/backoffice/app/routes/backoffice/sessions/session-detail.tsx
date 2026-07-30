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
import { findPiModelOption, parsePiAgentName } from "@/fragno/pi/pi-shared";
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
  createSessionWorkspaceState,
  reconcileSessionWorkspaceState,
} from "./session-detail/workspace-model";
import {
  SessionMobileWorkspaceTabs,
  SessionWorkspacePanel,
} from "./session-detail/workspace-panel";
import { projectSessionWorkspaceTabs } from "./session-detail/workspace-projection";
import { SessionWorkspaceSplit } from "./session-detail/workspace-split";
import type { PiSessionsOutletContext } from "./session-types";

const TERMINAL_SESSION_LABELS: Record<string, string> = {
  complete: "Session completed",
  errored: "Session disabled",
  terminated: "Session stopped",
};

export default function BackofficeOrganisationPiSessionDetail() {
  const { workflowName, sessionId } = useParams();
  const { scope, persistenceSource, harnesses } = useOutletContext<PiSessionsOutletContext>();

  if (!workflowName || !sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  return (
    <SynchronizedPiSessionDetail
      key={`${workflowName}:${sessionId}`}
      scope={scope}
      source={persistenceSource}
      workflowName={workflowName}
      sessionId={sessionId}
      harnesses={harnesses}
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

function SynchronizedPiSessionDetail({
  scope,
  source,
  workflowName,
  sessionId,
  harnesses,
}: {
  scope: PiSessionsOutletContext["scope"];
  source: PiSessionsOutletContext["persistenceSource"];
  workflowName: string;
  sessionId: string;
  harnesses: PiSessionsOutletContext["harnesses"];
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
      harnesses={harnesses}
      projection={projection}
      projectionError={projectionError}
      instanceStatus={instanceStatus}
    />
  );
}

function PiSessionDetailView({
  scope,
  session,
  harnesses,
  projection,
  projectionError,
  instanceStatus,
}: {
  scope: PiSessionsOutletContext["scope"];
  session: PiSession;
  harnesses: PiSessionsOutletContext["harnesses"];
  projection: PiWorkflowSessionProjectionState;
  projectionError: string | null;
  instanceStatus: string | null;
}) {
  const [displayOptions, setDisplayOptions] = useState({
    showToolCalls: true,
    showThinking: true,
    showUsage: false,
  });
  const [commandKind, setCommandKind] = useState<"followUp" | "steer">("followUp");
  const [searchParams, setSearchParams] = useSearchParams();
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const pi = useMemo(() => createPiClient(scope), [scope]);
  const commandSession = pi.useCommandSession();
  const messages = projection.state.messages;
  const sending = commandSession.loading ?? false;
  const disabledReason = instanceStatus ? (TERMINAL_SESSION_LABELS[instanceStatus] ?? null) : null;
  const sessionDisabled = disabledReason !== null;
  const initialPromptError = searchParams.get("initialPromptError");
  const sendError = sessionDisabled ? null : (commandSession.error?.message ?? initialPromptError);
  const readyForInput = !sessionDisabled && !sending && projection.readyForInput;
  const statusText = sessionDisabled
    ? disabledReason
    : sending
      ? "Sending…"
      : projection.statusText;
  const running = !sessionDisabled && (sending || !projection.readyForInput);
  const needsNudge = !sessionDisabled && !sending && !readyForInput && statusText === "Working…";

  const parsedAgent = parsePiAgentName(session.agent);
  const harnessLabel = parsedAgent
    ? (harnesses.find((entry) => entry.id === parsedAgent.harnessId)?.label ??
      parsedAgent.harnessId)
    : session.agent;
  const modelLabel = parsedAgent
    ? (findPiModelOption(parsedAgent.provider, parsedAgent.model)?.label ?? parsedAgent.model)
    : session.agent;

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
  const workspaceTabs = useMemo(
    () =>
      projectSessionWorkspaceTabs({
        draftAgentMessage: projection.draftAgentMessage,
        messages,
      }),
    [messages, projection.draftAgentMessage],
  );
  const [workspaceState, setWorkspaceState] = useState(() =>
    createSessionWorkspaceState(workspaceTabs),
  );
  const workspaceTabIds = useMemo(
    () => new Set(workspaceTabs.map((tab) => tab.id)),
    [workspaceTabs],
  );

  useEffect(() => {
    setWorkspaceState((current) => reconcileSessionWorkspaceState(current, workspaceTabs));
  }, [workspaceTabs]);

  const openWorkspaceTab = useCallback(
    (tabId: string) => {
      if (!workspaceTabIds.has(tabId)) {
        return;
      }
      setWorkspaceState((current) => ({ ...current, open: true, selectedTabId: tabId }));
    },
    [workspaceTabIds],
  );
  const closeWorkspace = useCallback(() => {
    setWorkspaceState((current) => ({ ...current, open: false }));
  }, []);
  const workspaceNavigation = useMemo<SessionWorkspaceNavigation>(
    () => ({
      hasTab: (tabId) => workspaceTabIds.has(tabId),
      openTab: openWorkspaceTab,
    }),
    [openWorkspaceTab, workspaceTabIds],
  );
  const selectedWorkspaceTab =
    workspaceTabs.find((tab) => tab.id === workspaceState.selectedTabId) ?? workspaceTabs.at(-1);

  const handleSend = useCallback(
    async (message: AppendMessage) => {
      const text = getAppendMessageText(message);
      if (!text || sessionDisabled) {
        return;
      }
      try {
        await commandSession.mutate({
          path: { workflowName: session.workflowName, sessionId: session.id },
          body: { kind: commandKind, input: { text } },
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

  const handleContinue = () =>
    commandSession.mutate({
      path: { workflowName: session.workflowName, sessionId: session.id },
      body: { kind: "nextTurn", input: { text: "Continue." } },
    });

  const handleStop = () =>
    commandSession.mutate({
      path: { workflowName: session.workflowName, sessionId: session.id },
      body: { kind: "abort", reason: "Stopped from backoffice UI" },
    });

  const updateDisplayOption = (key: keyof typeof displayOptions) => (value: boolean) => {
    setDisplayOptions((current) => ({ ...current, [key]: value }));
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <SessionHeader
          session={session}
          harnessLabel={harnessLabel}
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

        {projectionError ? (
          <div className="mx-4 mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-sm text-[var(--bo-failed)]">
            {projectionError}
          </div>
        ) : null}

        {workspaceTabs.length > 0 ? (
          <SessionMobileWorkspaceTabs
            tabs={workspaceTabs}
            selectedTabId={workspaceState.open ? (selectedWorkspaceTab?.id ?? null) : null}
            onSelectChat={closeWorkspace}
            onSelectTab={openWorkspaceTab}
          />
        ) : null}

        <SessionWorkspaceNavigationProvider value={workspaceNavigation}>
          <SessionWorkspaceSplit
            storageKey={`backoffice:pi-session-workspace:${scope.orgId}`}
            left={
              <SessionThread
                disabledReason={disabledReason}
                error={sendError}
                modelLabel={modelLabel}
                needsNudge={needsNudge}
                onContinue={handleContinue}
                onStop={handleStop}
                running={running}
                showThinking={displayOptions.showThinking}
                showToolCalls={displayOptions.showToolCalls}
                showUsage={displayOptions.showUsage}
                statusText={statusText}
                commandKind={commandKind}
                onCommandKindChange={setCommandKind}
              />
            }
            right={
              workspaceState.open && selectedWorkspaceTab ? (
                <SessionWorkspacePanel
                  tabs={workspaceTabs}
                  selectedTabId={selectedWorkspaceTab.id}
                  onClose={closeWorkspace}
                  onSelectTab={openWorkspaceTab}
                />
              ) : null
            }
          />
        </SessionWorkspaceNavigationProvider>
      </div>
    </AssistantRuntimeProvider>
  );
}
