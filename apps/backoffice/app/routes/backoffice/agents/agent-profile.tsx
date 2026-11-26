import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { useMarkdownText } from "@fragno-private/backoffice-ui/markdown-text";
import { AgentProfile } from "@fragno-private/design-system/agents/agent-profile";
import { AgentSkillList } from "@fragno-private/design-system/agents/agent-skill-list";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { useEffect, useRef } from "react";
import { useOutletContext, useRevalidator } from "react-router";

import { useShowAgentBeside } from "@/components/backoffice/ask-agent";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { piDefinedAgentModel } from "@/fragno/pi/agent/agent-definitions";
import type { PiAvailableModel } from "@/fragno/pi/agent/pi-agent-contract";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-profile";
import { describePiAgentSteward } from "./agent-labels";
import { fetchPiAgentSkills } from "./agent-profile.server";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiAgentSkills(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
}

/**
 * The profile follows the agent's definition in the synchronized directory, so a change the
 * assistant makes shows as it lands. Only its skills come from the loader, which reads files.
 */
export default function BackofficePiAgentProfile({ loaderData, params }: Route.ComponentProps) {
  const { directory, basePath, availableModelOptions } = useOutletContext<PiAgentsOutletContext>();
  const MarkdownText = useMarkdownText();
  const agent =
    directory.status === "ready"
      ? (directory.agents.find(({ agentName }) => agentName === params.agentName)?.definition ??
        null)
      : null;
  useRelistSkills(params.agentName, directory.status === "ready" ? { agent } : null);
  // On phones that keep the agent beside the page, the agent's conversation shows there, beside
  // its profile.
  const showAgentBeside = useShowAgentBeside();
  useEffect(() => {
    showAgentBeside?.(params.agentName);
  }, [showAgentBeside, params.agentName]);
  const header = (
    <AgentsHeader
      basePath={basePath}
      directory={directory}
      selected={{ agentName: params.agentName, page: "profile" }}
      options={null}
    />
  );
  if (directory.status !== "ready" || agent === null) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {header}
        {directory.status === "loading" ? (
          <PaneSpinner label="Synchronizing agents" />
        ) : (
          <PaneMessage tone="failed">
            {directory.status === "unavailable"
              ? directory.message
              : `${formatPiAgentName(params.agentName)} is not an agent in this scope.`}
          </PaneMessage>
        )}
      </div>
    );
  }
  const builtIn = agent.steward.kind === "backoffice";
  const model = builtIn ? null : piAgentModel(agent, availableModelOptions);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {header}
      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={backofficePageBodyClassName}>
          <AgentProfile
            displayName={formatPiAgentName(agent.agentName)}
            description={agent.description}
            category={agent.category}
            maintainer={describePiAgentSteward(agent.steward)}
            model={model ?? "Chosen with each message"}
            reasoning={
              builtIn
                ? "Chosen with each message"
                : agent.thinkingLevel[0].toUpperCase() + agent.thinkingLevel.slice(1)
            }
            permissions={agent.permissions}
            instructions={
              agent.instructions.trim() === "" ? null : <MarkdownText text={agent.instructions} />
            }
            skills={
              loaderData.listed ? (
                <AgentSkillList
                  skills={loaderData.skills.skills}
                  problems={loaderData.skills.problems}
                />
              ) : (
                <p className="text-sm text-[var(--bo-muted)]">{loaderData.message}</p>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Lists the agent's skills again when its synchronized definition changes which ones it finds, as
 * when the assistant disables one, or when the agent is defined or removed. The loader already
 * lists them for each agent the page opens, and the directory synchronizing adds nothing to that.
 */
function useRelistSkills(
  agentName: string,
  synchronized: { agent: PiAgentDefinition | null } | null,
) {
  const revalidator = useRevalidator();
  const selection =
    synchronized === null
      ? null
      : JSON.stringify(
          synchronized.agent && [synchronized.agent.skills, synchronized.agent.disabledSkills],
        );
  const listed = useRef({ agentName, selection });
  useEffect(() => {
    const previous = listed.current;
    listed.current = { agentName, selection };
    if (
      previous.agentName === agentName &&
      previous.selection !== null &&
      previous.selection !== selection
    ) {
      void revalidator.revalidate();
    }
  }, [agentName, selection, revalidator]);
}

/** The model a defined agent runs, by its label, or why it runs none. */
function piAgentModel(agent: PiAgentDefinition, availableModels: readonly PiAvailableModel[]) {
  const model = piDefinedAgentModel(agent, availableModels);
  if (model === null) {
    return `${agent.model ?? "No model"} (unavailable)`;
  }
  return agent.model === null ? `${model.label} (preferred)` : model.label;
}
