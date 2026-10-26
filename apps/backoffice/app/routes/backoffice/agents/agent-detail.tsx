import type { PiManagerAgent } from "@fragno-dev/backoffice-api/v0/pi";
import { PaneMessage } from "@fragno-private/design-system/pane-message";
import { useCallback, type ReactNode } from "react";
import { useOutletContext, type ShouldRevalidateFunctionArgs } from "react-router";

import { renderPiAgentPrompt } from "@/fragno/pi/agent/pi-agent-attachments";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-detail";
import { readPiAgentAttachments } from "./agent-attachments.server";
import { AgentConversation, type PiAgentActionData } from "./agent-conversation";
import { isPiConversationSubmission } from "./agent-conversation-submission";
import { agentModelChoiceFromFormData } from "./agent-model-menu";
import { AgentPermissions } from "./agent-permissions";
import { AgentStartComposer } from "./agent-start-composer";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";
import {
  fetchPiManagerAgent,
  resumePiManagerAgent,
  resetPiManagerAgent,
  stopPiManagerAgent,
  submitPiManagerPrompt,
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
  if (intent !== "start" && intent !== "send") {
    return { ok: false, intent: "send", error: "Unsupported agent action." };
  }

  const content = formData.get("content");
  const text = typeof content === "string" ? content.trim() : "";
  const read = await readPiAgentAttachments({
    request,
    context,
    scope,
    agentName,
    field: formData.get("attachments"),
  });
  if ("error" in read) {
    return { ok: false, intent, error: read.error };
  }
  if (!text && read.attachments.length === 0) {
    return { ok: false, intent, error: "Write a message before sending." };
  }

  // Your message joins your own running turn at its next tool boundary; otherwise it waits in the
  // agent's queue for a turn of its own. Sending to a stopped agent resumes its queue.
  const result = await submitPiManagerPrompt(request, context, scope, agentName, {
    requestId: crypto.randomUUID(),
    content: renderPiAgentPrompt(text, read.attachments),
    whenBusy: "steer",
    whenPaused: "resume",
    model: agentModelChoiceFromFormData(formData),
  });
  return result.error === null
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
