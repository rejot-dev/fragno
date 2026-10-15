import type { PiManagerAgent } from "@fragno-dev/backoffice-api/v0/pi";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { Link, useOutletContext } from "react-router";

import { formatPiAgentName } from "./agent-name";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";

export default function BackofficePiAgentsIndex() {
  const { agents, agentsError, basePath } = useOutletContext<PiAgentsOutletContext>();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <AgentsHeader basePath={basePath} agents={agents} selectedAgentName={null} options={null} />
      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-8 sm:px-8 sm:py-10">
          <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)]">
            Agents
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Each agent keeps one ongoing conversation with its own instructions and permissions.
            Marketplace packages install agents, and the assistant can define new ones for you.
          </p>

          {agentsError ? (
            <p className="mt-6 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-sm text-pretty text-[var(--bo-failed)]">
              {agentsError}
            </p>
          ) : null}

          <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <li key={agent.agentName} className="flex">
                <AgentCard
                  agent={agent}
                  to={`${basePath}/${encodeURIComponent(agent.agentName)}`}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent, to }: { agent: PiManagerAgent; to: string }) {
  return (
    <Link
      to={to}
      className="group flex min-h-56 w-full flex-col bg-[var(--bo-panel)] p-6 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.98]"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="min-w-0 text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] transition-colors duration-150 ease-out group-hover:text-[var(--bo-accent-fg)]">
          {formatPiAgentName(agent.agentName)}
        </h3>
        {agent.provisioning ? (
          <BackofficeStatusLight tone="live">Active</BackofficeStatusLight>
        ) : (
          <BackofficeStatusLight tone="muted">Not started</BackofficeStatusLight>
        )}
      </div>
      <p className="mt-3 line-clamp-4 flex-1 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
        {agent.description}
      </p>
      <p className="mt-6 border-t border-[color:var(--bo-border)] pt-4 text-xs text-[var(--bo-muted-2)]">
        {agent.managedBy?.kind === "built-in"
          ? "Built in"
          : agent.managedBy?.kind === "marketplace"
            ? "Installed by a Marketplace package"
            : "Defined in this workspace"}
      </p>
    </Link>
  );
}
