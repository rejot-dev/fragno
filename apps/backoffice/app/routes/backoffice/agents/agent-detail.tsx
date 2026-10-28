import type { PiManagerAgent } from "@fragno-dev/backoffice-api/v0/pi";
import { PaneMessage } from "@fragno-private/design-system/pane-message";
import { useCallback, type ReactNode } from "react";
import { useOutletContext, type ShouldRevalidateFunctionArgs } from "react-router";

import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-detail";
import { AgentConversation, type PiAgentActionData } from "./agent-conversation";
import { isPiConversationSubmission } from "./agent-conversation-submission";
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
import {
  createSessionWorkspaceState,
  type SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";

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
  if (!loaderData.found) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AgentsHeader
          basePath={basePath}
          directory={directory}
          selectedAgentName={params.agentName}
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
          selectedAgentName={agent.agentName}
          options={null}
        />
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
          // Starting revalidates this route, which then shows the conversation.
          onStarted={() => undefined}
        />
      </div>
    );
  }
  // Agent-owned client state survives same-agent revalidation and resets on agent navigation.
  return <PiAgentDetailConversation key={agentPath} agent={agent} agentPath={agentPath} />;
}

function PiAgentDetailConversation({
  agent,
  agentPath,
}: {
  agent: PiManagerAgent;
  agentPath: string;
}) {
  const {
    resolvedScope,
    directory,
    availableModelOptions,
    basePath,
    dictationMountRoute,
    updateWorkspaceState,
    workspaceStates,
  } = useOutletContext<PiAgentsOutletContext>();
  const updateAgentWorkspaceState = useCallback(
    (update: SessionWorkspaceStateUpdate) => {
      updateWorkspaceState(agent.agentName, update);
    },
    [agent.agentName, updateWorkspaceState],
  );
  const header = (options: ReactNode | null) => (
    <AgentsHeader
      basePath={basePath}
      directory={directory}
      selectedAgentName={agent.agentName}
      options={
        options === null ? null : (
          <>
            <AgentPermissions
              permissions={agent.permissions}
              className="hidden max-w-72 truncate text-sm sm:block"
            />
            {options}
          </>
        )
      }
    />
  );

  return (
    <AgentConversation
      agent={agent}
      agentPath={agentPath}
      availableModelOptions={availableModelOptions}
      dictationMountRoute={dictationMountRoute}
      header={header}
      resolvedScope={resolvedScope}
      workspace={{
        storageKey: `backoffice:pi-agent-workspace:${basePath}`,
        state: workspaceStates[agent.agentName] ?? createSessionWorkspaceState(),
        update: updateAgentWorkspaceState,
      }}
    />
  );
}
