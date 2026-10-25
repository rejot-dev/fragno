// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";

import { useState } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

function WorkspaceHarness({ item }: { item: SessionWorkspaceItem }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <SessionWorkspacePanel
      item={item}
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

  test("provides an accessible close action", () => {
    render(<WorkspaceHarness item={generatedUiItem("generated-ui:first", "Orders", "24")} />);

    fireEvent.click(screen.getByRole("button", { name: "Close session workspace" }));
    expect(screen.getByText("Workspace closed")).toBeDefined();
  });
});
