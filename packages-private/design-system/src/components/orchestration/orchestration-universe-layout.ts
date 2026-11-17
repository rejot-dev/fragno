import { fitCamera, toWorld, type Camera, type Size } from "./orchestration-universe-camera";
import { frameSpots, placeExternalTiles, type ExternalTile } from "./orchestration-universe-frame";
import type {
  OrchestrationExternal,
  UniverseCall,
  UniverseForward,
  UniversePlanet,
} from "./orchestration-universe-model";
import { LINK_DISTANCE } from "./orchestration-universe-physics";
import { CALL_LINE_UP, routeRadius } from "./orchestration-universe-routes";
import { distanceToSegment } from "./orchestration-universe-routing";
import { bearing, offset, shortestDelta, type Point } from "./radial-geometry";
import { layoutWorkflowTriggerGraph } from "./workflow-trigger-graph-model";
import { PLANET_ORBIT_RADIUS } from "./workflow-trigger-planet";

// How much a planet in front of a tile counts against it, in the planet's radii.
const WALLED_COST = 6;
// Planets closer than this crowd each other's workflows.
const CROWDING_DISTANCE = LINK_DISTANCE * 1.25;

/** The way around each planet in a straight path from `from` to `spot`. */
function detours(from: Point, spot: Point, others: readonly Point[], radius: number): number {
  return (
    others.filter((other) => distanceToSegment(other, from, spot) < radius).length *
    radius *
    (Math.PI - 2)
  );
}

/**
 * How far a call has to go from its planet to `spot`: from the planet's edge, plus the way around
 * each other planet in its path.
 */
function reach(from: Point, spot: Point, others: readonly Point[], radius: number): number {
  return (
    Math.hypot(spot.x - from.x, spot.y - from.y) - radius + detours(from, spot, others, radius)
  );
}

/**
 * How far a call has to go from its workflow, at `angle` on the orbit of the planet at `center`, to
 * `spot`: calls leave outwards, so a spot more than a quarter turn round the planet from the
 * workflow costs the way round it, plus the way around each other planet in its path.
 */
function reachFromWorkflow(
  center: Point,
  angle: number,
  spot: Point,
  others: readonly Point[],
  radius: number,
): number {
  const node = offset(center, angle, PLANET_ORBIT_RADIUS);
  const round = Math.max(0, Math.abs(shortestDelta(angle, bearing(center, spot))) - Math.PI / 2);
  return (
    Math.hypot(spot.x - node.x, spot.y - node.y) +
    round * radius +
    detours(node, spot, others, radius)
  );
}

/**
 * Where a call starts, as how far it has to go to each spot; calls with the same `key` start at
 * the same place, so that is worked out once.
 */
type CallReach = { key: string; to: (spot: Point, radius: number) => number };

/**
 * Puts each outside system on the frame where the calls to it have least far to go around the
 * planets, seen in `fit`, and where no planet walls off the spot in front of it.
 */
function placeTiles(
  externals: readonly OrchestrationExternal[],
  calls: readonly UniverseCall[],
  centers: ReadonlyMap<string, Point>,
  size: Size,
  fit: Camera,
  reachOf: (call: UniverseCall) => CallReach,
): ExternalTile[] {
  const radius = routeRadius(fit.scale);
  const spots = frameSpots(size);
  const worldSpots = spots.map((spot) => toWorld(fit, spot.point));
  const lineUp = CALL_LINE_UP / fit.scale;
  const walled = worldSpots.map((world, index) => {
    const { inward } = spots[index];
    const front = { x: world.x + inward.x * lineUp, y: world.y + inward.y * lineUp };
    return [...centers.values()].filter(
      (center) => Math.hypot(front.x - center.x, front.y - center.y) < radius,
    ).length;
  });
  const reachFrom = new Map<string, number[]>();
  function reachesOf(call: UniverseCall): readonly number[] {
    const { key, to } = reachOf(call);
    const known = reachFrom.get(key);
    if (known) {
      return known;
    }
    const reaches = worldSpots.map((world) => to(world, radius));
    reachFrom.set(key, reaches);
    return reaches;
  }
  const callsTo = new Map(
    externals.map((external) => [
      external.id,
      calls.filter((call) => call.externalId === external.id),
    ]),
  );
  return placeExternalTiles(externals, size, spots, (external, spot) =>
    (callsTo.get(external.id) ?? []).reduce(
      (total, call) => total + reachesOf(call)[spot],
      walled[spot] * radius * WALLED_COST,
    ),
  );
}

/** Per scope, the angles around its planet of each workflow's tiles. */
function callBearings(
  calls: readonly UniverseCall[],
  tiles: readonly ExternalTile[],
  centers: ReadonlyMap<string, Point>,
  fit: Camera,
): Map<string, Map<string, number[]>> {
  const tileOf = new Map(tiles.map((tile) => [tile.external.id, tile]));
  const bearings = new Map<string, Map<string, number[]>>();
  for (const call of calls) {
    const tile = tileOf.get(call.externalId);
    if (!tile) {
      continue;
    }
    const toward = bearing(centers.get(call.scopeId) ?? { x: 0, y: 0 }, toWorld(fit, tile.center));
    const byWorkflow = bearings.get(call.scopeId) ?? new Map<string, number[]>();
    byWorkflow.set(call.workflowId, [...(byWorkflow.get(call.workflowId) ?? []), toward]);
    bearings.set(call.scopeId, byWorkflow);
  }
  return bearings;
}

/**
 * The planets, resting at `positions`, with each event turned towards the planets it is forwarded
 * to or from, and each workflow towards the outside systems it calls and away from close
 * neighbours. `callBearings` holds per scope the angles, around its planet, of each workflow's
 * systems.
 */
function orientPlanets(
  planets: readonly UniversePlanet[],
  forwards: readonly UniverseForward[],
  positions: ReadonlyMap<string, Point>,
  callBearings: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>,
): UniversePlanet[] {
  const positionOf = (scopeId: string) => positions.get(scopeId) ?? { x: 0, y: 0 };
  return planets.map((planet) => {
    const at = positionOf(planet.scope.id);
    const crowded = planets.flatMap(({ scope }) => {
      const other = positionOf(scope.id);
      const distance = Math.hypot(other.x - at.x, other.y - at.y);
      return scope.id !== planet.scope.id && distance < CROWDING_DISTANCE
        ? [bearing(at, other)]
        : [];
    });
    const forwardBearings = new Map<string, number[]>();
    for (const forward of forwards) {
      const other =
        forward.fromScopeId === planet.scope.id
          ? forward.toScopeId
          : forward.toScopeId === planet.scope.id
            ? forward.fromScopeId
            : planet.scope.id;
      if (other !== planet.scope.id) {
        forwardBearings.set(forward.eventId, [
          ...(forwardBearings.get(forward.eventId) ?? []),
          bearing(at, positionOf(other)),
        ]);
      }
    }
    return {
      ...planet,
      layout: layoutWorkflowTriggerGraph(planet.scope.graph, planet.forwardCounts, {
        forwardBearings,
        callBearings: callBearings.get(planet.scope.id) ?? new Map(),
        crowded,
      }),
    };
  });
}

/**
 * What is laid out around planets resting at `resting`, seen in the view that fits them: the
 * outside systems on the frame, and the planets turned towards those and towards each other.
 * Tiles are first put where their planets reach them, so workflows can turn towards them, and then
 * again where those workflows reach them: a planet's tiles would otherwise all want the same
 * stretch of frame, and a call could end up going round its own planet to a tile on the far side.
 */
export function arrangeAtRest(
  universe: {
    planets: readonly UniversePlanet[];
    forwards: readonly UniverseForward[];
    externals: readonly OrchestrationExternal[];
    calls: readonly UniverseCall[];
  },
  resting: ReadonlyMap<string, Point>,
  size: Size,
): { fit: Camera; tiles: ExternalTile[]; planets: UniversePlanet[] } {
  const centers = new Map(
    universe.planets.map(({ scope }) => [scope.id, resting.get(scope.id) ?? { x: 0, y: 0 }]),
  );
  const fit = fitCamera([...centers.values()], size);
  const centerOf = (scopeId: string) => centers.get(scopeId) ?? { x: 0, y: 0 };
  const othersOf = new Map(
    [...centers.keys()].map((scopeId) => [
      scopeId,
      [...centers].flatMap(([id, center]) => (id === scopeId ? [] : [center])),
    ]),
  );
  const others = (scopeId: string) => othersOf.get(scopeId) ?? [];
  const { externals, calls, forwards } = universe;
  const nearPlanets = placeTiles(externals, calls, centers, size, fit, (call) => ({
    key: call.scopeId,
    to: (spot, radius) => reach(centerOf(call.scopeId), spot, others(call.scopeId), radius),
  }));
  const turned = orientPlanets(
    universe.planets,
    forwards,
    centers,
    callBearings(calls, nearPlanets, centers, fit),
  );
  const workflowAngles = new Map(
    turned.flatMap(({ scope, layout }) =>
      layout.workflows.map(({ workflow, angle }) => [`${scope.id}|${workflow.id}`, angle]),
    ),
  );
  const tiles = placeTiles(externals, calls, centers, size, fit, (call) => {
    const key = `${call.scopeId}|${call.workflowId}`;
    const angle = workflowAngles.get(key) ?? 0;
    return {
      key,
      to: (spot, radius) =>
        reachFromWorkflow(centerOf(call.scopeId), angle, spot, others(call.scopeId), radius),
    };
  });
  return {
    fit,
    tiles,
    planets: orientPlanets(
      universe.planets,
      forwards,
      centers,
      callBearings(calls, tiles, centers, fit),
    ),
  };
}
