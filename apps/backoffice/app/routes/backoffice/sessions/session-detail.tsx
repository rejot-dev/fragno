import { useMemo, useState } from "react";
import { useLoaderData, useOutletContext, useParams } from "react-router";

import { createOrgPiClient } from "@/fragno/pi/pi-client";
import { findPiModelOption, parsePiAgentName } from "@/fragno/pi/pi-shared";

import type { Route } from "./+types/session-detail";
import { fetchPiSessionDetail } from "./data";
import { useChatScroll } from "./session-detail/chat-scroll";
import {
  SessionComposer,
  SessionConversationPanel,
  SessionDisplayOptions,
  SessionHeader,
  SessionTracePanel,
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
    showTrace: false,
    showUsage: false,
  });
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const pi = useMemo(() => createOrgPiClient(orgId), [orgId]);
  const liveSession = pi.useSession({
    path: { workflowName: session.workflowName, sessionId: session.id },
    initialData: session,
  });
  const displaySession = liveSession.session ?? session;

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
        readyForInput: liveSession.readyForInput,
        sending: liveSession.sending,
        statusText: liveSession.statusText,
        messageCount: liveSession.messages.length,
        eventCount: liveSession.events.length,
        runningToolIds: liveSession.runningTools.map((tool) => tool.toolCallId),
      }),
    [
      liveSession.messages.length,
      liveSession.readyForInput,
      liveSession.runningTools,
      liveSession.sending,
      liveSession.statusText,
      liveSession.events.length,
    ],
  );
  const chatScroll = useChatScroll({
    sessionId: session.id,
    contentVersion,
  });

  const disabledReason = liveSession.readyForInput
    ? null
    : "The model is working. You can still send a follow-up, steer it, or stop the session.";

  const updateDisplayOption = (key: keyof typeof displayOptions) => (value: boolean) => {
    setDisplayOptions((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleSend = async (command: { kind: "followUp" | "steer"; text: string }) => {
    await liveSession.sendCommand({
      kind: command.kind,
      input: { text: command.text },
    });
    chatScroll.jumpToLatest("auto");
    return true;
  };

  const handleContinue = () => liveSession.sendCommand({ kind: "continue" });

  const handleStop = () =>
    liveSession.sendCommand({ kind: "abort", reason: "Stopped from backoffice UI" });

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
            showTrace={displayOptions.showTrace}
            showUsage={displayOptions.showUsage}
            onShowToolCallsChange={updateDisplayOption("showToolCalls")}
            onShowThinkingChange={updateDisplayOption("showThinking")}
            onShowTraceChange={updateDisplayOption("showTrace")}
            onShowUsageChange={updateDisplayOption("showUsage")}
          />
        }
      />

      {liveSession.error ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {liveSession.error}
        </div>
      ) : null}

      <SessionConversationPanel
        messages={liveSession.messages}
        onJumpToLatest={() => chatScroll.jumpToLatest("smooth")}
        onScroll={chatScroll.onScroll}
        readyForInput={liveSession.readyForInput}
        runningTools={liveSession.runningTools}
        scrollContentRef={chatScroll.contentRef}
        scrollViewportRef={chatScroll.viewportRef}
        showJumpToLatest={chatScroll.showJumpToLatest}
        showThinking={displayOptions.showThinking}
        showToolCalls={displayOptions.showToolCalls}
        showUsage={displayOptions.showUsage}
        statusText={liveSession.statusText}
      />

      <SessionComposer
        key={session.id}
        busy={liveSession.sending}
        readyForInput={liveSession.readyForInput}
        disabledReason={disabledReason}
        error={liveSession.sendError}
        needsNudge={liveSession.needsNudge}
        onContinue={handleContinue}
        onSend={handleSend}
        onStop={handleStop}
      />

      {displayOptions.showTrace ? <SessionTracePanel traceEvents={liveSession.events} /> : null}
    </div>
  );
}
