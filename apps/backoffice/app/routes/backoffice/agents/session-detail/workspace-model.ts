import type { BackofficeUiResultV1 } from "@fragno-private/backoffice-ui/result";

export type GeneratedUiWorkspaceView = {
  type: "generated-ui";
  result: BackofficeUiResultV1;
  rawValue: unknown;
};

export type SessionWorkspaceItem = {
  id: string;
  toolCallId: string;
  label: string;
  view: GeneratedUiWorkspaceView;
};

export type SessionWorkspaceState = {
  open: boolean;
  selectedItemId: string | null;
};

export type SessionWorkspaceStateBySession = Readonly<Record<string, SessionWorkspaceState>>;
export type SessionWorkspaceStateUpdate = (current: SessionWorkspaceState) => SessionWorkspaceState;

export const generatedUiWorkspaceId = (toolCallId: string) => `generated-ui:${toolCallId}`;

export function createSessionWorkspaceState(): SessionWorkspaceState {
  return {
    open: false,
    selectedItemId: null,
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
