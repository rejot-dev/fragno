import { assert, describe, expect, test } from "vitest";

import type { OrchestrationGraph } from "./orchestration-graph-model";
import { UNIVERSE } from "./orchestration-graph-story-support";
import {
  callKey,
  externalKey,
  layoutUniverse,
  universeHighlights,
  workflowFocusId,
  type OrchestrationUniverse,
} from "./orchestration-universe-model";
import { orbitLandings, routeForwards, universeField } from "./orchestration-universe-routes";
import { normalizeAngle } from "./radial-geometry";

/** The calls and outside systems lit when `focused` is. */
function litCallsAndSystems(focused: ReadonlySet<string> | undefined) {
  const { calls, externals } = layoutUniverse(UNIVERSE);
  return {
    calls: calls.filter((call) => focused?.has(callKey(call))).map(({ id }) => id),
    systems: externals.filter(({ id }) => focused?.has(externalKey(id))).map(({ id }) => id),
  };
}

describe("what focusing lights up", () => {
  const { planets, forwards, externals, calls } = layoutUniverse(UNIVERSE);
  const highlights = universeHighlights(planets, forwards, externals, calls);

  test("a planet lights the systems its workflows call, but draws none of the calls", () => {
    expect(litCallsAndSystems(highlights.scopes.get("org"))).toEqual({
      calls: [],
      systems: ["telegram", "email", "slack"],
    });
  });

  test("a workflow draws its own calls only", () => {
    expect(
      litCallsAndSystems(
        highlights.workflows.get(workflowFocusId("org", "organization-onboarding")),
      ),
    ).toEqual({
      calls: ["org|organization-onboarding→email", "org|organization-onboarding→slack"],
      systems: ["email", "slack"],
    });
  });
});

/** A scope whose only route forwards `eventIds` to `to`, or, without them, one with no routes. */
function graph(scopeLabel: string, eventIds: readonly string[] = []): OrchestrationGraph {
  return {
    scopeLabel,
    inlets: [],
    sources: [{ id: "bank", label: "Bank", icon: "credit-card" }],
    events: eventIds.map((id) => ({
      id,
      sourceId: "bank",
      eventType: id,
      label: id,
      recentCount: 0,
    })),
    routes: eventIds.map((eventId) => ({
      id: `forward-${eventId}`,
      eventId,
      label: `Forward ${eventId}`,
      priority: 100,
      enabled: true,
      matcher: null,
      action: { kind: "forward_event", targetId: "scope:org" },
    })),
    targets: [{ id: "scope:org", label: "Org", kind: "scope", activeCount: 0 }],
  };
}

/** A member forwarding `count` events to an organization that listens to none of them. */
function unroutedUniverse(count: number): OrchestrationUniverse {
  const eventIds = Array.from({ length: count }, (_, index) => `bank:event-${index}`);
  return {
    scopes: [
      { id: "member", graph: graph("Member", eventIds) },
      { id: "org", graph: graph("Org") },
    ],
    forwards: eventIds.map((eventId) => ({
      routeId: `forward-${eventId}`,
      fromScopeId: "member",
      toScopeId: "org",
    })),
    externals: [],
    calls: [],
  };
}

const ORGANIZATION_CENTER = { x: 2000, y: 0 };

/** Routes the forwards of `universe` with the member at the origin and the organization east. */
function routedUnrouted(universe: OrchestrationUniverse) {
  const { planets, forwards } = layoutUniverse(universe);
  const field = universeField([{ x: 0, y: 0 }, ORGANIZATION_CENTER], 1);
  const drawn = routeForwards(field, planets, forwards);
  return { drawn, landed: orbitLandings(field, planets, drawn) };
}

/** The angles, clockwise from up, that the ends of an orbit stretch sit at round the organization. */
function stretchEnds(path: string): number[] {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)].map(([n]) => Number(n));
  const ends = [
    { x: numbers[0], y: numbers[1] },
    { x: numbers.at(-2)!, y: numbers.at(-1)! },
  ];
  return ends.map(({ x, y }) =>
    normalizeAngle(Math.atan2(x - ORGANIZATION_CENTER.x, -(y - ORGANIZATION_CENTER.y))),
  );
}

/** A scope whose one route starts a workflow. */
function workflowGraph(scopeLabel: string): OrchestrationGraph {
  return {
    ...graph(scopeLabel),
    events: [
      { id: "bank:paid", sourceId: "bank", eventType: "paid", label: "Paid", recentCount: 0 },
    ],
    routes: [
      {
        id: "file-receipt",
        eventId: "bank:paid",
        label: "File the receipt",
        priority: 100,
        enabled: true,
        matcher: null,
        action: { kind: "start_workflow", targetId: "workflow:file" },
      },
    ],
    targets: [{ id: "workflow:file", label: "File", kind: "workflow", activeCount: 0 }],
  };
}

describe("planets with nothing on them", () => {
  test("take no room, unless they are still being read or failed to be", () => {
    const universe = unroutedUniverse(1);
    const { planets } = layoutUniverse({
      ...universe,
      scopes: [
        ...universe.scopes,
        { id: "empty", graph: graph("Empty") },
        { id: "unused", graph: { ...workflowGraph("Unused"), routes: [] } },
        { id: "busy", graph: workflowGraph("Busy") },
        { id: "reading", graph: graph("Reading"), status: { kind: "loading", fraction: null } },
        { id: "broken", graph: graph("Broken"), status: { kind: "failed", message: "Gone" } },
      ],
    });
    expect(planets.map(({ scope }) => scope.id)).toEqual([
      "member",
      "org",
      "busy",
      "reading",
      "broken",
    ]);
  });
});

describe("forwards that nothing listens to", () => {
  test("spread over at most a quarter of the orbit, on a stretch under every one of them", () => {
    const { drawn, landed } = routedUnrouted(unroutedUniverse(36));
    const angles = drawn.map(({ landing }) => normalizeAngle(landing!));
    // They arrive from the west, so none crosses the top of the orbit, where angles wrap.
    const [from, to] = [Math.min(...angles), Math.max(...angles)];
    expect(to - from).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    expect(landed).toHaveLength(1);
    const [start, end] = stretchEnds(landed[0].path);
    expect(start).toBeLessThan(from);
    expect(end).toBeGreaterThan(to);
    expect(end - start).toBeLessThan(Math.PI);
  });

  test("land side by side on one stretch of the orbit", () => {
    const universe: OrchestrationUniverse = {
      scopes: [
        { id: "member", graph: graph("Member", ["bank:expense", "bank:meeting"]) },
        { id: "org", graph: graph("Org") },
      ],
      forwards: [
        { routeId: "forward-bank:expense", fromScopeId: "member", toScopeId: "org" },
        { routeId: "forward-bank:meeting", fromScopeId: "member", toScopeId: "org" },
      ],
      externals: [],
      calls: [],
    };
    const { planets, forwards } = layoutUniverse(universe);
    const positions = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
    ];
    const field = universeField(positions, 1);
    const drawn = routeForwards(field, planets, forwards);
    const landings = drawn.map(({ landing }) => landing);
    expect(landings).toHaveLength(2);
    const [first, second] = landings;
    assert(first !== null && second !== null);
    // Apart from each other, on one stretch of the orbit of the planet they reach.
    expect(Math.abs(first - second) * 400).toBeGreaterThan(30);
    expect(
      orbitLandings(field, planets, drawn).map(({ scopeId, forwards: landed }) => ({
        scopeId,
        landed: landed.map(({ id }) => id),
      })),
    ).toEqual([{ scopeId: "org", landed: drawn.map(({ forward }) => forward.id) }]);
  });
});
