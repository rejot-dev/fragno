// @vitest-environment happy-dom

import { afterEach, describe, test, assert } from "vitest";

import { useMemo, useState } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ToolWorkspaceSelector } from "./tool-workspace-selector";
import {
  SessionWorkspaceNavigationProvider,
  type SessionWorkspaceNavigation,
} from "./workspace-context";
import {
  createSessionWorkspaceState,
  generatedUiWorkspaceId,
  toggleSessionWorkspaceItem,
  workflowGraphWorkspaceId,
} from "./workspace-model";

afterEach(cleanup);

const workflowId = workflowGraphWorkspaceId("tool-call");
const interfaceId = generatedUiWorkspaceId("tool-call");
const itemIds = new Set([workflowId, interfaceId]);

function SelectorHarness() {
  const [workspaceState, setWorkspaceState] = useState(createSessionWorkspaceState);
  const navigation = useMemo<SessionWorkspaceNavigation>(
    () => ({
      hasItem: (itemId) => itemIds.has(itemId),
      isItemSelected: (itemId) => workspaceState.open && workspaceState.selectedItemId === itemId,
      toggleItem: (itemId) => {
        setWorkspaceState((current) => toggleSessionWorkspaceItem(current, itemId));
      },
    }),
    [workspaceState],
  );

  return (
    <SessionWorkspaceNavigationProvider value={navigation}>
      <ToolWorkspaceSelector
        toolLabel="execCodeMode"
        options={[
          { id: workflowId, kind: "workflow-graph", label: "Workflow graph" },
          { id: interfaceId, kind: "generated-ui", label: "Interface" },
        ]}
      />
    </SessionWorkspaceNavigationProvider>
  );
}

describe("ToolWorkspaceSelector", () => {
  test("opens, switches, and closes side panel selections", () => {
    render(<SelectorHarness />);

    const showWorkflow = screen.getByRole("button", {
      name: "Show Workflow graph in side panel",
    });
    assert(showWorkflow.getAttribute("aria-pressed") === "false");

    fireEvent.click(showWorkflow);
    assert(
      screen
        .getByRole("button", { name: "Hide Workflow graph in side panel" })
        .getAttribute("aria-pressed") === "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Interface in side panel" }));
    assert(
      screen
        .getByRole("button", { name: "Hide Interface in side panel" })
        .getAttribute("aria-pressed") === "true",
    );
    assert(
      screen
        .getByRole("button", { name: "Show Workflow graph in side panel" })
        .getAttribute("aria-pressed") === "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide Interface in side panel" }));
    assert(
      screen
        .getByRole("button", { name: "Show Interface in side panel" })
        .getAttribute("aria-pressed") === "false",
    );
  });
});
