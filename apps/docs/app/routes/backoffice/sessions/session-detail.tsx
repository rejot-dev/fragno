import { useEffect, useMemo, useState } from "react";
import { useLoaderData, useNavigate, useOutletContext, useParams } from "react-router";
import type { Route } from "./+types/session-detail";
import { fetchPiSessionDetail } from "./data";
import type { PiSessionsOutletContext } from "./sessions";
import { findPiModelOption, parsePiAgentName } from "@/fragno/pi-shared";
import { useChatScroll } from "./session-detail/chat-scroll";
import { createOrgPiClient } from "@/fragno/pi-client";
import {
  LiveToolsPanel,
  SessionComposer,
  SessionConversationPanel,
  SessionDisplayOptions,
  SessionHeader,
  SessionTracePanel,
} from "./session-detail/components";

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
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

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
    () => `${liveSession.messages.length}:${liveSession.traceEvents.length}`,
    [liveSession.messages.length, liveSession.traceEvents.length],
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
      chatScroll.jumpToLatest("smooth");
    }
    return didSend;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SessionHeader
        session={displaySession}
        harnessLabel={harnessLabel}
        modelLabel={modelLabel}
        statusText={hydrated ? liveSession.statusText : null}
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
        scrollViewportRef={chatScroll.viewportRef}
        showJumpToLatest={chatScroll.showJumpToLatest}
        showToolCalls={displayOptions.showToolCalls}
        showThinking={displayOptions.showThinking}
        showUsage={displayOptions.showUsage}
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

      <LiveToolsPanel tools={liveSession.runningTools} />

      {displayOptions.showTrace ? (
        <SessionTracePanel traceEvents={liveSession.traceEvents} />
      ) : null}
    </div>
  );
}
