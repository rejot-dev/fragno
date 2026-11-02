import type { OrchestrationExternal } from "./orchestration-universe-model";
import { SANS_CHAR_WIDTH, type Point } from "./radial-geometry";

// The frame runs along the edges of the view, in screen pixels, and the outside systems sit on it
// as tiles straddling its line.
export const FRAME_INSET = 22;
export const TILE_THICKNESS = 22;
/** How far inside the view the planets have to stay to keep clear of the tiles. */
export const FRAME_PADDING = FRAME_INSET + TILE_THICKNESS / 2 + 14;
export const TILE_FONT = 11;
export const TILE_ICON = 12;
const TILE_GAP = 8;
// Tiles keep off the corners, where a tile would belong to two sides at once.
const CORNER = 40;

type Side = "top" | "right" | "bottom" | "left";

export type ExternalTile = {
  external: OrchestrationExternal;
  side: Side;
  center: Point;
  length: number;
  /** The unit vector from the tile into the frame. */
  inward: Point;
};

const INWARD: Record<Side, Point> = {
  top: { x: 0, y: 1 },
  right: { x: -1, y: 0 },
  bottom: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
};

function tileLength(external: OrchestrationExternal): number {
  return TILE_ICON + 6 + external.label.length * SANS_CHAR_WIDTH * (TILE_FONT / 12.5) + 20;
}

/**
 * Spreads tiles along one side without overlap, each as close to where it wants to be as the
 * others allow. Positions run along the side from `start` to `end`. Tiles that do not fit close
 * up, overlapping if they must, rather than leave the side.
 */
function spreadAlong(
  wanted: readonly { at: number; length: number }[],
  start: number,
  end: number,
): number[] {
  const order = wanted.map((_, index) => index).sort((a, b) => wanted[a].at - wanted[b].at);
  const placed = wanted.map(({ at }) => at);
  const lengths = wanted.reduce((total, { length }) => total + length, 0);
  const gap = Math.min(TILE_GAP, (end - start - lengths) / Math.max(1, wanted.length - 1));
  let previous: number | null = null;
  for (const index of order) {
    const { at, length } = wanted[index];
    const floor =
      previous === null
        ? start + length / 2
        : placed[previous] + (wanted[previous].length + length) / 2 + gap;
    placed[index] = Math.max(at, floor);
    previous = index;
  }
  let next: number | null = null;
  for (const index of order.toReversed()) {
    const { length } = wanted[index];
    const ceiling =
      next === null ? end - length / 2 : placed[next] - (wanted[next].length + length) / 2 - gap;
    placed[index] = Math.min(placed[index], ceiling);
    next = index;
  }
  return placed;
}

// Spots along the frame a tile is tried at, this far apart.
const CANDIDATE_STEP = 24;

const SIDES = ["top", "right", "bottom", "left"] as const;

function isHorizontal(side: Side): boolean {
  return side === "top" || side === "bottom";
}

/** Where tiles may sit along a side, clear of the corners. */
function sideSpan(side: Side, size: { width: number; height: number }) {
  const length = isHorizontal(side) ? size.width : size.height;
  return { start: FRAME_INSET + CORNER, end: length - FRAME_INSET - CORNER };
}

/** Where a side's line runs, across the view. */
function frameLine(side: Side, size: { width: number; height: number }): number {
  return {
    top: FRAME_INSET,
    bottom: size.height - FRAME_INSET,
    left: FRAME_INSET,
    right: size.width - FRAME_INSET,
  }[side];
}

/** A spot on the frame a tile could sit at: in screen pixels, with the unit vector inward. */
export type FrameSpot = { side: Side; at: number; point: Point; inward: Point };

/** Every spot along the frame a tile could sit at, clear of the corners. */
export function frameSpots(size: { width: number; height: number }): FrameSpot[] {
  const spots: FrameSpot[] = [];
  for (const side of SIDES) {
    const { start, end } = sideSpan(side, size);
    const across = frameLine(side, size);
    for (let at = start; at <= end; at += CANDIDATE_STEP) {
      const point = isHorizontal(side) ? { x: at, y: across } : { x: across, y: at };
      spots.push({ side, at, point, inward: INWARD[side] });
    }
  }
  return spots;
}

/**
 * Puts each outside system at the spot where it is cheapest to reach, by `cost` of the spot's
 * index in `spots`, on a side with room left for it, then spreads the tiles on each side so none
 * overlap. Systems that would lose most by moving to another side choose first.
 */
export function placeExternalTiles(
  externals: readonly OrchestrationExternal[],
  size: { width: number; height: number },
  spots: readonly FrameSpot[],
  cost: (external: OrchestrationExternal, spot: number) => number,
): ExternalTile[] {
  // Each system's cheapest spot on every side, cheapest side first.
  const options = externals.map((external) => {
    const cheapest = new Map<Side, { side: Side; at: number; cost: number }>();
    for (const [index, spot] of spots.entries()) {
      const spotCost = cost(external, index);
      if (spotCost < (cheapest.get(spot.side)?.cost ?? Infinity)) {
        cheapest.set(spot.side, { side: spot.side, at: spot.at, cost: spotCost });
      }
    }
    const sides = [...cheapest.values()].sort((a, b) => a.cost - b.cost);
    const regret = sides.length < 2 ? Infinity : sides[1].cost - sides[0].cost;
    return { external, length: tileLength(external), sides, regret };
  });
  // Each side holds tiles end to end with a gap between them.
  const room = new Map(
    SIDES.map((side) => {
      const { start, end } = sideSpan(side, size);
      return [side, end - start + TILE_GAP];
    }),
  );
  const bySide = new Map<Side, { external: OrchestrationExternal; at: number; length: number }[]>();
  for (const { external, length, sides } of options.toSorted((a, b) =>
    a.regret === b.regret ? 0 : a.regret < b.regret ? 1 : -1,
  )) {
    const roomOf = (side: Side) => room.get(side) ?? 0;
    // With no room anywhere, the roomiest side squeezes the tile in.
    const chosen =
      sides.find(({ side }) => roomOf(side) >= length + TILE_GAP) ??
      sides.reduce<(typeof sides)[number] | null>(
        (best, option) => (best && roomOf(best.side) >= roomOf(option.side) ? best : option),
        null,
      );
    if (!chosen) {
      continue;
    }
    room.set(chosen.side, roomOf(chosen.side) - length - TILE_GAP);
    bySide.set(chosen.side, [
      ...(bySide.get(chosen.side) ?? []),
      { external, at: chosen.at, length },
    ]);
  }

  return [...bySide].flatMap(([side, tiles]) => {
    const { start, end } = sideSpan(side, size);
    const placed = spreadAlong(tiles, start, end);
    const across = frameLine(side, size);
    return tiles.map(({ external, length }, index) => ({
      external,
      side,
      length,
      center: isHorizontal(side)
        ? { x: placed[index], y: across }
        : { x: across, y: placed[index] },
      inward: INWARD[side],
    }));
  });
}
