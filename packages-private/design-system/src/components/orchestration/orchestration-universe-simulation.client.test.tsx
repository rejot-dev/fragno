// @vitest-environment happy-dom

import { afterEach, assert, test, vi } from "vitest";

import { act, renderHook } from "@testing-library/react";

import { UNIVERSE } from "./orchestration-graph-story-support";
import { GLIDE_MS, useUniverseSimulation } from "./orchestration-universe-simulation";

afterEach(() => {
  vi.useRealTimers();
});

test("a view resized while planets glide keeps them where the new room puts them", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const { result, rerender } = renderHook(
    ({ count, aspect }) => useUniverseSimulation(UNIVERSE.scopes.slice(0, count), [], aspect),
    { initialProps: { count: 3, aspect: 2 } },
  );

  // A scope joining sets the planets gliding to where they settle with it.
  rerender({ count: 4, aspect: 2 });
  rerender({ count: 4, aspect: 0.5 });
  act(() => {
    vi.advanceTimersByTime(GLIDE_MS * 2);
  });

  assert.deepEqual(result.current.bodies, result.current.resting);
});
