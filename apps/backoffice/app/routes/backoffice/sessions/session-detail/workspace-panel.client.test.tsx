// @vitest-environment happy-dom

import { afterEach, describe, expect, test, assert } from "vitest";

import { useState } from "react";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { projectWorkflowGraph } from "./workflow-graph-projection";
import type { SessionWorkspaceItem } from "./workspace-model";
import { SessionWorkspacePanel } from "./workspace-panel";

afterEach(cleanup);

const generatedUiItem = (id: string, label: string, value: string): SessionWorkspaceItem => ({
  id,
  label,
  toolCallId: id,
  view: {
    type: "generated-ui",
    rawValue: { value },
    result: {
      value,
      $ui: {
        version: 1,
        state: {},
        spec: {
          root: "metric",
          elements: {
            metric: {
              type: "Metric",
              props: { label, value },
              children: [],
            },
          },
        },
      },
    } as never,
  },
});

function WorkspaceHarness({
  item,
  workflowCollectionsError,
}: {
  item: SessionWorkspaceItem;
  workflowCollectionsError?: string | null;
}) {
  const [open, setOpen] = useState(true);
  return open ? (
    <SessionWorkspacePanel
      item={item}
      workflowCollectionsError={workflowCollectionsError}
      scope={{ kind: "org", orgId: "org-1" }}
      onClose={() => {
        setOpen(false);
      }}
    />
  ) : (
    <p>Workspace closed</p>
  );
}

describe("SessionWorkspacePanel", () => {
  test("renders the selected generated interface without workspace tabs", () => {
    render(<WorkspaceHarness item={generatedUiItem("generated-ui:first", "Orders", "24")} />);

    expect(screen.getByLabelText("Orders")).toBeDefined();
    expect(screen.getByText("Generated interface")).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  test("renders workflows through the automation script graph", () => {
    const projection = projectWorkflowGraph({
      complete: false,
      toolCallId: "workflow",
      source: `defineWorkflow({ name: "order-workflow" }, async (_event, step) => {
        await step.do("load orders", async () => []);
      });`,
    });
    if (!projection) {
      throw new Error("Expected workflow projection.");
    }

    const { container } = render(
      <WorkspaceHarness
        item={{
          id: "workflow-graph:workflow",
          toolCallId: "workflow",
          label: "order-workflow",
          view: {
            type: "workflow-graph",
            projection,
            run: { workflowName: "codemode-script", instanceId: "workflow-instance" },
          },
        }}
      />,
    );

    expect(screen.getByText("Building workflow")).toBeDefined();
    const toolbar = container.querySelector<HTMLElement>("[data-session-workspace-toolbar]");
    const actions = container.querySelector<HTMLElement>("[data-session-workspace-actions]");
    assert(toolbar && actions);
    expect(within(toolbar).getByRole("group", { name: "Workflow graph detail" })).toBeDefined();
    expect(within(toolbar).getByRole("group", { name: "Script view" })).toBeDefined();
    expect(within(toolbar).getByRole("button", { name: "Close session workspace" })).toBeDefined();

    const workflowGraph = screen.getByLabelText("Workflow graph");
    expect(within(workflowGraph).getByText("order-workflow")).toBeDefined();
    expect(within(workflowGraph).getByText("load orders")).toBeDefined();
    expect(screen.getByText("Live execution")).toBeDefined();
    expect(screen.getByText(/workflow-instance/)).toBeDefined();
    expect(screen.queryByText("Synchronization failed")).toBeNull();
    expect(screen.getByText(/Waiting for run data/)).toBeDefined();
    assert(
      screen.getByRole("button", { name: /^simple$/i }).getAttribute("aria-pressed") === "true",
    );
    expect(screen.getByRole("button", { name: /^UI$/ })).toBeDefined();
    assert(screen.getByRole("button", { name: /^Graph$/ }).getAttribute("aria-pressed") === "true");
    expect(container.querySelectorAll('button[title^="Show "]')).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^verbose$/i }));
    assert(
      screen.getByRole("button", { name: /^verbose$/i }).getAttribute("aria-pressed") === "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /^Code$/ }));
    expect(screen.queryByLabelText("Workflow graph")).toBeNull();
    expect(screen.getByLabelText("Script source").textContent).toContain("defineWorkflow");

    fireEvent.click(screen.getByRole("button", { name: /^Both$/ }));
    expect(screen.getByLabelText("Script source")).toBeDefined();
    expect(screen.getByLabelText("Workflow graph")).toBeDefined();
    expect(container.querySelectorAll('button[title^="Show "]').length).toBeGreaterThan(0);
  });

  test("shows genuine workflow synchronization failures", () => {
    const projection = projectWorkflowGraph({
      complete: true,
      toolCallId: "failed-workflow",
      source: `defineWorkflow({ name: "failed-workflow" }, async (_event, step) => {
        await step.do("load orders", async () => []);
      });`,
    });
    if (!projection) {
      throw new Error("Expected workflow projection.");
    }

    render(
      <WorkspaceHarness
        item={{
          id: "workflow-graph:failed-workflow",
          toolCallId: "failed-workflow",
          label: "failed-workflow",
          view: {
            type: "workflow-graph",
            projection,
            run: { workflowName: "codemode-script", instanceId: "workflow-instance" },
          },
        }}
        workflowCollectionsError="Failed to load workflow synchronization."
      />,
    );

    expect(screen.getByText(/Synchronization failed/)).toBeDefined();
    assert(
      screen
        .getByText(/Synchronization failed/)
        .closest("[data-session-workflow-live-state]")
        ?.getAttribute("title") === "Failed to load workflow synchronization.",
    );
  });

  test("provides an accessible close action", () => {
    render(<WorkspaceHarness item={generatedUiItem("generated-ui:first", "Orders", "24")} />);

    fireEvent.click(screen.getByRole("button", { name: "Close session workspace" }));
    expect(screen.getByText("Workspace closed")).toBeDefined();
  });
});
