import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { useClock } from "@/components/backoffice/use-clock";
import { useAutomationRead, useCurrentAutomationReplica } from "@/fragno/automation/lofi/replica";

import { dashboardBucketStarts } from "../dashboard/overview";
import type { PiAgentDirectoryState, PiAgentsOutletContext } from "./agent-types";
import {
  createSessionWorkspaceState,
  type SessionWorkspaceState,
  type SessionWorkspaceStateBySession,
  type SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";
import { SessionListSplit } from "./session-list-split";
import type { PiLayoutContext } from "./shared";

const CLOCK_TICK_MS = 60_000;

export function PiAgentsWorkspace({ layoutContext }: { layoutContext: PiLayoutContext }) {
  const { resolvedScope, availableModelOptions, usageLabel, dictationMountRoute } = layoutContext;
  const basePath = `/backoffice/agents/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
  )}/agents`;
  const directory = usePiAgentDirectory();
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
            resolvedScope,
            directory,
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

// Remembering the side panel keeps what the user opened in it across a refresh.
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

/** The scope's agents as its synchronized `pi` events record them. */
export function usePiAgentDirectory(): PiAgentDirectoryState {
  const { replica, caughtUp, error } = useCurrentAutomationReplica();
  const now = useClock(CLOCK_TICK_MS);
  // Every moment of an hour has that hour's window, so the read only reopens when one begins.
  const hourStart = dashboardBucketStarts(now).at(-1) ?? now;
  const bucketStarts = useMemo(() => dashboardBucketStarts(hourStart), [hourStart]);
  const directory = useAutomationRead(replica, "piAgentDirectory", { bucketStarts });
  if (error !== null) {
    return { status: "unavailable", message: error };
  }
  if (directory.status === "error") {
    return { status: "unavailable", message: "Agent events could not be read." };
  }
  // Until the replica first catches up, it may lack agents and turns.
  if (directory.status === "loading" || !caughtUp) {
    return { status: "loading" };
  }
  return { status: "ready", agents: directory.data, now };
}
