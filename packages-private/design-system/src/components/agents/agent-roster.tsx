import type { ReactNode } from "react";
import { Link } from "react-router";

import { SparkBars } from "../data/spark-bars";

/** One agent as the overview lists it. */
export type AgentRosterEntry = {
  agentName: string;
  /** The name people read, such as "Code Reviewer". */
  displayName: string;
  description: string;
  /** The agent's page. */
  to: string;
  /** Who keeps the agent, such as "Built in" or "Installed by package bookkeeping". */
  maintainer: string;
  /** Status lights, such as Answering or 2 queued; null when the agent is idle. */
  status: ReactNode;
  /** What it did last, such as "Answered 5 minutes ago", shown while it is idle. */
  activity: string;
  /** Turns it ended per hour over the last day; null when it ended none. */
  turns: { perBucket: readonly number[]; total: number } | null;
};

/**
 * A group of agents under its name, such as the assistants or a category. `description` says how
 * people reach the agents in it.
 */
export function AgentRosterSection({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-10 first:mt-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[color:var(--bo-border)] pb-2">
        <h3 className="text-base font-semibold text-balance text-[var(--bo-fg)]">{title}</h3>
        <span className="text-sm text-[var(--bo-muted-2)] tabular-nums">{count}</span>
        <p className="ml-auto text-xs text-pretty text-[var(--bo-muted)]">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Agents one per row, each the same: what it is, what it does, and what it is doing. A row opens
 * the agent.
 */
export function AgentRosterList({ entries }: { entries: readonly AgentRosterEntry[] }) {
  return (
    <ul className="@container/roster divide-y divide-[color:var(--bo-border)]">
      {entries.map((entry) => (
        <li key={entry.agentName}>
          <AgentRosterRow entry={entry} />
        </li>
      ))}
    </ul>
  );
}

function AgentRosterRow({ entry }: { entry: AgentRosterEntry }) {
  return (
    // The name's link covers the row, so the whole row opens the agent.
    <article className="group relative grid gap-x-6 gap-y-1 py-4 transition-colors duration-150 ease-out hover:bg-[var(--bo-panel-2)] @4xl/roster:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_17rem] @4xl/roster:items-center @4xl/roster:px-2">
      <div className="min-w-0">
        <h4 className="truncate text-sm font-semibold text-[var(--bo-fg)]">
          <Link
            to={entry.to}
            className="outline-none after:absolute after:inset-0 focus-visible:underline"
          >
            {entry.displayName}
          </Link>
        </h4>
        <p className="truncate text-xs text-[var(--bo-muted-2)]">{entry.maintainer}</p>
      </div>
      <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">{entry.description}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs @4xl/roster:flex-nowrap @4xl/roster:justify-end">
        {entry.status === null ? (
          <span title={entry.activity} className="min-w-0 truncate text-[var(--bo-muted)]">
            {entry.activity}
          </span>
        ) : (
          entry.status
        )}
        {entry.turns === null ? null : (
          <span
            className="shrink-0"
            title={`${entry.turns.total} ${entry.turns.total === 1 ? "turn" : "turns"} in the last 24 hours`}
          >
            <SparkBars
              values={entry.turns.perBucket}
              ariaLabel={`${entry.displayName}: ${entry.turns.total} turns in the last 24 hours`}
            />
          </span>
        )}
      </div>
    </article>
  );
}
