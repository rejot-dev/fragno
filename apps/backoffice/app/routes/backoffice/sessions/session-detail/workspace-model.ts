import type { BackofficeUiResultV1 } from "@/backoffice-ui/result";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import type { WorkflowGraphProjection } from "./workflow-graph-projection";

export type GeneratedUiWorkspaceView = {
  type: "generated-ui";
  result: BackofficeUiResultV1;
  rawValue: unknown;
};

export type WorkflowGraphWorkspaceView = {
  type: "workflow-graph";
  projection: WorkflowGraphProjection;
  run: WorkflowRunReference | null;
};

export type SessionWorkspaceItem = {
  id: string;
  toolCallId: string;
  label: string;
  view: GeneratedUiWorkspaceView | WorkflowGraphWorkspaceView;
};

export type SessionWorkspaceState = {
  open: boolean;
  selectedItemId: string | null;
  observedItemIds?: readonly string[];
};

export type SessionWorkspaceStateBySession = Readonly<Record<string, SessionWorkspaceState>>;
export type SessionWorkspaceStateUpdate = (current: SessionWorkspaceState) => SessionWorkspaceState;

export const generatedUiWorkspaceId = (toolCallId: string) => `generated-ui:${toolCallId}`;
export const workflowGraphWorkspaceId = (toolCallId: string) => `workflow-graph:${toolCallId}`;

export function createSessionWorkspaceState(): SessionWorkspaceState {
  return {
    open: false,
    selectedItemId: null,
  };
}

export function updateSessionWorkspaceStateBySession(
  states: SessionWorkspaceStateBySession,
  sessionKey: string,
  update: SessionWorkspaceStateUpdate,
): SessionWorkspaceStateBySession {
  const current = states[sessionKey] ?? createSessionWorkspaceState();
  const next = update(current);

  return next === current ? states : { ...states, [sessionKey]: next };
}

export function autoOpenNewWorkflowWorkspaceItem(
  state: SessionWorkspaceState,
  items: readonly SessionWorkspaceItem[],
): SessionWorkspaceState {
  const observedItemIds = new Set(state.observedItemIds ?? []);
  let newestWorkflowItem: SessionWorkspaceItem | undefined;
  let discoveredItem = false;

  for (const item of items) {
    if (observedItemIds.has(item.id)) {
      continue;
    }
    observedItemIds.add(item.id);
    discoveredItem = true;
    if (item.view.type === "workflow-graph") {
      newestWorkflowItem = item;
    }
  }

  if (!discoveredItem) {
    return state;
  }

  return {
    ...state,
    observedItemIds: [...observedItemIds],
    ...(newestWorkflowItem ? { open: true, selectedItemId: newestWorkflowItem.id } : {}),
  };
}

export function toggleSessionWorkspaceItem(
  state: SessionWorkspaceState,
  itemId: string,
): SessionWorkspaceState {
  if (state.open && state.selectedItemId === itemId) {
    return { ...state, open: false };
  }

  return {
    ...state,
    open: true,
    selectedItemId: itemId,
  };
}
