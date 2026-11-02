import { assert, describe, test } from "vitest";

import { UNIVERSE } from "./orchestration-graph-story-support";
import {
  FRAME_INSET,
  frameSpots,
  placeExternalTiles,
  type ExternalTile,
} from "./orchestration-universe-frame";

/** Every system wants the middle of the top edge, as when one planet just below calls them all. */
function placedAtTop(size: { width: number; height: number }): ExternalTile[] {
  const spots = frameSpots(size);
  return placeExternalTiles(UNIVERSE.externals, size, spots, (_, index) =>
    Math.hypot(spots[index].point.x - size.width / 2, spots[index].point.y),
  );
}

/** Where a tile starts and ends along its side. */
function extent(tile: ExternalTile): [number, number] {
  const along = tile.side === "top" || tile.side === "bottom" ? tile.center.x : tile.center.y;
  return [along - tile.length / 2, along + tile.length / 2];
}

function assertInside(tiles: readonly ExternalTile[], size: { width: number; height: number }) {
  for (const tile of tiles) {
    const [from, to] = extent(tile);
    const side = tile.side === "top" || tile.side === "bottom" ? size.width : size.height;
    assert.isAtLeast(from, FRAME_INSET, `${tile.external.id} starts inside the frame`);
    assert.isAtMost(to, side - FRAME_INSET, `${tile.external.id} ends inside the frame`);
  }
}

describe("outside systems on the frame", () => {
  test("systems that do not fit on the side they want move to sides with room", () => {
    const size = { width: 600, height: 420 };
    const tiles = placedAtTop(size);
    assert.equal(tiles.length, UNIVERSE.externals.length);
    assertInside(tiles, size);
    assert.isAbove(tiles.filter(({ side }) => side === "top").length, 1);
    for (const a of tiles) {
      for (const b of tiles) {
        if (a !== b && a.side === b.side) {
          const [aFrom, aTo] = extent(a);
          const [bFrom, bTo] = extent(b);
          assert.isTrue(aTo <= bFrom || bTo <= aFrom, `${a.external.id} and ${b.external.id}`);
        }
      }
    }
  });

  test("in a frame too small for every system, tiles squeeze up rather than leave it", () => {
    const size = { width: 260, height: 220 };
    const tiles = placedAtTop(size);
    assert.equal(tiles.length, UNIVERSE.externals.length);
    assertInside(tiles, size);
  });
});
