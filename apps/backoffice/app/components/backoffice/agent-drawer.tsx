import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import {
  SIDE_DRAWER_MIN_WIDTH,
  SideDrawer,
} from "@fragno-private/design-system/overlays/side-drawer";
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
import type { AgentDraft, AgentRequest } from "./ask-agent";

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
  draft,
  halfScreenRequest,
  resolvedScope,
  onClose,
}: {
  open: boolean;
  screen: "desktop" | "phone";
  /** The agent a page last asked for, which the drawer opens on. */
  request: AgentRequest | null;
  /** What a page last asked an agent, for its composer. */
  draft: AgentDraft | null;
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
  const scopeDraft = draft?.agentsPath === agentsPath ? draft : null;
  const scopeRequest = request?.agentsPath === agentsPath ? request : null;
  const requestId = scopeRequest?.id ?? null;
  const agentName =
    selection?.agentsPath === agentsPath && selection.requestId === requestId
      ? selection.agentName
      : (scopeRequest?.agentName ?? MAIN_PI_AGENT_NAME);
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
      defaultWidth={AGENT_DRAWER_SIZES[screen].defaultWidth}
      storageKey={AGENT_DRAWER_SIZES[screen].storageKey}
      halfScreenRequest={halfScreenRequest}
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
              screen={screen}
              draft={
                scopeDraft !== null &&
                scopeDraft.agentName === agentName &&
                scopeDraft.id !== filledDraftId
                  ? {
                      text: scopeDraft.text,
                      onFilled: () => {
                        setFilledDraftId(scopeDraft.id);
                      },
                    }
                  : null
              }
              onAgentChange={(nextAgentName) => {
                setSelection({ agentsPath, requestId, agentName: nextAgentName });
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
