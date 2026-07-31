import { describe, expect, test } from "vitest";

import {
  createSessionWorkspaceState,
  generatedUiWorkspaceId,
  toggleSessionWorkspaceItem,
  updateSessionWorkspaceStateBySession,
  workflowGraphWorkspaceId,
} from "./workspace-model";

describe("session workspace selection", () => {
  test("starts closed without selecting newly available information", () => {
    expect(createSessionWorkspaceState()).toEqual({
      open: false,
      selectedItemId: null,
    });
  });

  test("keeps independent workspace state for each session in memory", () => {
    const firstSessionId = "session-a";
    const secondSessionId = "session-b";
    const itemId = generatedUiWorkspaceId("interface");
    const states = updateSessionWorkspaceStateBySession({}, firstSessionId, (current) =>
      toggleSessionWorkspaceItem(current, itemId),
    );

    expect(states[firstSessionId]).toEqual({ open: true, selectedItemId: itemId });
    expect(states[secondSessionId] ?? createSessionWorkspaceState()).toEqual({
      open: false,
      selectedItemId: null,
    });
  });

  test("opens the panel for the selected tool information", () => {
    const itemId = workflowGraphWorkspaceId("workflow");

    expect(toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId)).toEqual({
      open: true,
      selectedItemId: itemId,
    });
  });

  test("switches the open panel when different information is selected", () => {
    const workflowId = workflowGraphWorkspaceId("workflow");
    const interfaceId = generatedUiWorkspaceId("interface");
    const workflowSelected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), workflowId);

    expect(toggleSessionWorkspaceItem(workflowSelected, interfaceId)).toEqual({
      open: true,
      selectedItemId: interfaceId,
    });
  });

  test("closes the panel when its current selector is pressed again", () => {
    const itemId = generatedUiWorkspaceId("interface");
    const selected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId);

    expect(toggleSessionWorkspaceItem(selected, itemId)).toEqual({
      open: false,
      selectedItemId: itemId,
    });
  });

  test("reopens the previously selected information", () => {
    const itemId = generatedUiWorkspaceId("interface");
    const selected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId);
    const closed = toggleSessionWorkspaceItem(selected, itemId);

    expect(toggleSessionWorkspaceItem(closed, itemId)).toEqual(selected);
  });
});
