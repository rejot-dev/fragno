// @vitest-environment happy-dom

import { afterEach, assert, beforeEach, test, vi } from "vitest";

import { act, cleanup, render } from "@testing-library/react";

import { UNIVERSE } from "./orchestration-graph-story-support";
import { OrchestrationUniverseGraph } from "./orchestration-universe";
import type { OrchestrationUniverse } from "./orchestration-universe-model";

beforeEach(() => {
  // The universe lays itself out in the room its container measures.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1200,
    height: 800,
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The organization's universe with a project still being read, or read and found empty. */
function withProject(read: boolean): OrchestrationUniverse {
  return {
    ...UNIVERSE,
    scopes: [
      ...UNIVERSE.scopes,
      {
        id: "drafts",
        graph: {
          scopeLabel: "Drafts",
          inlets: [],
          sources: [],
          events: [],
          routes: [],
          targets: [],
        },
        ...(read ? {} : { status: { kind: "loading", fraction: null } }),
      },
    ],
  };
}

/** Where each planet is drawn, by scope. */
function planetTransforms(container: HTMLElement): Map<string, string | null> {
  return new Map(
    [...container.querySelectorAll("[data-planet]")].map((planet) => [
      planet.getAttribute("data-planet")!,
      planet.getAttribute("transform"),
    ]),
  );
}

test("a project found empty once read fades where it was, and then is gone", async () => {
  const view = render(<OrchestrationUniverseGraph universe={withProject(false)} />);
  assert.isNotNull(view.container.querySelector('[data-planet="drafts"]'));

  view.rerender(<OrchestrationUniverseGraph universe={withProject(true)} />);
  assert.isNull(view.container.querySelector('[data-planet="drafts"]'));
  const leaving = view.container.querySelector('[aria-hidden="true"].bo-planet-status-leave');
  assert.include(leaving?.textContent, "Drafts");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  assert.isNull(view.container.querySelector('[aria-hidden="true"].bo-planet-status-leave'));
});

test("the other planets stay where they were when one leaves, to drift into the gap", () => {
  const view = render(<OrchestrationUniverseGraph universe={withProject(false)} />);
  const before = planetTransforms(view.container);

  view.rerender(<OrchestrationUniverseGraph universe={withProject(true)} />);
  const after = planetTransforms(view.container);
  assert.deepEqual(
    [...after.keys()],
    [...before.keys()].filter((id) => id !== "drafts"),
  );
  for (const [id, transform] of after) {
    assert.equal(transform, before.get(id), id);
  }
});
