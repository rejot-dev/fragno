import type { PiManagerAgent } from "@fragno-dev/backoffice-api/v0/pi";
import { ChatStartPanel } from "@fragno-private/design-system/agents/chat-start";
import { PaneMessage } from "@fragno-private/design-system/feedback/pane-message";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  Navigate,
  redirect,
  useOutletContext,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import {
  AGENT_BESIDE_PHONE_QUERY,
  useAskAgent,
  useShowAgentBeside,
} from "@/components/backoffice/ask-agent";
import { isPiAssistant } from "@/fragno/pi/agent/agent-definitions";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-detail";
import { AgentConversation, type PiAgentActionData } from "./agent-conversation";
import { isPiConversationSubmission } from "./agent-conversation-submission";
import { describePiAgentWithCategory } from "./agent-labels";
import { sendPiAgentMessage } from "./agent-message.server";
import { AgentPermissions } from "./agent-permissions";
import { AgentStartComposer } from "./agent-start-composer";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";
import {
  fetchPiManagerAgent,
  resumePiManagerAgent,
  resetPiManagerAgent,
  stopPiManagerAgent,
} from "./data";

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
  // Starting is sending the first turn; the separate intent reloads the agent, which it provisions.
  // A provisioned agent's conversation sends through `messages`.
  if (intent !== "start") {
    return { ok: false, intent: "start", error: "Unsupported agent action." };
  }
  const result = await sendPiAgentMessage({
    request,
    context,
    scope,
    agentName,
    requestId: crypto.randomUUID(),
    formData,
  });
  return result.ok
    ? { ok: true, intent, receipt: result.receipt }
    : { ok: false, intent, error: result.error };
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgent(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
}

/**
 * Phones that keep the agent drawer beside the page show a conversation only there, so the agent's
 * page there is its profile, which hands the conversation to the drawer.
 */
export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  if (window.matchMedia(AGENT_BESIDE_PHONE_QUERY).matches) {
    // A trailing slash would double before the profile's segment, which no route matches.
    throw redirect(`${new URL(request.url).pathname.replace(/\/+$/, "")}/profile`);
  }
  return await serverLoader();
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
  const { resolvedScope, directory, basePath, usageLabel, availableModelOptions } =
    useOutletContext<PiAgentsOutletContext>();
  const showAgentBeside = useShowAgentBeside();
  const askAgent = useAskAgent();
  // The message being written here, which moves to the drawer when the phone turns or unfolds into
  // one that keeps the conversation there, rather than leave with this page. Only its text moves:
  // files picked for it are picked again in the drawer.
  const unsentRef = useRef<{ agentName: string; text: string } | null>(null);
  const noteUnsent = useCallback(
    (text: string) => {
      unsentRef.current = { agentName: params.agentName, text };
    },
    [params.agentName],
  );
  useEffect(() => {
    const unsent = unsentRef.current;
    if (showAgentBeside === null || askAgent === null || unsent === null) {
      return;
    }
    unsentRef.current = null;
    if (unsent.agentName === params.agentName && unsent.text.trim() !== "") {
      askAgent({ agentName: unsent.agentName, text: unsent.text });
    }
  }, [askAgent, params.agentName, showAgentBeside]);
  // The client loader redirects such phones, except where the screen was not known yet (a page
  // load) or the phone turned or unfolded into one on this page.
  if (showAgentBeside !== null) {
    return <Navigate replace to={`${basePath}/${encodeURIComponent(params.agentName)}/profile`} />;
  }
  if (!loaderData.found) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AgentsHeader
          basePath={basePath}
          directory={directory}
          selected={{ agentName: params.agentName, page: "conversation" }}
          options={null}
        />
        <PaneMessage tone="failed">{loaderData.message}</PaneMessage>
      </div>
    );
  }
  const { agent } = loaderData;
  const agentPath = `${basePath}/${encodeURIComponent(agent.agentName)}`;
  if (!agent.provisioned) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AgentsHeader
          basePath={basePath}
          directory={directory}
          selected={{ agentName: agent.agentName, page: "conversation" }}
          options={null}
        />
        {isPiAssistant(agent) ? (
          <AgentStartComposer
            // Files uploaded for one agent cannot go to another.
            key={agentPath}
            action={agentPath}
            agentName={agent.agentName}
            builtIn={agent.steward.kind === "backoffice"}
            availableModelOptions={availableModelOptions}
            description={agent.description}
            permissions={agent.permissions}
            usageLabel={usageLabel}
            resolvedScope={resolvedScope}
            draft={null}
            onDraftChange={noteUnsent}
            // Starting revalidates this route, which then shows the conversation.
            onStarted={() => undefined}
          />
        ) : (
          <ChatStartPanel
            title={formatPiAgentName(agent.agentName)}
            description={agent.description}
            details={
              <AgentPermissions permissions={agent.permissions} className="font-mono text-xs" />
            }
          >
            <p className="text-sm text-pretty text-[var(--bo-muted)]">
              {describePiAgentWithCategory(agent.agentName)} Its conversation appears here once an
              agent or workflow gives it work.
            </p>
          </ChatStartPanel>
        )}
      </div>
    );
  }
  // Agent-owned client state survives same-agent revalidation and resets on agent navigation.
  return (
    <PiAgentDetailConversation
      key={agentPath}
      agent={agent}
      agentPath={agentPath}
      onDraftChange={noteUnsent}
    />
  );
}

function PiAgentDetailConversation({
  agent,
  agentPath,
  onDraftChange,
}: {
  agent: PiManagerAgent;
  agentPath: string;
  onDraftChange: (text: string) => void;
}) {
  const { resolvedScope, directory, availableModelOptions, basePath, dictationMountRoute } =
    useOutletContext<PiAgentsOutletContext>();
  const header = (options: ReactNode | null) => (
    <AgentsHeader
      basePath={basePath}
      directory={directory}
      selected={{ agentName: agent.agentName, page: "conversation" }}
      options={options}
    />
  );

  return (
    <AgentConversation
      agent={agent}
      agentPath={agentPath}
      availableModelOptions={availableModelOptions}
      dictationMountRoute={dictationMountRoute}
      header={header}
      draft={null}
      onDraftChange={onDraftChange}
      resolvedScope={resolvedScope}
    />
  );
}
