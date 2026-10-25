import { describe, expect, test } from "vitest";

import {
  createSessionWorkspaceState,
  generatedUiWorkspaceId,
  toggleSessionWorkspaceItem,
} from "./workspace-model";

describe("session workspace selection", () => {
  test("starts closed before workspace information is observed", () => {
    expect(createSessionWorkspaceState()).toEqual({
      open: false,
      selectedItemId: null,
    });
  });

  test("opens the panel for the selected tool information", () => {
    const itemId = generatedUiWorkspaceId("interface");

    expect(toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId)).toEqual({
      open: true,
      selectedItemId: itemId,
    });
  });

  test("switches the open panel when different information is selected", () => {
    const firstId = generatedUiWorkspaceId("first");
    const interfaceId = generatedUiWorkspaceId("interface");
    const firstSelected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), firstId);

    expect(toggleSessionWorkspaceItem(firstSelected, interfaceId)).toEqual({
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
