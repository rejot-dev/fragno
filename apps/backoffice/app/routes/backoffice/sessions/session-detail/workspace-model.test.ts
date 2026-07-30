import { describe, expect, test } from "vitest";

import {
  createSessionWorkspaceState,
  generatedUiTabId,
  reconcileSessionWorkspaceState,
  type SessionWorkspaceTab,
} from "./workspace-model";

const tab = (id: string): SessionWorkspaceTab => ({
  id,
  toolCallId: id,
  label: id,
  view: {
    type: "generated-ui",
    rawValue: {},
    result: {
      $ui: {
        version: 1,
        state: {},
        spec: {
          root: "text",
          elements: {
            text: { type: "Text", props: { text: id }, children: [] },
          },
        },
      },
    } as never,
  },
});

describe("session workspace state", () => {
  test("opens the latest tab when entering a session with existing output", () => {
    const tabs = [tab(generatedUiTabId("first")), tab(generatedUiTabId("second"))];

    expect(createSessionWorkspaceState(tabs)).toEqual({
      open: true,
      selectedTabId: generatedUiTabId("second"),
      knownTabIds: tabs.map((entry) => entry.id),
    });
  });

  test("respects manual closure across content refreshes without replacing unchanged state", () => {
    const tabs = [tab(generatedUiTabId("first"))];
    const closed = { ...createSessionWorkspaceState(tabs), open: false };

    expect(reconcileSessionWorkspaceState(closed, tabs)).toBe(closed);
  });

  test("does not treat tabs returning after a projection gap as new", () => {
    const firstTab = tab(generatedUiTabId("first"));
    const closed = { ...createSessionWorkspaceState([firstTab]), open: false };

    const gapState = reconcileSessionWorkspaceState(closed, []);
    expect(gapState).toBe(closed);
    expect(reconcileSessionWorkspaceState(gapState, [firstTab])).toBe(closed);
  });

  test("reopens and selects only a genuinely new tab", () => {
    const firstTab = tab(generatedUiTabId("first"));
    const secondTab = tab(generatedUiTabId("second"));
    const closed = { ...createSessionWorkspaceState([firstTab]), open: false };

    expect(reconcileSessionWorkspaceState(closed, [firstTab, secondTab])).toEqual({
      open: true,
      selectedTabId: secondTab.id,
      knownTabIds: [firstTab.id, secondTab.id],
    });
  });

  test("keeps observed tab ids when the current projection contains only a subset", () => {
    const firstTab = tab(generatedUiTabId("first"));
    const secondTab = tab(generatedUiTabId("second"));
    const thirdTab = tab(generatedUiTabId("third"));
    const state = {
      ...createSessionWorkspaceState([firstTab, secondTab]),
      open: false,
    };

    expect(reconcileSessionWorkspaceState(state, [secondTab, thirdTab])).toEqual({
      open: true,
      selectedTabId: thirdTab.id,
      knownTabIds: [firstTab.id, secondTab.id, thirdTab.id],
    });
  });

  test("preserves explicit selection while known tabs update", () => {
    const firstTab = tab(generatedUiTabId("first"));
    const secondTab = tab(generatedUiTabId("second"));
    const state = {
      open: true,
      selectedTabId: firstTab.id,
      knownTabIds: [firstTab.id, secondTab.id],
    };

    expect(reconcileSessionWorkspaceState(state, [firstTab, secondTab])).toMatchObject({
      open: true,
      selectedTabId: firstTab.id,
    });
  });
});
