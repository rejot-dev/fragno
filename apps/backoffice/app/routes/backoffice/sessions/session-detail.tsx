import { useStore } from "@fragno-dev/core/react";
import { useMemo, useState } from "react";
import { useLoaderData, useOutletContext, useParams } from "react-router";

import { createPiClient, createPiLofiSessionProjectionStore } from "@/fragno/pi/pi-client";
import { findPiModelOption, parsePiAgentName } from "@/fragno/pi/pi-shared";

import type { Route } from "./+types/session-detail";
import { fetchPiSessionDetail } from "./data";
import { useChatScroll } from "./session-detail/chat-scroll";
import {
  SessionComposer,
  SessionConversationPanel,
  SessionDisplayOptions,
  SessionHeader,
} from "./session-detail/components";
import type { PiSessionsOutletContext } from "./sessions";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.workflowName || !params.sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  const detail = await fetchPiSessionDetail(
    request,
    context,
    params.orgId,
    params.workflowName,
    params.sessionId,
  );
  if (detail.sessionError || !detail.session) {
    throw Response.json(detail.sessionError ?? { message: "Not Found", code: "NOT_FOUND" }, {
      status: detail.status ?? 404,
    });
  }

  return { session: detail.session };
}

export default function BackofficeOrganisationPiSessionDetail() {
  const { session } = useLoaderData<typeof loader>();
  const { basePath, harnesses } = useOutletContext<PiSessionsOutletContext>();
  const { orgId } = useParams();
  const [displayOptions, setDisplayOptions] = useState({
    showToolCalls: true,
    showThinking: true,
    showUsage: false,
  });
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const pi = useMemo(() => createPiClient(orgId), [orgId]);
  const commandSession = pi.useCommandSession();
  const projectionStore = useMemo(
    () =>
      createPiLofiSessionProjectionStore(orgId, session.workflowName, session.id, {
        initialState: session.agent.state,
        initialCompletedStepKeys: session.agent.completedStepKeys,
      }),
    [orgId, session.workflowName, session.id, session.agent.state, session.agent.completedStepKeys],
  );
  const projectionQuery = useStore(projectionStore);
  const projection = projectionQuery.data;
  const messages = projection.state.messages;
  const displaySession = {
    ...session,
    agent: { ...session.agent, state: { ...session.agent.state, messages } },
  };
  const sending = commandSession.loading ?? false;
  const projectionError =
    projection.error?.message ??
    (projectionQuery.error instanceof Error
      ? projectionQuery.error.message
      : projectionQuery.error
        ? "Pi session projection source failed."
        : null);
  const sendError = commandSession.error?.message ?? null;
  const readyForInput = !sending && projection.readyForInput;
  const statusText = sending ? "Sending…" : projection.statusText;
  const needsNudge = !sending && !readyForInput && statusText === "Working…";

  const agentName = displaySession.agentName;
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
        session={displaySession}
        backTo={basePath}
        harnessLabel={harnessLabel}
        modelLabel={modelLabel}
        options={
          <SessionDisplayOptions
            exportHref={`/api/pi/${orgId}/workflows/${encodeURIComponent(displaySession.workflowName)}/sessions/${encodeURIComponent(displaySession.id)}/export/pi-jsonl`}
            exportFilename={`pi-session-${displaySession.id}.jsonl`}
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
        onJumpToLatest={() => chatScroll.jumpToLatest("smooth")}
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
