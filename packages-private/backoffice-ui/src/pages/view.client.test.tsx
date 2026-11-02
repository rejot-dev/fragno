// @vitest-environment happy-dom

import { afterEach, assert, expect, test } from "vitest";

import { MemoryRouter } from "react-router";

import { cleanup, render, screen } from "@testing-library/react";

import { buildPageSource } from "./stories/build-page-source";
import { PageView } from "./view";

afterEach(() => {
  cleanup();
});

const quarterPage = `export default page.define({ title: "Q4" }, ({ file }) => {
  const budget = file.csv("/workspace/finance/budget.csv", { month: "string", amount: "number" });
  const plan = file.markdown("/workspace/ops/q4-plan.md", { owner: "string" });
  return ui.stack({ gap: "md" }, [
    ui.heading({ text: "Quarter", level: 2 }),
    ui.panelTable(
      { title: "Budget", columns: [{ label: "Amount" }], empty: "No budget lines." },
      ui.each(budget, (line) => ui.panelTableRow({ title: line.month }, [ui.text({ text: "€" })])),
    ),
    ui.markdown({ text: plan.body }),
  ]);
});
`;

test("a missing file empties what reads it, says why, and leaves the rest of the page", () => {
  const built = buildPageSource(quarterPage);
  assert(built.kind === "valid", built.kind === "invalid" ? built.message : "");
  const [budget, plan] = Object.keys(built.definition.files);

  render(
    <MemoryRouter>
      <PageView
        definition={built.definition}
        results={{}}
        files={{
          [budget!]: { status: "error", message: "/workspace/finance/budget.csv does not exist." },
          [plan!]: {
            status: "ready",
            data: { body: "Ship the tracker.", frontmatter: { owner: "Ada" } },
          },
        }}
        now={0}
        links={() => "#"}
        widgets={{ orchestration: () => null, workflowResponse: () => null }}
      />
    </MemoryRouter>,
  );

  expect(screen.getByText("/workspace/finance/budget.csv does not exist.")).toBeDefined();
  expect(screen.getByText("No budget lines.")).toBeDefined();
  expect(screen.getByText("Quarter")).toBeDefined();
  expect(screen.getByText("Ship the tracker.")).toBeDefined();
});
