import { useCallback, useState } from "react";
import { Outlet } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

import type { PiAgentsOutletContext } from "./agent-types";
import type { PiManagerAgentsResult } from "./data";
import {
  updateSessionWorkspaceStateBySession,
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
  const { resolvedScope, availableModelOptions, billingOrganization, dictationMountRoute } =
    layoutContext;
  const basePath = `/backoffice/agents/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
  )}/agents`;
  const [workspaceStates, setWorkspaceStates] = useState<SessionWorkspaceStateBySession>({});
  const updateWorkspaceState = useCallback(
    (agentName: string, update: SessionWorkspaceStateUpdate) => {
      setWorkspaceStates((current) =>
        updateSessionWorkspaceStateBySession(current, agentName, update),
      );
    },
    [],
  );

  return (
    <SessionListSplit>
      <Outlet
        context={
          {
            ...directory,
            resolvedScope,
            availableModelOptions,
            billingOrganization,
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
