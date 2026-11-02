import { bearing, normalizeAngle, offset, type Point } from "./radial-geometry";

/** Space a route keeps out of: one planet with its workflows. */
export type Obstacle = { center: Point; radius: number };

/**
 * One stretch of a route: a straight line, or a turn along an obstacle's edge. `turn` is 1 for
 * clockwise and -1 for anticlockwise, and angles run clockwise from 12 o'clock.
 */
export type RouteStep =
  | { kind: "line"; from: Point; to: Point }
  | {
      kind: "arc";
      center: Point;
      radius: number;
      turn: 1 | -1;
      fromAngle: number;
      toAngle: number;
    };

/**
 * Where a route goes: a point it comes in to heading at least `approach.minimum` along
 * `approach.direction` (a cosine; -1 allows any heading). A point on the edge of an obstacle,
 * `on`, can also be reached along that edge.
 */
export type RouteTarget = {
  point: Point;
  on: number | null;
  approach: { direction: Point; minimum: number };
};

type Vertex = {
  point: Point;
  /** The obstacle the vertex lies on, or null for targets and the free start. */
  obstacle: number | null;
  angle: number;
  /** Which way a route moves along the obstacle through this vertex; 0 off any obstacle. */
  turn: 1 | -1 | 0;
};

type Edge = { to: number; cost: number };

/** A line touching two obstacles that some other obstacle stands in the way of. */
type BlockedLine = { a: number; b: number; from: Point; to: Point; blockers: readonly number[] };

/**
 * Every way between obstacles, worked out once for routes that share them: each clear line
 * touching two obstacles as a pair of vertices per direction, the vertices on each obstacle's edge
 * in order, and the blocked lines with what blocks them, for routes through shrunk obstacles.
 */
export type RouteField = {
  obstacles: readonly Obstacle[];
  vertices: readonly Vertex[];
  edges: readonly (readonly Edge[])[];
  /** Per obstacle and turn, at `obstacle * 2 + (turn === 1 ? 0 : 1)`, vertex ids by angle. */
  rims: readonly (readonly number[])[];
  blocked: readonly BlockedLine[];
};

/** The clockwise direction along a circle at `angle`. */
function clockwise(angle: number): Point {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** How far a route turning `turn` travels along a circle from one angle to another. */
export function arcSpan(turn: 1 | -1, fromAngle: number, toAngle: number): number {
  return normalizeAngle(turn * (toAngle - fromAngle));
}

/**
 * The lines touching both circles, as pairs of touching points; a point is a circle of radius
 * zero. Lines with both circles on one side come first, then lines passing between them.
 */
function touchingLines(
  first: Point,
  firstRadius: number,
  second: Point,
  secondRadius: number,
): [Point, Point][] {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return [];
  }
  if (firstRadius === 0 && secondRadius === 0) {
    return [[first, second]];
  }
  const ux = dx / distance;
  const uy = dy / distance;
  const lines: [Point, Point][] = [];
  // A point has one pair of touching lines; the second side would only repeat them.
  const sides = firstRadius === 0 || secondRadius === 0 ? [1] : [1, -1];
  for (const side of sides) {
    const cos = (firstRadius - side * secondRadius) / distance;
    if (Math.abs(cos) > 1) {
      continue;
    }
    const sin = Math.sqrt(1 - cos * cos);
    for (const hand of [1, -1]) {
      const nx = ux * cos - hand * uy * sin;
      const ny = uy * cos + hand * ux * sin;
      lines.push([
        { x: first.x + firstRadius * nx, y: first.y + firstRadius * ny },
        { x: second.x + side * secondRadius * nx, y: second.y + side * secondRadius * ny },
      ]);
    }
  }
  return lines;
}

export function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const along =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length));
  return Math.hypot(point.x - from.x - along * dx, point.y - from.y - along * dy);
}

// Lines may graze an obstacle by this much, so lines touching it count as clear.
const GRAZE = 0.5;

function blocks(obstacle: Obstacle, from: Point, to: Point): boolean {
  return distanceToSegment(obstacle.center, from, to) < obstacle.radius - GRAZE;
}

/** Where a line touching an obstacle meets it, and which way along the edge it runs there. */
function touch(obstacles: readonly Obstacle[], at: number, point: Point, direction: Point): Vertex {
  const angle = bearing(obstacles[at].center, point);
  const along = clockwise(angle);
  return {
    point,
    obstacle: at,
    angle,
    turn: direction.x * along.x + direction.y * along.y >= 0 ? 1 : -1,
  };
}

function rimIndex(obstacle: number, turn: 1 | -1): number {
  return obstacle * 2 + (turn === 1 ? 0 : 1);
}

/** Every way between the obstacles, for routes among them. */
export function routeField(obstacles: readonly Obstacle[]): RouteField {
  const vertices: Vertex[] = [];
  const edges: Edge[][] = [];
  const blocked: BlockedLine[] = [];
  function add(vertex: Vertex): number {
    vertices.push(vertex);
    edges.push([]);
    return vertices.length - 1;
  }
  for (let a = 0; a < obstacles.length; a += 1) {
    for (let b = a + 1; b < obstacles.length; b += 1) {
      const lines = touchingLines(
        obstacles[a].center,
        obstacles[a].radius,
        obstacles[b].center,
        obstacles[b].radius,
      );
      for (const [from, to] of lines) {
        const blockers = obstacles.flatMap((obstacle, at) =>
          at !== a && at !== b && blocks(obstacle, from, to) ? [at] : [],
        );
        if (blockers.length > 0) {
          blocked.push({ a, b, from, to, blockers });
          continue;
        }
        const forward = { x: to.x - from.x, y: to.y - from.y };
        const backward = { x: -forward.x, y: -forward.y };
        const cost = Math.hypot(forward.x, forward.y);
        edges[add(touch(obstacles, a, from, forward))].push({
          to: add(touch(obstacles, b, to, forward)),
          cost,
        });
        edges[add(touch(obstacles, b, to, backward))].push({
          to: add(touch(obstacles, a, from, backward)),
          cost,
        });
      }
    }
  }
  const rims: number[][] = Array.from({ length: obstacles.length * 2 }, () => []);
  vertices.forEach((vertex, id) => {
    if (vertex.obstacle !== null && vertex.turn !== 0) {
      rims[rimIndex(vertex.obstacle, vertex.turn)].push(id);
    }
  });
  for (const rim of rims) {
    rim.sort(
      (left, right) => normalizeAngle(vertices[left].angle) - normalizeAngle(vertices[right].angle),
    );
  }
  return { obstacles, vertices, edges, rims, blocked };
}

/** A binary heap of vertices by cost, which may hold a vertex more than once. */
function heap() {
  const ids: number[] = [];
  const costs: number[] = [];
  function swap(i: number, j: number) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    [costs[i], costs[j]] = [costs[j], costs[i]];
  }
  return {
    get size() {
      return ids.length;
    },
    push(id: number, cost: number) {
      ids.push(id);
      costs.push(cost);
      let at = ids.length - 1;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (costs[parent] <= costs[at]) {
          break;
        }
        swap(at, parent);
        at = parent;
      }
    },
    pop(): { id: number; cost: number } {
      const top = { id: ids[0], cost: costs[0] };
      const lastId = ids.pop()!;
      const lastCost = costs.pop()!;
      if (ids.length > 0) {
        ids[0] = lastId;
        costs[0] = lastCost;
        let at = 0;
        for (;;) {
          const left = at * 2 + 1;
          const right = left + 1;
          let smallest = at;
          if (left < ids.length && costs[left] < costs[smallest]) {
            smallest = left;
          }
          if (right < ids.length && costs[right] < costs[smallest]) {
            smallest = right;
          }
          if (smallest === at) {
            break;
          }
          swap(at, smallest);
          at = smallest;
        }
      }
      return top;
    },
  };
}

/**
 * The shortest route to each target from a point on the edge of the `start.home` obstacle that
 * keeps out of every obstacle: straight lines touching obstacles, joined by turns along their
 * edges. Routes leave `home` outward or along its edge, never through it. `shrunk` holds smaller
 * radii for obstacles routes may cut into. One search serves every target, since they share their
 * start. Null for a target no route reaches, such as one inside an obstacle.
 */
export function routeAround(
  field: RouteField,
  start: { home: number; angle: number },
  targets: readonly RouteTarget[],
  shrunk: ReadonlyMap<number, number>,
): (RouteStep[] | null)[] {
  const obstacles = field.obstacles.map((obstacle, at) => {
    const radius = shrunk.get(at);
    return radius === undefined ? obstacle : { ...obstacle, radius };
  });
  const known = field.vertices.length;
  // Vertices and edges this route adds to the field's; ids carry on after the field's own.
  const added: Vertex[] = [];
  const addedEdges: Edge[][] = [];
  const vertexAt = (id: number) => (id < known ? field.vertices[id] : added[id - known]);
  // A field vertex on a shrunk obstacle is gone: it touched the obstacle where it no longer is.
  const gone = (id: number) => {
    const { obstacle } = vertexAt(id);
    return id < known && obstacle !== null && shrunk.has(obstacle);
  };
  function add(vertex: Vertex): number {
    added.push(vertex);
    addedEdges.push([]);
    return known + added.length - 1;
  }
  // Only added vertices get edges here; the field's keep the ones it gave them.
  function link(from: number, to: number, cost: number) {
    addedEdges[from - known].push({ to, cost });
  }
  function clear(from: Point, to: Point, skip: readonly number[]): boolean {
    return obstacles.every((obstacle, at) => skip.includes(at) || !blocks(obstacle, from, to));
  }
  function linkBetween(a: number, b: number, from: Point, to: Point) {
    const forward = { x: to.x - from.x, y: to.y - from.y };
    const backward = { x: -forward.x, y: -forward.y };
    const cost = Math.hypot(forward.x, forward.y);
    link(add(touch(obstacles, a, from, forward)), add(touch(obstacles, b, to, forward)), cost);
    link(add(touch(obstacles, b, to, backward)), add(touch(obstacles, a, from, backward)), cost);
  }

  const startPoint = offset(
    obstacles[start.home].center,
    start.angle,
    obstacles[start.home].radius,
  );
  const outward = { x: Math.sin(start.angle), y: -Math.cos(start.angle) };
  const freeStart = add({ point: startPoint, obstacle: null, angle: start.angle, turn: 0 });
  const homeStarts = ([1, -1] as const).map((turn) =>
    add({ point: startPoint, obstacle: start.home, angle: start.angle, turn }),
  );

  // Each target's vertices, any of which reaches it.
  const goalOf = new Map<number, number>();
  const goals = targets.map((target, index) => {
    const free = add({ point: target.point, obstacle: null, angle: 0, turn: 0 });
    goalOf.set(free, index);
    if (target.on !== null) {
      const angle = bearing(obstacles[target.on].center, target.point);
      for (const turn of [1, -1] as const) {
        goalOf.set(add({ point: target.point, obstacle: target.on, angle, turn }), index);
      }
    }
    return free;
  });
  function approaches(target: RouteTarget, direction: Point): boolean {
    const length = Math.hypot(direction.x, direction.y) || 1;
    return (
      (direction.x * target.approach.direction.x + direction.y * target.approach.direction.y) /
        length >=
      target.approach.minimum
    );
  }

  // From the start, straight out: to each target or onto other obstacles.
  const destinations = [
    ...targets.map((target, index) => ({ target: index, at: -1, center: target.point, radius: 0 })),
    ...obstacles.map((obstacle, at) => ({ target: -1, at, ...obstacle })),
  ];
  for (const destination of destinations) {
    if (destination.at === start.home) {
      continue;
    }
    for (const [from, to] of touchingLines(startPoint, 0, destination.center, destination.radius)) {
      const direction = { x: to.x - from.x, y: to.y - from.y };
      if (direction.x * outward.x + direction.y * outward.y < -1e-6) {
        continue;
      }
      if (!clear(from, to, [start.home, destination.at])) {
        continue;
      }
      if (destination.target !== -1 && !approaches(targets[destination.target], direction)) {
        continue;
      }
      const end =
        destination.target !== -1
          ? goals[destination.target]
          : add(touch(obstacles, destination.at, to, direction));
      link(freeStart, end, Math.hypot(direction.x, direction.y));
    }
  }

  // Lines touching a shrunk obstacle are new; lines it alone blocked may be clear now.
  for (const a of shrunk.keys()) {
    for (let b = 0; b < obstacles.length; b += 1) {
      if (b === a || (shrunk.has(b) && b < a)) {
        continue;
      }
      for (const [from, to] of touchingLines(
        obstacles[a].center,
        obstacles[a].radius,
        obstacles[b].center,
        obstacles[b].radius,
      )) {
        if (clear(from, to, [a, b])) {
          linkBetween(a, b, from, to);
        }
      }
    }
  }
  for (const line of field.blocked) {
    if (
      !shrunk.has(line.a) &&
      !shrunk.has(line.b) &&
      line.blockers.every((at) => shrunk.has(at) && !blocks(obstacles[at], line.from, line.to))
    ) {
      linkBetween(line.a, line.b, line.from, line.to);
    }
  }

  // From every obstacle in to each target.
  targets.forEach((target, index) => {
    obstacles.forEach((obstacle, a) => {
      for (const [to, from] of touchingLines(target.point, 0, obstacle.center, obstacle.radius)) {
        if (a === target.on || !clear(from, to, [a])) {
          continue;
        }
        const direction = { x: to.x - from.x, y: to.y - from.y };
        if (approaches(target, direction)) {
          link(
            add(touch(obstacles, a, from, direction)),
            goals[index],
            Math.hypot(direction.x, direction.y),
          );
        }
      }
    });
  });

  // Along each obstacle's edge a route only ever moves on to the next vertex its way round: going
  // further is going on from there, at the same cost.
  const total = known + added.length;
  const next = new Int32Array(total).fill(-1);
  const nextCost = new Float64Array(total);
  const addedRims: number[][] = Array.from({ length: obstacles.length * 2 }, () => []);
  added.forEach((vertex, index) => {
    if (vertex.obstacle !== null && vertex.turn !== 0) {
      addedRims[rimIndex(vertex.obstacle, vertex.turn)].push(known + index);
    }
  });
  const angleOf = (id: number) => normalizeAngle(vertexAt(id).angle);
  addedRims.forEach((extra, rim) => {
    const obstacle = rim >> 1;
    const turn = rim % 2 === 0 ? 1 : -1;
    const own = shrunk.has(obstacle) ? [] : field.rims[rim];
    extra.sort((left, right) => angleOf(left) - angleOf(right));
    const merged: number[] = [];
    let i = 0;
    let j = 0;
    while (i < own.length || j < extra.length) {
      if (j >= extra.length || (i < own.length && angleOf(own[i]) <= angleOf(extra[j]))) {
        merged.push(own[i]);
        i += 1;
      } else {
        merged.push(extra[j]);
        j += 1;
      }
    }
    if (merged.length < 2) {
      return;
    }
    const radius = obstacles[obstacle].radius;
    merged.forEach((id, at) => {
      const following = merged[(at + turn + merged.length) % merged.length];
      next[id] = following;
      nextCost[id] = arcSpan(turn, vertexAt(id).angle, vertexAt(following).angle) * radius;
    });
  });

  const cost = new Float64Array(total).fill(Infinity);
  const previous = new Int32Array(total).fill(-1);
  const done = new Uint8Array(total);
  const queue = heap();
  for (const source of [freeStart, ...homeStarts]) {
    cost[source] = 0;
    queue.push(source, 0);
  }
  const reached: number[] = targets.map(() => -1);
  let unreached = targets.length;
  function relax(from: number, to: number, step: number) {
    if (done[to] || gone(to)) {
      return;
    }
    const through = cost[from] + step;
    if (through < cost[to]) {
      cost[to] = through;
      previous[to] = from;
      queue.push(to, through);
    }
  }
  while (queue.size > 0 && unreached > 0) {
    const { id } = queue.pop();
    if (done[id]) {
      continue;
    }
    done[id] = 1;
    const target = goalOf.get(id);
    if (target !== undefined && reached[target] === -1) {
      reached[target] = id;
      unreached -= 1;
    }
    if (gone(id)) {
      continue;
    }
    for (const edge of id < known ? field.edges[id] : addedEdges[id - known]) {
      relax(id, edge.to, edge.cost);
    }
    if (next[id] !== -1) {
      relax(id, next[id], nextCost[id]);
    }
  }

  return reached.map((goal) => {
    if (goal === -1) {
      return null;
    }
    const path: Vertex[] = [];
    for (let at = goal; at !== -1; at = previous[at]) {
      path.push(vertexAt(at));
    }
    path.reverse();
    const steps: RouteStep[] = [];
    for (let at = 1; at < path.length; at += 1) {
      const from = path[at - 1];
      const to = path[at];
      if (from.obstacle !== null && from.obstacle === to.obstacle && from.turn !== 0) {
        const last = steps.at(-1);
        // A turn passes vertices on its way round; it is still one turn. Even a sliver of a turn
        // is kept, or the route would break where it should be.
        if (last?.kind === "arc" && last.center === obstacles[from.obstacle].center) {
          last.toAngle = to.angle;
        } else if (arcSpan(from.turn, from.angle, to.angle) > 0) {
          steps.push({
            kind: "arc",
            center: obstacles[from.obstacle].center,
            radius: obstacles[from.obstacle].radius,
            turn: from.turn,
            fromAngle: from.angle,
            toAngle: to.angle,
          });
        }
      } else {
        steps.push({ kind: "line", from: from.point, to: to.point });
      }
    }
    return steps;
  });
}
