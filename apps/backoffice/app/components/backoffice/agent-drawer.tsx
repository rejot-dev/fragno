import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import {
  SIDE_DRAWER_MIN_WIDTH,
  SideDrawer,
} from "@fragno-private/design-system/overlays/side-drawer";
import { lazy, Suspense, useState } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";
import { piAgentsPath } from "@/routes/backoffice/agents/path";

import { AgentDrawerHeader } from "./agent-drawer-header";
import type { AgentRequest } from "./ask-agent";

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

// Phones keep their own width: the page beside the drawer has little room to give.
const AGENT_DRAWER_SIZES = {
  desktop: { defaultWidth: 520, storageKey: "backoffice:agent-drawer-width" },
  phone: { defaultWidth: SIDE_DRAWER_MIN_WIDTH, storageKey: "backoffice:phone-agent-drawer-width" },
} as const;

/** A conversation with one of the scope's agents beside every page, starting with the main agent. */
export function AgentDrawer({
  open,
  screen,
  request,
  halfScreenRequest,
  resolvedScope,
  onClose,
}: {
  open: boolean;
  screen: "desktop" | "phone";
  /** What a page last asked of the drawer, which it opens on. */
  request: AgentRequest | null;
  /** Changes with each request to open over half the screen; null until the first. */
  halfScreenRequest: number | null;
  /** Null where the page has no scope to hold agents. */
  resolvedScope: BackofficeResolvedScope | null;
  onClose: () => void;
}) {
  // The choice belongs to the scope it was made in, until a page asks for an agent; another scope
  // starts with its main agent.
  const [selection, setSelection] = useState<{
    agentsPath: string;
    requestId: number | null;
    agentName: string;
  } | null>(null);
  const agentsPath = resolvedScope
    ? piAgentsPath(backofficeRouteScopeFromResolvedScope(resolvedScope))
    : null;
  const [filledDraftId, setFilledDraftId] = useState<number | null>(null);
  const scopeRequest = request?.agentsPath === agentsPath ? request : null;
  const requestId = scopeRequest?.id ?? null;
  const agentName =
    selection?.agentsPath === agentsPath && selection.requestId === requestId
      ? selection.agentName
      : (scopeRequest?.agentName ?? MAIN_PI_AGENT_NAME);

  return (
    <SideDrawer
      id={AGENT_DRAWER_ID}
      label="Agent conversation"
      open={open}
      defaultWidth={AGENT_DRAWER_SIZES[screen].defaultWidth}
      storageKey={AGENT_DRAWER_SIZES[screen].storageKey}
      halfScreenRequest={halfScreenRequest}
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
            screen={screen}
            draft={
              scopeRequest !== null &&
              scopeRequest.text !== null &&
              scopeRequest.agentName === agentName &&
              scopeRequest.id !== filledDraftId
                ? {
                    text: scopeRequest.text,
                    onFilled: () => {
                      setFilledDraftId(scopeRequest.id);
                    },
                  }
                : null
            }
            onAgentChange={(nextAgentName) => {
              setSelection({ agentsPath, requestId, agentName: nextAgentName });
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
