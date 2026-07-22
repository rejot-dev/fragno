import type { PiSession } from "@fragno-dev/pi-harness/types";
import type { PiWorkflowSessionProjectionState } from "@fragno-dev/pi-harness/workflow-session-projection";
import { useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router";

import { createPiClient } from "@/fragno/pi/pi-client";
import { findPiModelOption, parsePiAgentName } from "@/fragno/pi/pi-shared";
import { usePiSessionProjection } from "@/fragno/pi/tanstack/use-session-projection";
import { scopedPublicMountPath } from "@/fragno/scoped-public-fragment-routes";

import { useChatScroll } from "./session-detail/chat-scroll";
import {
  SessionComposer,
  SessionConversationPanel,
  SessionDisplayOptions,
  SessionHeader,
} from "./session-detail/components";
import type { PiSessionsOutletContext } from "./sessions";

export default function BackofficeOrganisationPiSessionDetail() {
  const { workflowName, sessionId } = useParams();
  const { scope, persistenceSource, basePath, harnesses } =
    useOutletContext<PiSessionsOutletContext>();

  if (!workflowName || !sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  return (
    <SynchronizedPiSessionDetail
      scope={scope}
      source={persistenceSource}
      workflowName={workflowName}
      sessionId={sessionId}
      basePath={basePath}
      harnesses={harnesses}
    />
  );
}

function PiSessionDetailLoading() {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
      Loading local Pi session…
    </div>
  );
}

function SynchronizedPiSessionDetail({
  scope,
  source,
  workflowName,
  sessionId,
  basePath,
  harnesses,
}: {
  scope: PiSessionsOutletContext["scope"];
  source: PiSessionsOutletContext["persistenceSource"];
  workflowName: string;
  sessionId: string;
  basePath: string;
  harnesses: PiSessionsOutletContext["harnesses"];
}) {
  const {
    session,
    projection,
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
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">
        {projectionError ?? `Pi session ${workflowName}/${sessionId} was not found.`}
      </div>
    );
  }

  return (
    <PiSessionDetailView
      scope={scope}
      session={session}
      basePath={basePath}
      harnesses={harnesses}
      projection={projection}
      projectionError={projectionError}
    />
  );
}

function PiSessionDetailView({
  scope,
  session,
  basePath,
  harnesses,
  projection,
  projectionError,
}: {
  scope: PiSessionsOutletContext["scope"];
  session: PiSession;
  basePath: string;
  harnesses: PiSessionsOutletContext["harnesses"];
  projection: PiWorkflowSessionProjectionState;
  projectionError: string | null;
}) {
  const [displayOptions, setDisplayOptions] = useState({
    showToolCalls: true,
    showThinking: true,
    showUsage: false,
  });
  const pi = useMemo(() => createPiClient(scope), [scope]);
  const commandSession = pi.useCommandSession();
  const messages = projection.state.messages;
  const sending = commandSession.loading ?? false;
  const sendError = commandSession.error?.message ?? null;
  const readyForInput = !sending && projection.readyForInput;
  const statusText = sending ? "Sending…" : projection.statusText;
  const needsNudge = !sending && !readyForInput && statusText === "Working…";

  const agentName = session.agent;
  const parsedAgent = parsePiAgentName(agentName);
  const harnessLabel = parsedAgent
    ? (harnesses.find((entry) => entry.id === parsedAgent.harnessId)?.label ??
      parsedAgent.harnessId)
    : agentName;
  const modelLabel = parsedAgent
    ? (findPiModelOption(parsedAgent.provider, parsedAgent.model)?.label ?? parsedAgent.model)
    : agentName;

  const contentVersion = useMemo(
    () =>
      JSON.stringify({
        readyForInput,
        sending,
        statusText,
        messageCount: messages.length,
        draftAgentMessageUpdatedAt: projection.draftAgentMessage?.updatedAt ?? null,
        draftAgentToolIds: Object.keys(projection.draftAgentMessage?.tools ?? {}),
      }),
    [messages.length, projection.draftAgentMessage, readyForInput, sending, statusText],
  );
  const chatScroll = useChatScroll({
    sessionId: session.id,
    contentVersion,
  });

  const disabledReason = readyForInput
    ? null
    : "The model is working. You can still send a follow-up, steer it, or stop the session.";

  const updateDisplayOption = (key: keyof typeof displayOptions) => (value: boolean) => {
    setDisplayOptions((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleSend = async (command: { kind: "followUp" | "steer"; text: string }) => {
    await commandSession.mutate({
      path: { workflowName: session.workflowName, sessionId: session.id },
      body: { kind: command.kind, input: { text: command.text } },
    });
    chatScroll.jumpToLatest("auto");
    return true;
  };

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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <SessionHeader
        session={session}
        backTo={basePath}
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
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {projectionError}
        </div>
      ) : null}

      <SessionConversationPanel
        draftAgentMessage={projection.draftAgentMessage}
        messages={messages}
        onJumpToLatest={() => {
          chatScroll.jumpToLatest("smooth");
        }}
        onScroll={chatScroll.onScroll}
        readyForInput={readyForInput}
        scrollContentRef={chatScroll.contentRef}
        scrollViewportRef={chatScroll.viewportRef}
        showJumpToLatest={chatScroll.showJumpToLatest}
        showThinking={displayOptions.showThinking}
        showToolCalls={displayOptions.showToolCalls}
        showUsage={displayOptions.showUsage}
        statusText={statusText}
      />

      <SessionComposer
        key={session.id}
        busy={sending}
        readyForInput={readyForInput}
        disabledReason={disabledReason}
        error={sendError}
        needsNudge={needsNudge}
        onContinue={handleContinue}
        onSend={handleSend}
        onStop={handleStop}
      />
    </div>
  );
}
