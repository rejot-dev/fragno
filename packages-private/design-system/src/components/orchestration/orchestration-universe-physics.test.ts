import { describe, expect, test } from "vitest";

import type { OrchestrationGraph } from "./orchestration-graph-model";
import type { OrchestrationUniverseScope, UniverseForward } from "./orchestration-universe-model";
import {
  seedUniverse,
  settleUniverse,
  universeLinks,
  universeRoom,
} from "./orchestration-universe-physics";

function scope(id: string): OrchestrationUniverseScope {
  const graph: OrchestrationGraph = {
    scopeLabel: id,
    inlets: [],
    sources: [],
    events: [],
    routes: [],
    targets: [],
  };
  return { id, graph };
}

function forward(fromScopeId: string, toScopeId: string): UniverseForward {
  const id = `${fromScopeId}-${toScopeId}`;
  return { id, fromScopeId, toScopeId, eventId: "event", label: id };
}

/** How far the third planet sits from the line through the first two, in world units. */
function offLine(points: readonly { x: number; y: number }[]): number {
  const [a, b, c] = points;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(cross) / Math.hypot(b.x - a.x, b.y - a.y);
}

describe("the universe's layout", () => {
  test("a hub with two neighbours settles as a triangle, not a line", () => {
    const scopes = [scope("org"), scope("project"), scope("person")];
    const forwards = [forward("org", "project"), forward("person", "org")];
    const settled = settleUniverse(
      seedUniverse(scopes, forwards, new Map()),
      universeLinks(forwards),
      universeRoom(scopes.length, 16 / 9),
    );
    expect(offLine([...settled.values()])).toBeGreaterThan(500);
  });

  test("two scopes sit side by side", () => {
    const scopes = [scope("org"), scope("project")];
    const forwards = [forward("org", "project")];
    const [first, second] = [...seedUniverse(scopes, forwards, new Map()).values()];
    expect(Math.abs(first.y - second.y)).toBeLessThan(1e-6);
    expect(Math.abs(first.x - second.x)).toBeGreaterThan(0);
  });
});
