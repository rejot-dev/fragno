import { toWorld, type Camera } from "./orchestration-universe-camera";
import { TILE_THICKNESS, type ExternalTile } from "./orchestration-universe-frame";
import type { UniverseCall, UniverseForward, UniversePlanet } from "./orchestration-universe-model";
import {
  arcSpan,
  routeAround,
  routeField,
  type RouteField,
  type RouteStep,
  type RouteTarget,
} from "./orchestration-universe-routing";
import { bearing, offset, shortestDelta, type Point } from "./radial-geometry";
import { eventDepartureAngle } from "./workflow-trigger-graph-model";
import {
  PLANET_EVENT_EDGE_RADIUS,
  PLANET_ORBIT_RADIUS,
  PLANET_STATUS_RING_RADIUS,
  PLANET_STATUS_RING_WIDTH,
  PLANET_WORKFLOW_LABEL_FONT,
  PLANET_WORKFLOW_NODE_RADIUS,
} from "./workflow-trigger-planet";

// Routes are worked out and drawn in world units. Distances that should look the same at every
// zoom are given in screen pixels and divided by the scale.

const MIN_WORKFLOW_FONT = 7;
// Workflows only grow so far, or neighbours on the orbit would cover each other.
const MAX_WORKFLOW_SCALE = 1.6;
// How far outside the workflows' circles routes pass around planets, in pixels.
const ROUTE_CLEARANCE = 10;
// How far in front of its tile a call lines up to land on it square, in pixels.
const LANDING = 64;
// The distances in front of a tile a call may line up at, farthest first.
const LANDINGS = [LANDING, 32, 14];
// How much longer a route to a farther point may be and still win over a nearer one.
const LANDING_SLACK = 1.2;
// How much longer coming in square may be than turning onto the tile from the side.
const DETOUR_LIMIT = 1.6;
// The least a call's last stretch heads towards its tile, as a cosine.
const APPROACH = 0.2;
// Where a call ends, just in front of its tile, in pixels.
const TILE_FRONT = TILE_THICKNESS / 2 + 3;
/** How far in front of its tile a call lines up to land on it, in pixels. */
export const CALL_LINE_UP = TILE_FRONT + LANDING;
// The same as `APPROACH` for a forward coming in to the planet it goes to.
const FORWARD_APPROACH = -0.2;
// How far, in world units, a forward runs out of its planet before it bends towards the next.
const FORWARD_EASE = 80;
// How far out from the event a forward lines up to land on it, in world units.
const FORWARD_LANDING = 60;
// Forwards landing on the same planet's orbit from the same way spread this far apart, in radians,
// over at most a quarter of the orbit, however many there are.
const ORBIT_LANDING_SPREAD = 36 / PLANET_ORBIT_RADIUS;
const MAX_ORBIT_LANDING_SPAN = Math.PI / 2;
// The stretch of orbit drawn under landing forwards reaches this far past the outermost, in
// radians, and the arrows stop this far out from it.
const ORBIT_LANDING_MARGIN = 40 / PLANET_ORBIT_RADIUS;
const ORBIT_LANDING_GAP = 4;

/** How much workflows grow at a zoom, so their names stay readable without covering each other. */
export function workflowGrowth(scale: number): number {
  return Math.min(
    MAX_WORKFLOW_SCALE,
    Math.max(1, MIN_WORKFLOW_FONT / (PLANET_WORKFLOW_LABEL_FONT * scale)),
  );
}

/**
 * How far from its centre routes keep around a planet at a zoom: past its workflows, which grow as
 * the view zooms out, and a few pixels more.
 */
export function routeRadius(scale: number): number {
  return (
    PLANET_ORBIT_RADIUS +
    PLANET_WORKFLOW_NODE_RADIUS * workflowGrowth(scale) +
    (3 + ROUTE_CLEARANCE) / scale
  );
}

/** The ways around planets at `positions`, in the planets' order, at a zoom. */
export function universeField(positions: readonly Point[], scale: number): RouteField {
  return routeField(positions.map((center) => ({ center, radius: routeRadius(scale) })));
}

function stepStart(step: RouteStep): { point: Point; heading: Point } {
  if (step.kind === "line") {
    const length = Math.hypot(step.to.x - step.from.x, step.to.y - step.from.y) || 1;
    return {
      point: step.from,
      heading: { x: (step.to.x - step.from.x) / length, y: (step.to.y - step.from.y) / length },
    };
  }
  return {
    point: offset(step.center, step.fromAngle, step.radius),
    heading: { x: step.turn * Math.cos(step.fromAngle), y: step.turn * Math.sin(step.fromAngle) },
  };
}

function stepLength(step: RouteStep): number {
  return step.kind === "line"
    ? Math.hypot(step.to.x - step.from.x, step.to.y - step.from.y)
    : arcSpan(step.turn, step.fromAngle, step.toAngle) * step.radius;
}

function routeLength(steps: readonly RouteStep[]): number {
  return steps.reduce((sum, step) => sum + stepLength(step), 0);
}

/**
 * The point `distance` along a route: the step it falls on, the way the route heads there, and the
 * rest of that step from there on.
 */
function along(
  steps: readonly RouteStep[],
  distance: number,
): { index: number; point: Point; heading: Point; rest: RouteStep } {
  let remaining = distance;
  for (const [index, step] of steps.entries()) {
    const length = stepLength(step);
    if (remaining <= length || index === steps.length - 1) {
      const share = length === 0 ? 0 : Math.min(1, remaining / length);
      if (step.kind === "line") {
        const point = {
          x: step.from.x + (step.to.x - step.from.x) * share,
          y: step.from.y + (step.to.y - step.from.y) * share,
        };
        return { index, point, heading: stepStart(step).heading, rest: { ...step, from: point } };
      }
      const angle =
        step.fromAngle + step.turn * arcSpan(step.turn, step.fromAngle, step.toAngle) * share;
      return {
        index,
        point: offset(step.center, angle, step.radius),
        heading: { x: step.turn * Math.cos(angle), y: step.turn * Math.sin(angle) },
        rest: { ...step, fromAngle: angle },
      };
    }
    remaining -= length;
  }
  throw new Error("A route has at least one step");
}

function arcTo(step: Extract<RouteStep, { kind: "arc" }>): string {
  const span = arcSpan(step.turn, step.fromAngle, step.toAngle);
  const to = offset(step.center, step.toAngle, step.radius);
  return ` A ${step.radius} ${step.radius} 0 ${span > Math.PI ? 1 : 0} ${step.turn === 1 ? 1 : 0} ${to.x} ${to.y}`;
}

/**
 * Where a route leaves from: the edge of a circle, or a point when `radius` is zero, on the side
 * between `outward` and where the route heads. `ease` is at least how far along its first stretch
 * the route joins it.
 */
type Departure = { center: Point; radius: number; outward: Point; ease: number };

/**
 * Draws a route from where it leaves to `end`, easing into its first stretch and turning onto
 * `end` square, along `inward`, `landing` before it.
 */
function routePath(
  departure: Departure,
  steps: readonly RouteStep[],
  end: Point,
  inward: Point,
  landing: number,
): string {
  const { point: start, heading } = stepStart(steps[0]);
  const leave = { x: departure.outward.x + heading.x, y: departure.outward.y + heading.y };
  const leaveLength = Math.hypot(leave.x, leave.y) || 1;
  const from = {
    x: departure.center.x + (leave.x / leaveLength) * departure.radius,
    y: departure.center.y + (leave.y / leaveLength) * departure.radius,
  };
  // The route sets off between outward and its first heading and joins itself further on, rather
  // than stepping out to its first stretch and turning sharply onto it there. The farther the route
  // starts from where it leaves, the longer the join; short stretches on the way are passed over.
  const gap = Math.hypot(start.x - from.x, start.y - from.y);
  const join = Math.min(routeLength(steps) * 0.5, departure.ease + gap * 2);
  const joined = along(steps, join);
  let at = joined.point;
  let path = `M ${from.x} ${from.y} C ${from.x + (leave.x / leaveLength) * gap * 1.2} ${from.y + (leave.y / leaveLength) * gap * 1.2} ${at.x - joined.heading.x * join * 0.5} ${at.y - joined.heading.y * join * 0.5} ${at.x} ${at.y}`;
  const rest = [joined.rest, ...steps.slice(joined.index + 1)];
  rest.forEach((step, index) => {
    const last = index === rest.length - 1;
    if (step.kind === "arc") {
      path += arcTo(step);
      at = offset(step.center, step.toAngle, step.radius);
    } else if (!last) {
      path += ` L ${step.to.x} ${step.to.y}`;
      at = step.to;
    } else {
      // The last stretch runs to the point in front of the target and turns onto it there,
      // landing square even where it sits a little aside from that point.
      const direction = stepStart(step).heading;
      const remaining = Math.hypot(step.to.x - at.x, step.to.y - at.y);
      const turn = Math.min(landing, remaining / 2);
      const bend = { x: step.to.x - direction.x * turn, y: step.to.y - direction.y * turn };
      path += ` L ${bend.x} ${bend.y} C ${step.to.x} ${step.to.y} ${end.x + inward.x * landing * 0.5} ${end.y + inward.y * landing * 0.5} ${end.x} ${end.y}`;
    }
  });
  const last = rest[rest.length - 1];
  if (last.kind === "arc") {
    // A route that ends along its target's edge turns in from there.
    const ending = { x: last.turn * Math.cos(last.toAngle), y: last.turn * Math.sin(last.toAngle) };
    path += ` C ${at.x + ending.x * landing * 0.4} ${at.y + ending.y * landing * 0.4} ${end.x + inward.x * landing * 0.5} ${end.y + inward.y * landing * 0.5} ${end.x} ${end.y}`;
  }
  return path;
}

function unit(angle: number): Point {
  return offset({ x: 0, y: 0 }, angle, 1);
}

/** Each planet's index in the field, and the arcs of its events, by scope and event. */
function planetLookup(planets: readonly UniversePlanet[]) {
  const indexOf = new Map(planets.map(({ scope }, index) => [scope.id, index]));
  const arcs = new Map(
    planets.flatMap(({ scope, layout }) =>
      layout.events.map((arc) => [`${scope.id}|${arc.event.id}`, arc] as const),
    ),
  );
  const angles = new Map(
    planets.flatMap(({ scope, layout }) =>
      layout.workflows.map(({ workflow, angle }) => [`${scope.id}|${workflow.id}`, angle] as const),
    ),
  );
  return {
    indexOf: (scopeId: string) => indexOf.get(scopeId) ?? -1,
    eventArc: (scopeId: string, eventId: string) => arcs.get(`${scopeId}|${eventId}`),
    workflowAngle: (scopeId: string, workflowId: string) =>
      angles.get(`${scopeId}|${workflowId}`) ?? 0,
  };
}

/**
 * A forward's path and the middle of it, where its label goes. `landing` is the angle it lands at
 * on the orbit of the planet it reaches when nothing there listens to its event; null when it
 * lands on an event or on the ring of a planet still being read.
 */
export type DrawnForward = {
  forward: UniverseForward;
  path: string;
  middle: Point;
  landing: number | null;
};

/** The stretch of a planet's orbit that forwards nothing there listens to land on. */
export type OrbitLanding = {
  scopeId: string;
  forwards: readonly UniverseForward[];
  path: string;
};

/**
 * One stretch of orbit per planet and planet sending to it, under the forwards from there that
 * nothing on the planet listens to, so they have somewhere to land.
 */
export function orbitLandings(
  field: RouteField,
  planets: readonly UniversePlanet[],
  drawn: readonly DrawnForward[],
): OrbitLanding[] {
  const lookup = planetLookup(planets);
  const groups = new Map<
    string,
    { scopeId: string; forwards: UniverseForward[]; angles: number[] }
  >();
  for (const { forward, landing } of drawn) {
    if (landing === null) {
      continue;
    }
    const key = `${forward.fromScopeId}|${forward.toScopeId}`;
    const group = groups.get(key) ?? { scopeId: forward.toScopeId, forwards: [], angles: [] };
    group.forwards.push(forward);
    group.angles.push(landing);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(({ scopeId, forwards, angles }) => {
    const index = lookup.indexOf(scopeId);
    if (index === -1) {
      return [];
    }
    const center = field.obstacles[index].center;
    // Measured from the first, so a stretch across the top of the orbit does not wrap round it.
    const deltas = angles.map((angle) => shortestDelta(angles[0], angle));
    const from = angles[0] + Math.min(...deltas) - ORBIT_LANDING_MARGIN;
    const to = angles[0] + Math.max(...deltas) + ORBIT_LANDING_MARGIN;
    const start = offset(center, from, PLANET_ORBIT_RADIUS);
    const end = offset(center, to, PLANET_ORBIT_RADIUS);
    const large = to - from > Math.PI ? 1 : 0;
    return [
      {
        scopeId,
        forwards,
        path: `M ${start.x} ${start.y} A ${PLANET_ORBIT_RADIUS} ${PLANET_ORBIT_RADIUS} 0 ${large} 1 ${end.x} ${end.y}`,
      },
    ];
  });
}

/**
 * Each forward routed around every planet: out of its event, around whatever is in the way, and
 * straight into the same event in the other planet, onto the ring of a planet still being read, or
 * onto its orbit when nothing there listens.
 * Without a way around, as while planets overlap mid-drag, it curves straight across. `positions`
 * and the field follow the planets' order.
 */
export function routeForwards(
  field: RouteField,
  planets: readonly UniversePlanet[],
  forwards: readonly UniverseForward[],
): DrawnForward[] {
  const lookup = planetLookup(planets);
  // Forwards from one planet that land on another's orbit would all land on one spot, so each gets
  // its own, spread round the orbit either side of it.
  const orbitLandings = new Map<string, string[]>();
  for (const forward of forwards) {
    const to = lookup.indexOf(forward.toScopeId);
    if (
      to !== -1 &&
      planets[to].scope.status === undefined &&
      !lookup.eventArc(forward.toScopeId, forward.eventId)
    ) {
      const pair = `${forward.fromScopeId}|${forward.toScopeId}`;
      orbitLandings.set(pair, [...(orbitLandings.get(pair) ?? []), forward.id]);
    }
  }
  const spreadOf = (forward: UniverseForward) => {
    const landing = orbitLandings.get(`${forward.fromScopeId}|${forward.toScopeId}`) ?? [];
    const index = landing.indexOf(forward.id);
    if (index === -1) {
      return 0;
    }
    const step = Math.min(
      ORBIT_LANDING_SPREAD,
      MAX_ORBIT_LANDING_SPAN / Math.max(1, landing.length - 1),
    );
    return (index - (landing.length - 1) / 2) * step;
  };
  return forwards.flatMap((forward): DrawnForward[] => {
    const from = lookup.indexOf(forward.fromScopeId);
    const to = lookup.indexOf(forward.toScopeId);
    if (from === -1 || to === -1) {
      return [];
    }
    const fromCenter = field.obstacles[from].center;
    const toCenter = field.obstacles[to].center;
    const outward = bearing(fromCenter, toCenter);
    const departing = lookup.eventArc(forward.fromScopeId, forward.eventId);
    const arriving = lookup.eventArc(forward.toScopeId, forward.eventId);
    const departAngle = departing ? eventDepartureAngle(departing, outward) : outward;
    // A planet still being read draws no events yet, so forwards land on the ring around it.
    const ringed = !arriving && planets[to].scope.status !== undefined;
    const arriveAngle = arriving
      ? eventDepartureAngle(arriving, outward + Math.PI)
      : outward + Math.PI + spreadOf(forward);
    // A forward nothing listens to stops just outside the stretch of orbit it lands on.
    const arriveRadius = arriving
      ? PLANET_EVENT_EDGE_RADIUS + 4
      : ringed
        ? PLANET_STATUS_RING_RADIUS + PLANET_STATUS_RING_WIDTH / 2 + 4
        : PLANET_ORBIT_RADIUS + ORBIT_LANDING_GAP;
    const landing = arriving || ringed ? null : arriveAngle;
    const start = offset(fromCenter, departAngle, PLANET_EVENT_EDGE_RADIUS);
    const end = offset(toCenter, arriveAngle, arriveRadius);
    // A forward landing on an event, or on a planet's ring, crosses the workflow ring straight to
    // it: going round the ring first would turn it sharply onto the event. Workflows keep out of
    // the stretch facing close planets, where forwards come in.
    const shrunk = new Map(arriving || ringed ? [[to, arriveRadius + FORWARD_LANDING]] : []);
    const radius = shrunk.get(to) ?? field.obstacles[to].radius;
    const inward = unit(arriveAngle + Math.PI);
    const steps =
      from === to
        ? null
        : routeAround(
            field,
            { home: from, angle: departAngle },
            [
              {
                point: offset(toCenter, arriveAngle, radius),
                on: to,
                approach: { direction: inward, minimum: FORWARD_APPROACH },
              },
            ],
            shrunk,
          )[0];
    if (!steps) {
      return [{ forward, landing, ...curveAcross(start, departAngle, end, arriveAngle) }];
    }
    return [
      {
        forward,
        landing,
        path: routePath(
          { center: start, radius: 0, outward: unit(departAngle), ease: FORWARD_EASE },
          steps,
          end,
          { x: -inward.x, y: -inward.y },
          radius - arriveRadius,
        ),
        middle: along(steps, routeLength(steps) / 2).point,
      },
    ];
  });
}

/** A curve leaving `start` along `departAngle` and arriving at `end` from `arriveAngle`. */
function curveAcross(
  start: Point,
  departAngle: number,
  end: Point,
  arriveAngle: number,
): { path: string; middle: Point } {
  const pull = Math.min(900, Math.max(180, Math.hypot(end.x - start.x, end.y - start.y) * 0.4));
  const startControl = offset(start, departAngle, pull);
  const endControl = offset(end, arriveAngle, pull);
  return {
    path: `M ${start.x} ${start.y} C ${startControl.x} ${startControl.y} ${endControl.x} ${endControl.y} ${end.x} ${end.y}`,
    // The middle of a cubic Bézier curve.
    middle: {
      x: (start.x + 3 * startControl.x + 3 * endControl.x + end.x) / 8,
      y: (start.y + 3 * startControl.y + 3 * endControl.y + end.y) / 8,
    },
  };
}

/** A workflow on its planet, which is where a call leaves from. */
type CallOrigin = { home: number; angle: number; node: Point; nodeRadius: number };

/** A tile in world units: where it sits, which way is into the frame, and how long it is. */
type WorldTile = { center: Point; inward: Point; length: number };

/**
 * A call's route to the point in front of its tile, where it lines up to land. Calls come in
 * towards their tile; turning onto it from the side would kink, so they do only when coming in
 * square means a long way round, as for a workflow beside a planet right by the frame. A workflow
 * close to the frame may sit beyond a far point, so nearer points are tried too; one search finds
 * the way to all of them. Without any way around, as when planets overlap mid-drag, the call goes
 * straight.
 */
function routeToTile(
  field: RouteField,
  origin: CallOrigin,
  tile: WorldTile,
  front: number,
  scale: number,
): { steps: RouteStep[]; landing: number } {
  const toward = { x: -tile.inward.x, y: -tile.inward.y };
  const aimAt = (landing: number) => ({
    x: tile.center.x + tile.inward.x * (front + landing),
    y: tile.center.y + tile.inward.y * (front + landing),
  });
  const landings = LANDINGS.map((landing) => landing / scale);
  // A planet right by the tile would wall it off, so it only keeps calls out up to the points in
  // front of the tile.
  const shrunk = new Map<number, number>();
  for (const aim of landings.map(aimAt)) {
    field.obstacles.forEach((obstacle, index) => {
      const distance = Math.hypot(aim.x - obstacle.center.x, aim.y - obstacle.center.y);
      if (index !== origin.home && distance <= obstacle.radius) {
        shrunk.set(index, Math.max(0, Math.min(shrunk.get(index) ?? Infinity, distance - 1)));
      }
    });
  }
  const tries = [APPROACH, -1].flatMap((minimum) =>
    landings.map((landing) => ({ landing, square: minimum === APPROACH, minimum })),
  );
  const targets: RouteTarget[] = tries.map(({ landing, minimum }) => ({
    point: aimAt(landing),
    on: null,
    approach: { direction: toward, minimum },
  }));
  const found = routeAround(field, { home: origin.home, angle: origin.angle }, targets, shrunk);
  const routes = tries.flatMap((attempt, index) => {
    const steps = found[index];
    return steps ? [{ ...attempt, steps, length: routeLength(steps) + attempt.landing }] : [];
  });
  // The farthest point gives the gentlest landing, so it wins unless its route is clearly longer.
  function gentlest(candidates: typeof routes) {
    const shortest = Math.min(...candidates.map((route) => route.length));
    return candidates.find((route) => route.length <= shortest * LANDING_SLACK);
  }
  const square = gentlest(routes.filter((route) => route.square));
  const any = gentlest(routes);
  const chosen = square && (!any || square.length <= any.length * DETOUR_LIMIT) ? square : any;
  if (chosen) {
    return chosen;
  }
  return {
    steps: [{ kind: "line", from: origin.node, to: aimAt(landings[0]) }],
    landing: landings[0],
  };
}

export type DrawnCall = { call: UniverseCall; path: string };

/**
 * Routes calls to their tiles: the shortest way that keeps around every planet and its workflows,
 * landing square onto the tile. A tile's calls land side by side in the order they come in from,
 * so they do not cross on the way in. Each call is routed once, however often it is drawn.
 */
export function callRouter(
  field: RouteField,
  planets: readonly UniversePlanet[],
  tiles: readonly ExternalTile[],
  camera: Camera,
): (calls: readonly UniverseCall[]) => DrawnCall[] {
  const { scale } = camera;
  const lookup = planetLookup(planets);
  const worldTiles = new Map(
    tiles.map((tile) => [
      tile.external.id,
      { center: toWorld(camera, tile.center), inward: tile.inward, length: tile.length / scale },
    ]),
  );
  const front = TILE_FRONT / scale;
  // A workflow's circle, with a little room around it.
  const nodeRadius = PLANET_WORKFLOW_NODE_RADIUS * workflowGrowth(scale) + 3 / scale;
  const routed = new Map<string, { origin: CallOrigin; steps: RouteStep[]; landing: number }>();
  function route(call: UniverseCall, tile: WorldTile) {
    const known = routed.get(call.id);
    if (known) {
      return known;
    }
    const home = lookup.indexOf(call.scopeId);
    const angle = lookup.workflowAngle(call.scopeId, call.workflowId);
    const origin = {
      home,
      angle,
      node: offset(field.obstacles[home].center, angle, PLANET_ORBIT_RADIUS),
      nodeRadius,
    };
    const result = { origin, ...routeToTile(field, origin, tile, front, scale) };
    routed.set(call.id, result);
    return result;
  }
  return (calls) =>
    [...worldTiles].flatMap(([externalId, tile]) => {
      const across = { x: -tile.inward.y, y: tile.inward.x };
      const arriving = calls
        .filter((call) => call.externalId === externalId && lookup.indexOf(call.scopeId) !== -1)
        .map((call) => {
          const routedCall = route(call, tile);
          const from = stepStart(routedCall.steps[routedCall.steps.length - 1]).point;
          return { call, ...routedCall, order: from.x * across.x + from.y * across.y };
        })
        .sort((a, b) => a.order - b.order);
      const spread = tile.length * 0.6;
      return arriving.map(({ call, origin, steps, landing }, index) => {
        const shift = arriving.length === 1 ? 0 : (index / (arriving.length - 1) - 0.5) * spread;
        const end = {
          x: tile.center.x + across.x * shift + tile.inward.x * front,
          y: tile.center.y + across.y * shift + tile.inward.y * front,
        };
        return {
          call,
          path: routePath(
            {
              center: origin.node,
              radius: origin.nodeRadius,
              outward: unit(origin.angle),
              ease: origin.nodeRadius + ROUTE_CLEARANCE / scale,
            },
            steps,
            end,
            tile.inward,
            landing,
          ),
        };
      });
    });
}
