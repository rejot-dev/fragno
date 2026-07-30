import type { BackofficeUiResultV1 } from "@/backoffice-ui/result";

import type { WorkflowGraphProjection } from "./workflow-graph-projection";

export type GeneratedUiWorkspaceView = {
  type: "generated-ui";
  result: BackofficeUiResultV1;
  rawValue: unknown;
};

export type WorkflowGraphWorkspaceView = {
  type: "workflow-graph";
  projection: WorkflowGraphProjection;
};

export type SessionWorkspaceTab = {
  id: string;
  toolCallId: string;
  label: string;
  view: GeneratedUiWorkspaceView | WorkflowGraphWorkspaceView;
};

export type SessionWorkspaceState = {
  open: boolean;
  selectedTabId: string | null;
  knownTabIds: string[];
};

export const generatedUiTabId = (toolCallId: string) => `generated-ui:${toolCallId}`;
export const workflowGraphTabId = (toolCallId: string) => `workflow-graph:${toolCallId}`;

export function createSessionWorkspaceState(
  tabs: readonly SessionWorkspaceTab[],
): SessionWorkspaceState {
  return {
    open: tabs.length > 0,
    selectedTabId: tabs.at(-1)?.id ?? null,
    knownTabIds: tabs.map((tab) => tab.id),
  };
}

export function reconcileSessionWorkspaceState(
  state: SessionWorkspaceState,
  tabs: readonly SessionWorkspaceTab[],
): SessionWorkspaceState {
  const previouslyKnownTabIds = new Set(state.knownTabIds);
  const knownTabIds = [...state.knownTabIds];
  let newestTab: SessionWorkspaceTab | undefined;

  for (const tab of tabs) {
    if (previouslyKnownTabIds.has(tab.id)) {
      continue;
    }
    previouslyKnownTabIds.add(tab.id);
    knownTabIds.push(tab.id);
    newestTab = tab;
  }

  const selectedTabStillExists = tabs.some((tab) => tab.id === state.selectedTabId);
  const nextState: SessionWorkspaceState = newestTab
    ? {
        open: true,
        selectedTabId: newestTab.id,
        knownTabIds,
      }
    : {
        open: state.open,
        selectedTabId: selectedTabStillExists
          ? state.selectedTabId
          : (tabs.at(-1)?.id ?? state.selectedTabId),
        knownTabIds,
      };

  return sessionWorkspaceStatesEqual(state, nextState) ? state : nextState;
}

function sessionWorkspaceStatesEqual(
  current: SessionWorkspaceState,
  next: SessionWorkspaceState,
): boolean {
  return (
    current.open === next.open &&
    current.selectedTabId === next.selectedTabId &&
    current.knownTabIds.length === next.knownTabIds.length &&
    current.knownTabIds.every((tabId, index) => tabId === next.knownTabIds[index])
  );
}
