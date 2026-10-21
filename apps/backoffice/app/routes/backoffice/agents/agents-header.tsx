import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import type { ReactNode } from "react";

import { formatPiAgentName } from "./agent-name";
import type { PiAgentDirectoryState } from "./agent-types";

const OVERVIEW_TAB_ID = "all-agents";

/** Every agents page shares one tab row, so switching agents never goes through the overview. */
export function AgentsHeader({
  basePath,
  directory,
  selectedAgentName,
  options,
}: {
  basePath: string;
  /** Agent tabs appear once the directory is read. */
  directory: PiAgentDirectoryState;
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
    ...(directory.status === "ready" ? directory.agents : []).map(({ definition }) => ({
      id: definition.agentName,
      label: formatPiAgentName(definition.agentName),
      to: `${basePath}/${encodeURIComponent(definition.agentName)}`,
      groupId: "agents",
      active: definition.agentName === selectedAgentName,
    })),
  ];

  return <BackofficeTabHeader items={items} ariaLabel="Agents" options={options} />;
}
