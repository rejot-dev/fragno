import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/pane-message";
import { SideDrawer } from "@fragno-private/design-system/side-drawer";
import { lazy, Suspense, useEffect, useState } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";
import { piAgentsPath } from "@/routes/backoffice/agents/path";

import { AgentDrawerHeader } from "./agent-drawer-header";

export const AGENT_DRAWER_ID = "agent-drawer";

// The conversation is imported on its own, so the server, which renders the drawer closed, never
// loads the chat. Browsers load it once the page is idle, so the drawer opens without waiting.
const loadAgentDrawerScope = () => import("./agent-drawer-scope");
const AgentDrawerScope = lazy(async () => ({
  default: (await loadAgentDrawerScope()).AgentDrawerScope,
}));

/** A conversation with one of the scope's agents beside every page, starting with the main agent. */
export function AgentDrawer({
  open,
  resolvedScope,
  onClose,
}: {
  open: boolean;
  /** Null where the page has no scope to hold agents. */
  resolvedScope: BackofficeResolvedScope | null;
  onClose: () => void;
}) {
  // The choice belongs to the scope it was made in; another scope starts with its main agent.
  const [selection, setSelection] = useState<{ agentsPath: string; agentName: string } | null>(
    null,
  );
  const agentsPath = resolvedScope
    ? piAgentsPath(backofficeRouteScopeFromResolvedScope(resolvedScope))
    : null;
  const agentName = selection?.agentsPath === agentsPath ? selection.agentName : MAIN_PI_AGENT_NAME;

  useEffect(() => {
    const prefetch = () => void loadAgentDrawerScope();
    if (typeof window.requestIdleCallback !== "function") {
      const timeout = window.setTimeout(prefetch, 1000);
      return () => {
        window.clearTimeout(timeout);
      };
    }
    const idle = window.requestIdleCallback(prefetch);
    return () => {
      window.cancelIdleCallback(idle);
    };
  }, []);

  return (
    <SideDrawer
      id={AGENT_DRAWER_ID}
      label="Agent conversation"
      open={open}
      storageKey="backoffice:agent-drawer-width"
    >
      {resolvedScope && agentsPath ? (
        <Suspense
          fallback={
            <>
              <AgentDrawerHeader options={null} onClose={onClose} />
              <PaneSpinner label="Loading agent" />
            </>
          }
        >
          <AgentDrawerScope
            key={`${agentsPath}/${agentName}`}
            open={open}
            resolvedScope={resolvedScope}
            agentsPath={agentsPath}
            agentName={agentName}
            onAgentChange={(nextAgentName) => {
              setSelection({ agentsPath, agentName: nextAgentName });
            }}
            onClose={onClose}
          />
        </Suspense>
      ) : (
        <>
          <AgentDrawerHeader options={null} onClose={onClose} />
          <PaneMessage tone="muted">Agents are unavailable on this page.</PaneMessage>
        </>
      )}
    </SideDrawer>
  );
}
