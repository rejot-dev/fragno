import { BackofficeTabHeader } from "@fragno-private/design-system/navigation/tab-header";
import { underlineTabClassName } from "@fragno-private/design-system/navigation/underline-tab-class-name";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { isPiAssistant } from "@/fragno/pi/agent/agent-definitions";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import type { PiAgentDirectoryState } from "./agent-types";

const OVERVIEW_TAB_ID = "all-agents";

/** Which of an agent's pages is open: its conversation or its profile. */
export type AgentPage = "conversation" | "profile";

/**
 * Every agents page shares one tab row, so switching agents never goes through the overview. It
 * holds the assistants, which people write to, and the agent that is open; the overview lists the
 * rest.
 */
export function AgentsHeader({
  basePath,
  directory,
  selected,
  options,
}: {
  basePath: string;
  /** Agent tabs appear once the directory is read. */
  directory: PiAgentDirectoryState;
  /** Null on the overview. */
  selected: { agentName: string; page: AgentPage } | null;
  options: ReactNode | null;
}) {
  const agentPath = (agentName: string) => `${basePath}/${encodeURIComponent(agentName)}`;
  const items = [
    {
      id: OVERVIEW_TAB_ID,
      label: "All agents",
      to: basePath,
      groupId: "overview",
      active: selected === null,
    },
    ...(directory.status === "ready" ? directory.agents : [])
      .filter(
        ({ definition }) =>
          isPiAssistant(definition) || definition.agentName === selected?.agentName,
      )
      .map(({ definition }) => ({
        id: definition.agentName,
        label: formatPiAgentName(definition.agentName),
        to: agentPath(definition.agentName),
        groupId: "agents",
        active: definition.agentName === selected?.agentName,
      })),
  ];

  return (
    <BackofficeTabHeader
      items={items}
      ariaLabel="Agents"
      trailing={null}
      options={
        selected === null && options === null ? null : (
          <>
            {options}
            {/* The page's own controls sit apart from the pages, which keep their place. */}
            {options === null || selected === null ? null : (
              <span aria-hidden className="h-5 w-px bg-[var(--bo-border)]" />
            )}
            {selected === null ? null : (
              <nav aria-label="Agent pages" className="flex items-center gap-1">
                <AgentPageLink
                  to={agentPath(selected.agentName)}
                  current={selected.page === "conversation"}
                >
                  Conversation
                </AgentPageLink>
                <AgentPageLink
                  to={`${agentPath(selected.agentName)}/profile`}
                  current={selected.page === "profile"}
                >
                  Profile
                </AgentPageLink>
              </nav>
            )}
          </>
        )
      }
    />
  );
}

function AgentPageLink({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={underlineTabClassName(current ? "selected" : "idle")}
    >
      {children}
    </Link>
  );
}
