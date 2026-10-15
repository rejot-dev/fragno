import type { PiManagerAgent } from "@fragno-dev/backoffice-api/v0/pi";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
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

  return <BackofficeTabHeader items={items} ariaLabel="Agents" options={options} />;
}
