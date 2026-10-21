import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

import type { PiAgentsOutletContext } from "./agent-types";
import type { PiManagerAgentsResult } from "./data";
import {
  createSessionWorkspaceState,
  type SessionWorkspaceState,
  type SessionWorkspaceStateBySession,
  type SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";
import { SessionListSplit } from "./session-list-split";
import type { PiLayoutContext } from "./shared";

export function PiAgentsWorkspace({
  layoutContext,
  directory,
}: {
  layoutContext: PiLayoutContext;
  directory: PiManagerAgentsResult;
}) {
  const { resolvedScope, availableModelOptions, usageLabel, dictationMountRoute } = layoutContext;
  const basePath = `/backoffice/agents/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
  )}/agents`;
  const [workspaceStates, setWorkspaceStates] = useState<SessionWorkspaceStateBySession>({});
  // Updates only run in effects and event handlers, so the stored state is restored on the client
  // without diverging from the server-rendered markup.
  const updateWorkspaceState = useCallback(
    (agentName: string, update: SessionWorkspaceStateUpdate) => {
      setWorkspaceStates((states) => {
        const current =
          states[agentName] ??
          readStoredWorkspaceState(basePath, agentName) ??
          createSessionWorkspaceState();
        const next = update(current);
        return next === states[agentName] ? states : { ...states, [agentName]: next };
      });
    },
    [basePath],
  );

  useEffect(() => {
    for (const [agentName, state] of Object.entries(workspaceStates)) {
      writeStoredWorkspaceState(basePath, agentName, state);
    }
  }, [basePath, workspaceStates]);

  return (
    <SessionListSplit>
      <Outlet
        context={
          {
            ...directory,
            resolvedScope,
            availableModelOptions,
            usageLabel,
            dictationMountRoute,
            basePath,
            workspaceStates,
            updateWorkspaceState,
          } satisfies PiAgentsOutletContext
        }
      />
    </SessionListSplit>
  );
}

// Remembering observed items keeps a refresh from auto-opening a workflow graph the user closed.
function workspaceStateStorageKey(basePath: string, agentName: string) {
  return `fragno-backoffice-agent-workspace:${basePath}/${agentName}`;
}

function readStoredWorkspaceState(
  basePath: string,
  agentName: string,
): SessionWorkspaceState | null {
  const raw = window.localStorage.getItem(workspaceStateStorageKey(basePath, agentName));
  return raw ? (JSON.parse(raw) as SessionWorkspaceState) : null;
}

function writeStoredWorkspaceState(
  basePath: string,
  agentName: string,
  state: SessionWorkspaceState,
) {
  window.localStorage.setItem(workspaceStateStorageKey(basePath, agentName), JSON.stringify(state));
}
