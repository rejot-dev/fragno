/**
 * Geometry shared by the radial graphs. Angles are radians, clockwise from 12 o'clock, and every
 * graph draws in a viewBox centred on the origin.
 */

const TAU = Math.PI * 2;

export type Point = { x: number; y: number };

// Rough glyph widths for the fonts radial graphs use; labels only need to avoid overflowing their slot.
export const MONO_CHAR_WIDTH = 6.7;
export const SANS_CHAR_WIDTH = 6.9;

/** Where an angle and radius land in a viewBox centred on the origin. */
export function polar(angle: number, radius: number): [number, number] {
  return [radius * Math.sin(angle), -radius * Math.cos(angle)];
}

/** Where an angle and radius land around `origin`. */
export function offset(origin: Point, angle: number, radius: number): Point {
  return { x: origin.x + radius * Math.sin(angle), y: origin.y - radius * Math.cos(angle) };
}

/** The angle of `to` as seen from `from`. */
export function bearing(from: Point, to: Point): number {
  return Math.atan2(to.x - from.x, -(to.y - from.y));
}

export function point(angle: number, radius: number): string {
  const [x, y] = polar(angle, radius);
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

export function degrees(angle: number): number {
  return (angle * 180) / Math.PI;
}

function isLowerHalf(angle: number): boolean {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return normalized > Math.PI / 2 && normalized < (Math.PI * 3) / 2;
}

export function isLeftHalf(angle: number): boolean {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return normalized > Math.PI;
}

export function annularSector(
  startAngle: number,
  endAngle: number,
  inner: number,
  outer: number,
): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${point(startAngle, outer)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${point(endAngle, outer)}`,
    `L ${point(endAngle, inner)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${point(startAngle, inner)}`,
    "Z",
  ].join(" ");
}

// Text on the lower half runs the other way round so it never reads upside down. Chrome does not
// re-lay out a textPath when its path changes, so each label is keyed on the path it follows.
export function labelArc(startAngle: number, endAngle: number, radius: number): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return isLowerHalf((startAngle + endAngle) / 2)
    ? `M ${point(endAngle, radius)} A ${radius} ${radius} 0 ${largeArc} 0 ${point(startAngle, radius)}`
    : `M ${point(startAngle, radius)} A ${radius} ${radius} 0 ${largeArc} 1 ${point(endAngle, radius)}`;
}

/**
 * A link drawn in polar space: it leaves and arrives along the radius and turns in between, so a
 * link between distant angles follows the ring instead of cutting a chord through the middle.
 * `bulge` pushes the turn outward, which lets a link return to a ring further in.
 */
export function polarLink(
  fromAngle: number,
  fromRadius: number,
  toAngle: number,
  toRadius: number,
  bulge: number,
): string {
  const turn = shortestDelta(fromAngle, toAngle);
  const steps = 16 + Math.ceil(Math.abs(turn) * 24);
  const points: string[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const eased = t * t * (3 - 2 * t);
    const radius = fromRadius + (toRadius - fromRadius) * t + bulge * Math.sin(Math.PI * t);
    points.push(point(fromAngle + turn * eased, radius));
  }
  return `M ${points.join(" L ")}`;
}

/** The signed turn from one angle to another the short way round. */
export function shortestDelta(from: number, to: number): number {
  const delta = normalizeAngle(to - from);
  return delta > Math.PI ? delta - TAU : delta;
}

export function fitLabel(text: string, available: number, charWidth: number): string | null {
  if (text.length * charWidth <= available) {
    return text;
  }
  const characters = Math.floor(available / charWidth) - 1;
  return characters < 4 ? null : `${text.slice(0, characters)}…`;
}

export function normalizeAngle(angle: number): number {
  // Layout searches call this in their inner loops, mostly with angles a turn either side, where
  // adding or taking a turn beats the remainder of a float division.
  if (angle >= 0 && angle < TAU) {
    return angle;
  }
  if (angle < 0 && angle >= -TAU) {
    return angle + TAU === TAU ? 0 : angle + TAU;
  }
  if (angle >= TAU && angle < TAU * 2) {
    return angle - TAU;
  }
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

export function circularMean(samples: readonly { angle: number; weight: number }[]): number {
  let x = 0;
  let y = 0;
  for (const { angle, weight } of samples) {
    x += Math.sin(angle) * weight;
    y += Math.cos(angle) * weight;
  }
  return normalizeAngle(Math.atan2(x, y));
}

/** Pushes neighbours apart around the ring until every pair is at least `gap` apart. */
export function spreadAround(angles: readonly number[], gap: number): number[] {
  if (angles.length < 2) {
    return [...angles];
  }
  const minGap = Math.min(gap, TAU / angles.length);
  const order = angles.map((angle, index) => ({ angle, index }));
  for (let iteration = 0; iteration < 200; iteration += 1) {
    // A push can carry a point past its neighbour, so neighbours are found again every sweep.
    for (const item of order) {
      item.angle = normalizeAngle(item.angle);
    }
    order.sort((left, right) => left.angle - right.angle);
    let moved = false;
    for (let position = 0; position < order.length; position += 1) {
      const current = order[position];
      const next = order[(position + 1) % order.length];
      const distance = normalizeAngle(next.angle - current.angle);
      if (distance < minGap - 1e-6) {
        const push = (minGap - distance) / 2;
        current.angle -= push;
        next.angle += push;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  const spread: number[] = [];
  for (const { angle, index } of order) {
    spread[index] = normalizeAngle(angle);
  }
  return spread;
}
