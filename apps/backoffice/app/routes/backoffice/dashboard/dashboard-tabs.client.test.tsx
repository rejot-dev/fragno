// @vitest-environment happy-dom

import { afterAll, afterEach, assert, beforeAll, test } from "vitest";

import { MemoryRouter } from "react-router";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PageSources } from "../pages/load.server";
import { DashboardTabs } from "./dashboard-tabs";

// happy-dom lays nothing out, so the tab row would measure no room and move every tab into More.
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    value: 10_000,
  });
});
afterAll(() => {
  if (clientWidth) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const scope = { kind: "user" as const, userId: "ada", jurisdiction: null, label: "ada@acme.test" };

function openDashboard(pageSources: Promise<PageSources>) {
  return (
    <MemoryRouter>
      <DashboardTabs
        selectedScope={scope}
        active={{ kind: "overview" }}
        pageSources={pageSources}
      />
    </MemoryRouter>
  );
}

function pageTabs(): string[] {
  const links = screen.getByRole("navigation", { name: "Dashboard" }).querySelectorAll("a");
  return Array.from(links, (link) => link.textContent).filter(
    (label) => label !== "Overview" && label !== "Activity" && label !== "Map",
  );
}

/**
 * Runs a step and lets the listings it hands over settle. The open menu suspends on them, so React
 * holds the step's commit until they do.
 */
async function step(action: () => void) {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("a pinned page stays a tab until a listing no longer has its source", async () => {
  const listed = (...names: string[]): Promise<PageSources> =>
    Promise.resolve({
      kind: "listed",
      sourcePaths: names.map((name) => `/workspace/${name}.page.js`),
    });

  const { rerender } = render(openDashboard(listed("home", "reports/operations")));
  await step(() => {
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
  });
  await step(() => {
    fireEvent.click(screen.getByRole("button", { name: "Pin Operations" }));
  });
  assert.deepEqual(pageTabs(), ["Operations"]);

  // Until a listing says otherwise, the page may still exist.
  await step(() => {
    rerender(openDashboard(new Promise<PageSources>(() => {})));
  });
  assert.deepEqual(pageTabs(), ["Operations"]);
  await step(() => {
    rerender(openDashboard(Promise.resolve({ kind: "failed", message: "timeout" })));
  });
  assert.deepEqual(pageTabs(), ["Operations"]);

  await step(() => {
    rerender(openDashboard(listed("home")));
  });
  assert.deepEqual(pageTabs(), []);
  assert.equal(
    window.localStorage.getItem("backoffice:dashboard-pinned-pages:user/ada"),
    JSON.stringify([]),
  );
});
