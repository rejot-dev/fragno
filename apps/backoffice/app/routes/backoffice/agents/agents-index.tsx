import {
  AgentRosterList,
  AgentRosterSection,
  type AgentRosterEntry,
} from "@fragno-private/design-system/agents/agent-roster";
import { PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { useOutletContext } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import { describePiAgentActivity, piAgentQueueStatus, type PiAgentListing } from "./agent-activity";
import { describePiAgentSteward } from "./agent-labels";
import type { PiAgentsOutletContext } from "./agent-types";
import { AgentsHeader } from "./agents-header";

export default function BackofficePiAgentsIndex() {
  const { directory, basePath } = useOutletContext<PiAgentsOutletContext>();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <AgentsHeader basePath={basePath} directory={directory} selected={null} options={null} />
      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={`${backofficePageBodyClassName} flex flex-col`}>
          <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)]">
            Agents
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Write to an assistant. Agents in other groups take their work from assistants,
            workflows, and each other. Marketplace packages install agents, and the assistant can
            define new ones for you.
          </p>

          <div className="mt-10">
            {directory.status === "ready" ? (
              <AgentRoster agents={directory.agents} now={directory.now} basePath={basePath} />
            ) : directory.status === "loading" ? (
              <PaneSpinner label="Synchronizing agents" />
            ) : (
              <BackofficeSystemState
                tone="error"
                label="Unavailable"
                title="Agents could not be synchronized."
                description={directory.message}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Assistants first, then each category by name. */
function AgentRoster({
  agents,
  now,
  basePath,
}: {
  agents: readonly PiAgentListing[];
  now: number;
  basePath: string;
}) {
  const assistants: AgentRosterEntry[] = [];
  const categories = new Map<string, AgentRosterEntry[]>();
  for (const agent of agents) {
    const { category } = agent.definition;
    const entry = rosterEntry(agent, now, basePath);
    if (category === null) {
      assistants.push(entry);
    } else {
      categories.set(category, [...(categories.get(category) ?? []), entry]);
    }
  }
  return (
    <>
      <AgentRosterSection
        title="Assistants"
        description="Write to these in Leyway."
        count={assistants.length}
      >
        <AgentRosterList entries={assistants} />
      </AgentRosterSection>
      {[...categories]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, entries]) => (
          <AgentRosterSection
            key={category}
            title={category}
            description="Prompted by agents and workflows."
            count={entries.length}
          >
            <AgentRosterList entries={entries} />
          </AgentRosterSection>
        ))}
    </>
  );
}

function rosterEntry(agent: PiAgentListing, now: number, basePath: string): AgentRosterEntry {
  const { definition } = agent;
  const to = `${basePath}/${encodeURIComponent(definition.agentName)}`;
  const queue = piAgentQueueStatus(agent);
  const turns = agent.turnsPerBucket.reduce((total, count) => total + count, 0);
  const status =
    agent.answering || agent.paused || queue ? (
      <>
        {agent.answering ? (
          <BackofficeStatusLight tone="live" role="status">
            Answering
          </BackofficeStatusLight>
        ) : agent.paused ? (
          <BackofficeStatusLight tone="waiting" role="status">
            Stopped
          </BackofficeStatusLight>
        ) : null}
        {queue ? (
          <BackofficeStatusLight tone={queue.tone} dot={false} role="status">
            {queue.label}
          </BackofficeStatusLight>
        ) : null}
      </>
    ) : null;
  return {
    agentName: definition.agentName,
    displayName: formatPiAgentName(definition.agentName),
    description: definition.description,
    to,
    maintainer: describePiAgentSteward(definition.steward),
    status,
    activity: describePiAgentActivity(agent, now),
    turns: turns === 0 ? null : { perBucket: agent.turnsPerBucket, total: turns },
  };
}
