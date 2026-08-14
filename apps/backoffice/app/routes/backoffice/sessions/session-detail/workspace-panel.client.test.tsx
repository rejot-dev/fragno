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
    expect(screen.queryByText("Generated interface")).toBeNull();
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

    expect(screen.queryByText("Building workflow")).toBeNull();
    const toolbar = container.querySelector<HTMLElement>("[data-session-workspace-toolbar]");
    const actions = container.querySelector<HTMLElement>("[data-session-workspace-actions]");
    assert(toolbar && actions);
    expect(within(toolbar).getByRole("group", { name: "Workflow display" })).toBeDefined();
    expect(toolbar.querySelector("[data-progressive-overflow-controls]")).toBeDefined();
    expect(within(toolbar).getByRole("button", { name: "Close session workspace" })).toBeDefined();

    const workflowGraph = screen.getByLabelText("Workflow graph");
    expect(within(workflowGraph).getByLabelText("order-workflow")).toBeDefined();
    expect(within(workflowGraph).getByText("load orders")).toBeDefined();
    expect(screen.queryByText("Live execution")).toBeNull();
    assert(screen.getByRole("button", { name: /^Flow$/ }).getAttribute("aria-pressed") === "true");
    expect(screen.getByRole("button", { name: /^UI$/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Graph$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Both$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Flow$/ }));
    expect(screen.getByText("load orders")).toBeDefined();
    expect(screen.queryByText("do")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Code$/ }));
    expect(screen.queryByLabelText("Workflow graph")).toBeNull();
    expect(screen.getByLabelText("Script source").textContent).toContain("defineWorkflow");

    fireEvent.click(screen.getByRole("button", { name: /^UI$/ }));
    expect(screen.queryByLabelText("Script source")).toBeNull();
    expect(screen.getByLabelText("Workflow graph")).toBeDefined();
  });

  test("surfaces workflow synchronization failures", () => {
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

    expect(screen.getByRole("alert").textContent).toContain(
      "Workflow synchronization failed: Failed to load workflow synchronization.",
    );
    expect(document.querySelector('[data-session-workflow-sync-state="error"]')).toBeDefined();
    expect(screen.queryByText(/Live execution/)).toBeNull();
  });

  test("provides an accessible close action", () => {
    render(<WorkspaceHarness item={generatedUiItem("generated-ui:first", "Orders", "24")} />);

    fireEvent.click(screen.getByRole("button", { name: "Close session workspace" }));
    expect(screen.getByText("Workspace closed")).toBeDefined();
  });
});
