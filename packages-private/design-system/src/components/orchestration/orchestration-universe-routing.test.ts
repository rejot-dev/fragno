import { assert, describe, test } from "vitest";

import {
  arcSpan,
  distanceToSegment,
  routeAround,
  routeField,
  type Obstacle,
  type RouteStep,
  type RouteTarget,
} from "./orchestration-universe-routing";
import { offset, type Point } from "./radial-geometry";

type Scene = {
  obstacles: Obstacle[];
  start: { home: number; angle: number };
  target: RouteTarget;
};

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Planets scattered without overlapping, a start on one of them, and a target elsewhere. */
function scenes(count: number, planets: number, seed: number): Scene[] {
  const next = random(seed);
  return Array.from({ length: count }, () => {
    const span = Math.sqrt(planets) * 1300;
    const obstacles: Obstacle[] = [];
    while (obstacles.length < planets) {
      const center = { x: next() * span, y: next() * span };
      const radius = 380 + next() * 120;
      const apart = obstacles.every(
        (other) =>
          Math.hypot(other.center.x - center.x, other.center.y - center.y) >
          other.radius + radius + 40,
      );
      if (apart) {
        obstacles.push({ center, radius });
      }
    }
    const home = Math.floor(next() * planets);
    const start = { home, angle: next() * Math.PI * 2 };
    const direction = offset({ x: 0, y: 0 }, next() * Math.PI * 2, 1);
    const approach = { direction, minimum: [-1, -0.2, 0.2][Math.floor(next() * 3)] };
    if (next() < 0.5) {
      const on = (home + 1 + Math.floor(next() * (planets - 1))) % planets;
      const point = offset(obstacles[on].center, next() * Math.PI * 2, obstacles[on].radius);
      return { obstacles, start, target: { point, on, approach } };
    }
    let point: Point;
    do {
      point = { x: next() * span, y: next() * span };
    } while (
      obstacles.some(
        (obstacle) =>
          Math.hypot(obstacle.center.x - point.x, obstacle.center.y - point.y) < obstacle.radius,
      )
    );
    return { obstacles, start, target: { point, on: null, approach } };
  });
}

function stepEnds(step: RouteStep): [Point, Point] {
  return step.kind === "line"
    ? [step.from, step.to]
    : [
        offset(step.center, step.fromAngle, step.radius),
        offset(step.center, step.toAngle, step.radius),
      ];
}

function length(steps: readonly RouteStep[]): number {
  return steps.reduce(
    (sum, step) =>
      sum +
      (step.kind === "line"
        ? Math.hypot(step.to.x - step.from.x, step.to.y - step.from.y)
        : arcSpan(step.turn, step.fromAngle, step.toAngle) * step.radius),
    0,
  );
}

function near(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

const ANY_HEADING = { direction: { x: 0, y: 1 }, minimum: -1 };

describe("routing around planets", () => {
  test("routes run unbroken from the start to the target, outside every planet, arriving as asked", () => {
    let routed = 0;
    for (const planets of [3, 6, 12]) {
      for (const { obstacles, start, target } of scenes(60, planets, planets)) {
        const [steps] = routeAround(routeField(obstacles), start, [target], new Map());
        if (!steps) {
          continue;
        }
        routed += 1;
        const home = obstacles[start.home];
        assert.isTrue(near(stepEnds(steps[0])[0], offset(home.center, start.angle, home.radius)));
        assert.isTrue(near(stepEnds(steps[steps.length - 1])[1], target.point));
        steps.forEach((step, index) => {
          if (index > 0) {
            assert.isTrue(near(stepEnds(steps[index - 1])[1], stepEnds(step)[0]));
          }
          if (step.kind === "line") {
            for (const obstacle of obstacles) {
              assert.isAtLeast(
                distanceToSegment(obstacle.center, step.from, step.to),
                obstacle.radius - 1,
              );
            }
          }
        });
        const last = steps[steps.length - 1];
        if (last.kind === "line" && target.on === null) {
          const dx = last.to.x - last.from.x;
          const dy = last.to.y - last.from.y;
          const heading =
            (dx * target.approach.direction.x + dy * target.approach.direction.y) /
            Math.hypot(dx, dy);
          assert.isAtLeast(heading, target.approach.minimum - 1e-9);
        }
      }
    }
    // Most targets are reachable; the checks above ran on enough routes to mean something.
    assert.isAbove(routed, 150);
  });

  test("shrinking a planet in a shared field routes as a field built with it shrunk", () => {
    for (const { obstacles, start, target } of scenes(80, 6, 99)) {
      const on = target.on ?? (start.home + 1) % obstacles.length;
      const second = (on + 1) % obstacles.length;
      const shrunk = new Map([
        [on, obstacles[on].radius * 0.75],
        ...(second === start.home ? [] : [[second, obstacles[second].radius * 0.6] as const]),
      ]);
      const smaller = obstacles.map((obstacle, index) => ({
        ...obstacle,
        radius: shrunk.get(index) ?? obstacle.radius,
      }));
      // Aiming at the shrunk edge, inside where the planet was.
      const aim = {
        ...target,
        on,
        point: offset(
          smaller[on].center,
          Math.atan2(
            target.point.x - smaller[on].center.x,
            -(target.point.y - smaller[on].center.y),
          ),
          smaller[on].radius,
        ),
      };
      const [shared] = routeAround(routeField(obstacles), start, [aim], shrunk);
      const [rebuilt] = routeAround(routeField(smaller), start, [aim], new Map());
      assert.equal(shared === null, rebuilt === null);
      if (shared && rebuilt) {
        assert.closeTo(length(shared), length(rebuilt), 1e-6);
      }
    }
  });

  test("a route around its own planet turns the short way round to the line it leaves on", () => {
    const home = { center: { x: 0, y: 0 }, radius: 400 };
    const target = { point: { x: 0, y: 1000 }, on: null, approach: ANY_HEADING };
    // The lines from the target touch the planet 66.4° either side of straight down.
    const touching = Math.acos(400 / 1000);
    const line = Math.sqrt(1000 ** 2 - 400 ** 2);
    for (const startAngle of [Math.PI / 6, -Math.PI / 6]) {
      const [steps] = routeAround(
        routeField([home]),
        { home: 0, angle: startAngle },
        [target],
        new Map(),
      );
      assert.exists(steps);
      const turn = Math.PI - touching - Math.abs(startAngle);
      assert.closeTo(length(steps), turn * 400 + line, 1e-6);
    }
  });

  test("a line that only a shrunk planet stood in the way of is open", () => {
    // Three planets in a row, the middle one bigger; shrunk, it no longer blocks the lines
    // touching both outer planets below it.
    const obstacles = [
      { center: { x: 0, y: 0 }, radius: 400 },
      { center: { x: 1200, y: 0 }, radius: 500 },
      { center: { x: 2400, y: 0 }, radius: 400 },
    ];
    const start = { home: 0, angle: (Math.PI * 5) / 4 };
    const target = { point: { x: 2800, y: 0 }, on: 2, approach: ANY_HEADING };
    const shrunk = new Map([[1, 200]]);
    const [steps] = routeAround(routeField(obstacles), start, [target], shrunk);
    assert.exists(steps);
    // Round the first planet's bottom from 225° to 180°, along the line under all three, and
    // round the last planet's bottom from 180° to 90°.
    assert.closeTo(length(steps), (Math.PI / 4) * 400 + 2400 + (Math.PI / 2) * 400, 1e-6);
  });

  test("one search finds every target's route as a search per target would", () => {
    for (const { obstacles, start, target } of scenes(40, 8, 7)) {
      const field = routeField(obstacles);
      const targets: RouteTarget[] = [
        target,
        { ...target, approach: { ...target.approach, minimum: -1 } },
        ...scenes(1, 8, obstacles.length + Math.round(start.angle * 1000)).map((other) => ({
          ...other.target,
          on: null,
        })),
      ];
      const together = routeAround(field, start, targets, new Map());
      targets.forEach((each, index) => {
        const [alone] = routeAround(field, start, [each], new Map());
        const found = together[index];
        assert.equal(found === null, alone === null);
        if (found && alone) {
          assert.closeTo(length(found), length(alone), 1e-6);
        }
      });
    }
  });
});
