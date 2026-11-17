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

/**
 * The universe with a project still being read, past the time the view waits for every scope, so it
 * shows the planets read so far.
 */
function renderStillReading() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const view = render(<OrchestrationUniverseGraph universe={withProject(false)} />);
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  vi.useRealTimers();
  return view;
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

test("a universe opened while scopes are read shows once they are, without what was found empty", () => {
  const view = render(<OrchestrationUniverseGraph universe={withProject(false)} />);
  assert.isNull(view.container.querySelector("[data-planet]"));
  assert.include(
    view.container.textContent,
    `Read ${UNIVERSE.scopes.length} of ${UNIVERSE.scopes.length + 1} scopes`,
  );

  view.rerender(<OrchestrationUniverseGraph universe={withProject(true)} />);
  assert.deepEqual(
    [...planetTransforms(view.container).keys()].sort(),
    UNIVERSE.scopes.map((scope) => scope.id).sort(),
  );
  assert.isNull(view.container.querySelector(".bo-planet-status-leave"));
});

test("a project found empty once read fades where it was, and then is gone", async () => {
  const view = renderStillReading();
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

test("the other planets stay where they were when one leaves, to glide into the gap", () => {
  const view = renderStillReading();
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

test("the view stays on the planets as they drift, though each frame began before it was asked for", () => {
  // After a long commit, the next frame's timestamp is when that frame began, before the commit
  // ended and whatever it started.
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  function runFrame() {
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of due) {
        callback(performance.now() - 100);
      }
    });
  }

  const view = renderStillReading();
  runFrame();
  view.rerender(<OrchestrationUniverseGraph universe={withProject(true)} />);
  for (let frame = 0; frame < 120; frame++) {
    runFrame();
  }

  const camera =
    view.container.querySelector('g[transform*="scale"]')?.getAttribute("transform") ?? "";
  const [x, y, scale] = (camera.match(/-?[\d.]+(?:e[-+]?\d+)?/g) ?? []).map(Number);
  assert.isAbove(scale, 0.06, camera);
  assert.isBelow(Math.abs(x), 1200, camera);
  assert.isBelow(Math.abs(y), 800, camera);
});
