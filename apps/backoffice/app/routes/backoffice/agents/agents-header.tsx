import type { PiManagerAgent } from "@fragno-dev/backoffice-api/v0/pi";
import { OverflowTabRow } from "@fragno-private/design-system/overflow-tab-row";
import type { ReactNode } from "react";

import { formatPiAgentName } from "./agent-name";

const OVERVIEW_TAB_ID = "all-agents";

/** Every agents page shares one tab row, so switching agents never goes through the overview. */
export function AgentsHeader({
  basePath,
  agents,
  selectedAgentName,
  options,
}: {
  basePath: string;
  agents: readonly PiManagerAgent[];
  /** Null on the overview. */
  selectedAgentName: string | null;
  options: ReactNode | null;
}) {
  const items = [
    {
      id: OVERVIEW_TAB_ID,
      label: "All agents",
      to: basePath,
      groupId: "overview",
      active: selectedAgentName === null,
    },
    ...agents.map((agent) => ({
      id: agent.agentName,
      label: formatPiAgentName(agent.agentName),
      to: `${basePath}/${encodeURIComponent(agent.agentName)}`,
      groupId: "agents",
      active: agent.agentName === selectedAgentName,
    })),
  ];

  return (
    <header className="flex h-16 flex-none items-end gap-3 border-b border-[color:var(--bo-border)] px-3 sm:px-5">
      {/* Tabs sit on the bottom edge so the selected underline lands on the header divider. */}
      <div className="-mb-px min-w-0 flex-1">
        <OverflowTabRow items={items} ariaLabel="Agents" variant="underline" />
      </div>
      {options ? (
        <div className="flex shrink-0 items-center gap-2 self-center sm:gap-3">{options}</div>
      ) : null}
    </header>
  );
}
