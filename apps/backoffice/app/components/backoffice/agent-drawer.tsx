import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { SideDrawer } from "@fragno-private/design-system/overlays/side-drawer";
import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";
import {
  isPiAgentPagePath,
  PI_AGENT_CONVERSATION_TRANSITION,
  piAgentsPath,
} from "@/routes/backoffice/agents/path";

import { AgentDrawerHeader } from "./agent-drawer-header";

export const AGENT_DRAWER_ID = "agent-drawer";

// The conversation is imported on its own, so the server, which renders the drawer closed, never
// loads the chat.
const loadAgentDrawerScope = () => import("./agent-drawer-scope");
const AgentDrawerScope = lazy(async () => ({
  default: (await loadAgentDrawerScope()).AgentDrawerScope,
}));

/**
 * Starts loading the conversation when the user reaches for the drawer. Its ~1 MB of chat, Markdown,
 * and diagram code would otherwise compete with every page's first interactions.
 */
export function preloadAgentDrawer() {
  void loadAgentDrawerScope();
}

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
  // Expanding opens the agent's page in a view transition. The drawer closes in the same render
  // the page arrives in, so its conversation grows into the page's instead of staying beside it.
  const location = useLocation();
  const [expandingTo, setExpandingTo] = useState<string | null>(null);
  const expanded = expandingTo !== null && isPiAgentPagePath(expandingTo, location.pathname);
  useEffect(() => {
    if (expanded) {
      setExpandingTo(null);
      onClose();
    }
  }, [expanded, onClose]);

  return (
    <SideDrawer
      id={AGENT_DRAWER_ID}
      label="Agent conversation"
      open={open && !expanded}
      storageKey="backoffice:agent-drawer-width"
    >
      {resolvedScope && agentsPath ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{ viewTransitionName: PI_AGENT_CONVERSATION_TRANSITION }}
        >
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
              onExpand={setExpandingTo}
              onClose={onClose}
            />
          </Suspense>
        </div>
      ) : (
        <>
          <AgentDrawerHeader options={null} onClose={onClose} />
          <PaneMessage tone="muted">Agents are unavailable on this page.</PaneMessage>
        </>
      )}
    </SideDrawer>
  );
}
