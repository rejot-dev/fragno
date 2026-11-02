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
import { bearing, type Point } from "./radial-geometry";
import { layoutWorkflowTriggerGraph } from "./workflow-trigger-graph-model";

// How much a planet in front of a tile counts against it, in the planet's radii.
const WALLED_COST = 6;
// Planets closer than this crowd each other's workflows.
const CROWDING_DISTANCE = LINK_DISTANCE * 1.25;

/**
 * How far a planet's call has to go to reach `spot`: from the planet's edge, plus the way around
 * each other planet in its path.
 */
function reach(from: Point, spot: Point, others: readonly Point[], radius: number): number {
  const detours = others.filter((other) => distanceToSegment(other, from, spot) < radius).length;
  return Math.hypot(spot.x - from.x, spot.y - from.y) - radius + detours * radius * (Math.PI - 2);
}

/**
 * Puts each outside system on the frame where the calls to it have least far to go around the
 * planets, seen in `fit`, and where no planet walls off the spot in front of it. How far each
 * scope is from each spot is worked out once and shared by every system its workflows call.
 */
function placeTiles(
  externals: readonly OrchestrationExternal[],
  calls: readonly UniverseCall[],
  centers: ReadonlyMap<string, Point>,
  size: Size,
  fit: Camera,
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
  function reachesOf(scopeId: string): readonly number[] {
    const known = reachFrom.get(scopeId);
    if (known) {
      return known;
    }
    const from = centers.get(scopeId) ?? { x: 0, y: 0 };
    const others = [...centers].flatMap(([id, center]) => (id === scopeId ? [] : [center]));
    const reaches = worldSpots.map((world) => reach(from, world, others, radius));
    reachFrom.set(scopeId, reaches);
    return reaches;
  }
  const callers = new Map(
    externals.map((external) => [
      external.id,
      calls.filter((call) => call.externalId === external.id).map((call) => call.scopeId),
    ]),
  );
  return placeExternalTiles(externals, size, spots, (external, spot) =>
    (callers.get(external.id) ?? []).reduce(
      (total, scopeId) => total + reachesOf(scopeId)[spot],
      walled[spot] * radius * WALLED_COST,
    ),
  );
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
  const tiles = placeTiles(universe.externals, universe.calls, centers, size, fit);
  const tileOf = new Map(tiles.map((tile) => [tile.external.id, tile]));
  const bearings = new Map<string, Map<string, number[]>>();
  for (const call of universe.calls) {
    const tile = tileOf.get(call.externalId);
    if (!tile) {
      continue;
    }
    const toward = bearing(centers.get(call.scopeId) ?? { x: 0, y: 0 }, toWorld(fit, tile.center));
    const byWorkflow = bearings.get(call.scopeId) ?? new Map<string, number[]>();
    byWorkflow.set(call.workflowId, [...(byWorkflow.get(call.workflowId) ?? []), toward]);
    bearings.set(call.scopeId, byWorkflow);
  }
  return {
    fit,
    tiles,
    planets: orientPlanets(universe.planets, universe.forwards, centers, bearings),
  };
}
