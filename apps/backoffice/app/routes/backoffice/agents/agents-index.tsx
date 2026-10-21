import { SparkBars } from "@fragno-private/design-system/spark-bars";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Link, useOutletContext } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";

import { describePiAgentActivity, piAgentQueueStatus, type PiAgentListing } from "./agent-activity";
import { formatPiAgentName } from "./agent-name";
import { AgentPermissions } from "./agent-permissions";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";

export default function BackofficePiAgentsIndex() {
  const { directory, basePath } = useOutletContext<PiAgentsOutletContext>();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <AgentsHeader
        basePath={basePath}
        directory={directory}
        selectedAgentName={null}
        options={null}
      />
      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={`${backofficePageBodyClassName} flex flex-col`}>
          <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)]">
            Agents
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Each agent keeps one ongoing conversation with its own instructions and permissions.
            Marketplace packages install agents, and the assistant can define new ones for you.
          </p>

          {directory.status === "ready" ? (
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {directory.agents.map((agent) => (
                <li key={agent.definition.agentName} className="flex">
                  <AgentCard
                    agent={agent}
                    now={directory.now}
                    to={`${basePath}/${encodeURIComponent(agent.definition.agentName)}`}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-8">
              {directory.status === "loading" ? (
                <BackofficeSystemState
                  tone="loading"
                  label="Synchronizing"
                  title="Synchronizing agents…"
                />
              ) : (
                <BackofficeSystemState
                  tone="error"
                  label="Unavailable"
                  title="Agents could not be synchronized."
                  description={directory.message}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentCard({
  agent: { definition, activity },
  now,
  to,
}: {
  agent: PiAgentListing;
  now: number;
  to: string;
}) {
  const queue = piAgentQueueStatus(activity);
  return (
    <Link
      to={to}
      className="group flex min-h-56 w-full flex-col bg-[var(--bo-panel)] p-6 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.98]"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="min-w-0 text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] transition-colors duration-150 ease-out group-hover:text-[var(--bo-accent-fg)]">
          {formatPiAgentName(definition.agentName)}
        </h3>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          {activity?.answering ? (
            <BackofficeStatusLight tone="live" role="status">
              Answering
            </BackofficeStatusLight>
          ) : activity?.paused ? (
            <BackofficeStatusLight tone="waiting" role="status">
              Stopped
            </BackofficeStatusLight>
          ) : null}
          {queue ? (
            <BackofficeStatusLight tone={queue.tone} dot={false} role="status">
              {queue.label}
            </BackofficeStatusLight>
          ) : null}
        </span>
      </div>
      <p className="mt-3 line-clamp-4 flex-1 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
        {definition.description}
      </p>
      <AgentPermissions
        permissions={definition.permissions}
        className="mt-4 line-clamp-2 font-mono text-xs break-words"
      />
      <div className="mt-4 flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-[var(--bo-muted)]">
          {describePiAgentActivity(activity, now)}
        </span>
        {activity ? (
          <span className="flex shrink-0 items-center gap-2 text-[var(--bo-muted-2)] tabular-nums">
            <SparkBars
              values={activity.turnsPerBucket}
              ariaLabel={`${formatPiAgentName(definition.agentName)} turns over the last 24 hours`}
            />
            {activity.turns} {activity.turns === 1 ? "turn" : "turns"} · 24h
          </span>
        ) : null}
      </div>
      <p className="mt-6 border-t border-[color:var(--bo-border)] pt-4 text-xs text-[var(--bo-muted-2)]">
        {definition.managedBy?.kind === "built-in"
          ? "Built in"
          : definition.managedBy?.kind === "marketplace"
            ? "Installed by a Marketplace package"
            : "Defined in this workspace"}
      </p>
    </Link>
  );
}
