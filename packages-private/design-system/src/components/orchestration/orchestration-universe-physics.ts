import type { OrchestrationUniverseScope, UniverseForward } from "./orchestration-universe-model";
import type { Point } from "./radial-geometry";

// Planets are about 1000 units across with their workflows; linked planets rest this far apart,
// which leaves room for the forwards between them.
export const LINK_DISTANCE = 1150;
const LINK_STRENGTH = 0.08;
// Centres closer than this overlap.
const PLANET_CLEARANCE = 1050;
const COLLIDE_STRENGTH = 0.35;
const CHARGE = 4e7;
const GRAVITY = 0.004;
// Each planet gets about this much of the room, so a few planets on a wide screen spread wide.
const ROOM_PER_PLANET = LINK_DISTANCE * LINK_DISTANCE * 0.6;
const CONTAIN_STRENGTH = 0.08;
const VELOCITY_DECAY = 0.4;
// Cools from 1 to `ALPHA_MIN` in about 300 ticks, five seconds at 60 frames a second.
export const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 300);

/**
 * Where planets are seeded before the simulation settles them: the scope most forwards touch in
 * the middle, the rest in order on a ring around it. Planets seeded in a line stay in one, since
 * every force between them runs along it, so a hub's two neighbours start as a wide triangle with
 * it rather than on either side of it; a pair without a hub sits side by side, as views are wider
 * than tall.
 */
function seedPositions(
  scopes: readonly OrchestrationUniverseScope[],
  forwards: readonly UniverseForward[],
): Map<string, Point> {
  const degrees = new Map<string, number>();
  for (const { fromScopeId, toScopeId } of forwards) {
    degrees.set(fromScopeId, (degrees.get(fromScopeId) ?? 0) + 1);
    degrees.set(toScopeId, (degrees.get(toScopeId) ?? 0) + 1);
  }
  const degree = (scopeId: string) => degrees.get(scopeId) ?? 0;
  const hub =
    scopes.length >= 3
      ? scopes.reduce((busiest, scope) => (degree(scope.id) > degree(busiest.id) ? scope : busiest))
      : null;
  const ring = scopes.filter((scope) => scope !== hub);
  const radius =
    ring.length <= 1
      ? hub
        ? LINK_DISTANCE
        : 0
      : Math.max(LINK_DISTANCE, LINK_DISTANCE / (2 * Math.sin(Math.PI / ring.length)));
  const positions = new Map<string, Point>();
  if (hub) {
    positions.set(hub.id, { x: 0, y: 0 });
  }
  // Angles run clockwise from straight up.
  const angleOf = (index: number) =>
    ring.length === 2
      ? (hub ? [-Math.PI / 3, Math.PI / 3] : [-Math.PI / 2, Math.PI / 2])[index]
      : (index / ring.length) * Math.PI * 2;
  ring.forEach((scope, index) => {
    const angle = angleOf(index);
    positions.set(scope.id, { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) });
  });
  return positions;
}

/** A planet in the simulation; velocity is in world units per tick. */
export type Body = { x: number; y: number; vx: number; vy: number };

/** The planet someone holds, and where the pointer holds it. */
export type HeldBody = { scopeId: string; at: Point };

/** Where planet centres are kept, around the origin, in the shape of the view showing them. */
export type UniverseRoom = { halfWidth: number; halfHeight: number };

/** A room as wide for its height as the view, with space for every planet. */
export function universeRoom(planetCount: number, aspect: number): UniverseRoom {
  const width = Math.sqrt(Math.max(1, planetCount) * ROOM_PER_PLANET * aspect);
  return { halfWidth: width / 2, halfHeight: width / aspect / 2 };
}

/** Scopes that forward to each other, once per pair whichever way the forwards run. */
export type UniverseLink = { a: string; b: string };

export function universeLinks(forwards: readonly UniverseForward[]): UniverseLink[] {
  const links = new Map<string, UniverseLink>();
  for (const { fromScopeId, toScopeId } of forwards) {
    if (fromScopeId !== toScopeId) {
      const [a, b] = [fromScopeId, toScopeId].sort();
      links.set(`${a}|${b}`, { a, b });
    }
  }
  return [...links.values()];
}

/**
 * One tick of the forces between planets, scaled by `alpha`, which cools towards zero as the
 * layout settles. Linked planets pull towards `LINK_DISTANCE` apart, every planet pushes every
 * other away and harder once they overlap, and the walls of the room push back planets that
 * leave it, so planets spread to fill its shape. A weak pull towards the origin keeps the group
 * centred. A held planet follows the pointer, and what it moved last becomes its velocity, so
 * letting go mid-drag throws it.
 */
export function stepUniverse(
  bodies: ReadonlyMap<string, Body>,
  links: readonly UniverseLink[],
  room: UniverseRoom,
  alpha: number,
  held: HeldBody | null,
): Map<string, Body> {
  const next = new Map([...bodies].map(([id, body]) => [id, { ...body }]));
  const entries = [...next.values()];

  for (const { a, b } of links) {
    const from = next.get(a);
    const to = next.get(b);
    if (!from || !to) {
      continue;
    }
    const dx = to.x + to.vx - from.x - from.vx;
    const dy = to.y + to.vy - from.y - from.vy;
    const distance = Math.hypot(dx, dy) || 1;
    const pull = ((distance - LINK_DISTANCE) / distance) * LINK_STRENGTH * alpha * 0.5;
    to.vx -= dx * pull;
    to.vy -= dy * pull;
    from.vx += dx * pull;
    from.vy += dy * pull;
  }

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const first = entries[i];
      const second = entries[j];
      let dx = second.x - first.x;
      let dy = second.y - first.y;
      // Planets on the same spot have no direction to push in, so they get one.
      if (dx === 0 && dy === 0) {
        dx = (j - i) * 0.5;
        dy = (i - j) * 0.3;
      }
      const distance = Math.hypot(dx, dy);
      const charge = (CHARGE * alpha) / (distance * distance);
      // Overlap is resolved whatever the temperature, so a dragged planet shoulders others aside.
      const overlap =
        distance < PLANET_CLEARANCE
          ? ((PLANET_CLEARANCE - distance) / PLANET_CLEARANCE) * COLLIDE_STRENGTH
          : 0;
      const push = (charge + overlap * distance) / distance / 2;
      second.vx += dx * push;
      second.vy += dy * push;
      first.vx -= dx * push;
      first.vy -= dy * push;
    }
  }

  for (const [id, body] of next) {
    if (held?.scopeId === id) {
      body.vx = held.at.x - body.x;
      body.vy = held.at.y - body.y;
      body.x = held.at.x;
      body.y = held.at.y;
      continue;
    }
    const outsideX = Math.sign(body.x) * Math.max(0, Math.abs(body.x) - room.halfWidth);
    const outsideY = Math.sign(body.y) * Math.max(0, Math.abs(body.y) - room.halfHeight);
    body.vx =
      (body.vx - body.x * GRAVITY * alpha - outsideX * CONTAIN_STRENGTH) * (1 - VELOCITY_DECAY);
    body.vy =
      (body.vy - body.y * GRAVITY * alpha - outsideY * CONTAIN_STRENGTH) * (1 - VELOCITY_DECAY);
    body.x += body.vx;
    body.y += body.vy;
  }
  return next;
}

/** Moves `alpha` one tick towards `target`, the way the simulation heats up and cools down. */
export function coolUniverse(alpha: number, target: number): number {
  return alpha + (target - alpha) * ALPHA_DECAY;
}

/**
 * Every scope's planet where it starts: where it already is, or else its seed. New scopes join an
 * arrangement instead of reshuffling it.
 */
export function seedUniverse(
  scopes: readonly OrchestrationUniverseScope[],
  forwards: readonly UniverseForward[],
  placed: ReadonlyMap<string, Body>,
): Map<string, Body> {
  const seeds = seedPositions(scopes, forwards);
  return new Map(
    scopes.map((scope) => {
      const seed = seeds.get(scope.id) ?? { x: 0, y: 0 };
      return [scope.id, placed.get(scope.id) ?? { ...seed, vx: 0, vy: 0 }];
    }),
  );
}

/** Where the planets come to rest from here when nobody touches them. */
export function settleUniverse(
  bodies: ReadonlyMap<string, Body>,
  links: readonly UniverseLink[],
  room: UniverseRoom,
): Map<string, Body> {
  let settled = new Map(bodies);
  for (let alpha = 1; alpha > ALPHA_MIN; alpha = coolUniverse(alpha, 0)) {
    settled = stepUniverse(settled, links, room, alpha, null);
  }
  return new Map([...settled].map(([id, body]) => [id, { ...body, vx: 0, vy: 0 }]));
}
