import { useMemo, useState } from "react";
import { useLoaderData, useNavigate, useOutletContext, useParams } from "react-router";

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
  if (!params.orgId || !params.sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  const detail = await fetchPiSessionDetail(request, context, params.orgId, params.sessionId);
  if (detail.sessionError || !detail.session) {
    throw new Response(detail.sessionError ?? "Not Found", { status: detail.status ?? 404 });
  }

  return { session: detail.session };
}

export default function BackofficeOrganisationPiSessionDetail() {
  const { session } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { harnesses } = useOutletContext<PiSessionsOutletContext>();
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
    path: { sessionId: session.id },
    initialData: session,
  });
  const displaySession = liveSession.session ?? session;

  const parsedAgent = parsePiAgentName(displaySession.agent);
  const harnessLabel = parsedAgent
    ? (harnesses.find((entry) => entry.id === parsedAgent.harnessId)?.label ??
      parsedAgent.harnessId)
    : displaySession.agent;
  const modelLabel = parsedAgent
    ? (findPiModelOption(parsedAgent.provider, parsedAgent.model)?.label ?? parsedAgent.model)
    : displaySession.agent;

  const contentVersion = useMemo(
    () =>
      JSON.stringify({
        readyForInput: liveSession.readyForInput,
        sending: liveSession.sending,
        statusText: liveSession.statusText,
        messageCount: liveSession.messages.length,
        traceCount: liveSession.traceEvents.length,
        runningToolIds: liveSession.runningTools.map((tool) => tool.toolCallId),
      }),
    [
      liveSession.messages.length,
      liveSession.readyForInput,
      liveSession.runningTools,
      liveSession.sending,
      liveSession.statusText,
      liveSession.traceEvents.length,
    ],
  );
  const chatScroll = useChatScroll({
    sessionId: session.id,
    contentVersion,
  });

  const disabledReason = liveSession.readyForInput
    ? null
    : "This session is still working through the current turn. Wait for it to return to user input before sending another message.";

  const updateDisplayOption = (key: keyof typeof displayOptions) => (value: boolean) => {
    setDisplayOptions((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleSend = (text: string) => {
    const didSend = liveSession.sendMessage({ text });
    if (didSend) {
      chatScroll.jumpToLatest("auto");
    }
    return didSend;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SessionHeader
        session={displaySession}
        harnessLabel={harnessLabel}
        modelLabel={modelLabel}
        onBack={() => navigate("..")}
      />

      <SessionDisplayOptions
        showToolCalls={displayOptions.showToolCalls}
        showThinking={displayOptions.showThinking}
        showTrace={displayOptions.showTrace}
        showUsage={displayOptions.showUsage}
        onShowToolCallsChange={updateDisplayOption("showToolCalls")}
        onShowThinkingChange={updateDisplayOption("showThinking")}
        onShowTraceChange={updateDisplayOption("showTrace")}
        onShowUsageChange={updateDisplayOption("showUsage")}
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
        footer={
          <SessionComposer
            key={session.id}
            busy={liveSession.sending}
            disabled={!liveSession.readyForInput}
            disabledReason={disabledReason}
            error={liveSession.sendError}
            onSend={handleSend}
          />
        }
      />

      {displayOptions.showTrace ? (
        <SessionTracePanel traceEvents={liveSession.traceEvents} />
      ) : null}
    </div>
  );
}
