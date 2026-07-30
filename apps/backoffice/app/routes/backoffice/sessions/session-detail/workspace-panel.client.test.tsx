// @vitest-environment happy-dom

import { afterEach, describe, expect, test, assert } from "vitest";

import { useState } from "react";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { projectWorkflowGraph } from "./workflow-graph-projection";
import type { SessionWorkspaceTab } from "./workspace-model";
import { SessionMobileWorkspaceTabs, SessionWorkspacePanel } from "./workspace-panel";

afterEach(cleanup);

const generatedUiTab = (id: string, label: string, value: string): SessionWorkspaceTab => ({
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

function MobileTabsHarness({ tabs }: { tabs: SessionWorkspaceTab[] }) {
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  return (
    <SessionMobileWorkspaceTabs
      tabs={tabs}
      selectedTabId={selectedTabId}
      onSelectChat={() => {
        setSelectedTabId(null);
      }}
      onSelectTab={setSelectedTabId}
    />
  );
}

function WorkspaceHarness({ tabs }: { tabs: SessionWorkspaceTab[] }) {
  const [selectedTabId, setSelectedTabId] = useState(tabs[0]?.id ?? "");
  const [open, setOpen] = useState(true);
  return open ? (
    <SessionWorkspacePanel
      tabs={tabs}
      selectedTabId={selectedTabId}
      onSelectTab={setSelectedTabId}
      onClose={() => {
        setOpen(false);
      }}
    />
  ) : (
    <p>Workspace closed</p>
  );
}

describe("SessionMobileWorkspaceTabs", () => {
  test("puts Chat first and switches between the conversation and interfaces", () => {
    render(
      <MobileTabsHarness
        tabs={[
          generatedUiTab("generated-ui:first", "Orders", "24"),
          generatedUiTab("generated-ui:second", "Revenue", "$1,200"),
        ]}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chat", "Orders", "Revenue"]);
    assert(screen.getByRole("tab", { name: /Chat/i }).getAttribute("aria-selected") === "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: /Chat/i }), { key: "ArrowRight" });
    assert(screen.getByRole("tab", { name: /Orders/i }).getAttribute("aria-selected") === "true");

    fireEvent.click(screen.getByRole("tab", { name: /Chat/i }));
    assert(screen.getByRole("tab", { name: /Chat/i }).getAttribute("aria-selected") === "true");
  });
});

describe("SessionWorkspacePanel", () => {
  test("renders the selected generated interface and switches tabs", () => {
    render(
      <WorkspaceHarness
        tabs={[
          generatedUiTab("generated-ui:first", "Orders", "24"),
          generatedUiTab("generated-ui:second", "Revenue", "$1,200"),
        ]}
      />,
    );

    expect(screen.getByLabelText("Orders")).toBeDefined();
    expect(screen.queryByLabelText("Revenue")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Revenue/i }));

    expect(screen.queryByLabelText("Orders")).toBeNull();
    expect(screen.getByLabelText("Revenue")).toBeDefined();
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

    render(
      <WorkspaceHarness
        tabs={[
          {
            id: "workflow-graph:workflow",
            toolCallId: "workflow",
            label: "order-workflow",
            view: { type: "workflow-graph", projection },
          },
        ]}
      />,
    );

    const workflowGraph = screen.getByLabelText("Workflow graph");
    expect(within(workflowGraph).getByText("order-workflow")).toBeDefined();
    expect(within(workflowGraph).getByText("load orders")).toBeDefined();
    assert(
      screen.getByRole("button", { name: /^simple$/i }).getAttribute("aria-pressed") === "true",
    );
    assert(screen.getByRole("button", { name: /^Graph$/ }).getAttribute("aria-pressed") === "true");

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
  });

  test("supports arrow-key tab navigation and an accessible close action", () => {
    render(
      <WorkspaceHarness
        tabs={[
          generatedUiTab("generated-ui:first", "Orders", "24"),
          generatedUiTab("generated-ui:second", "Revenue", "$1,200"),
        ]}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: /Orders/i }), { key: "ArrowRight" });
    assert(screen.getByRole("tab", { name: /Revenue/i }).getAttribute("aria-selected") === "true");

    fireEvent.click(screen.getByRole("button", { name: "Close session workspace" }));
    expect(screen.getByText("Workspace closed")).toBeDefined();
  });
});
