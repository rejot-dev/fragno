import { FRAME_PADDING } from "./orchestration-universe-frame";
import type { Point } from "./radial-geometry";
import { PLANET_ORBIT_RADIUS } from "./workflow-trigger-planet";

/** World units become screen pixels as `world * scale + offset`. */
export type Camera = { x: number; y: number; scale: number };
export type Size = { width: number; height: number };

const MIN_SCALE = 0.06;
const MAX_SCALE = 2;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function zoomAt(camera: Camera, screenX: number, screenY: number, factor: number): Camera {
  const scale = clampScale(camera.scale * factor);
  const worldX = (screenX - camera.x) / camera.scale;
  const worldY = (screenY - camera.y) / camera.scale;
  return { x: screenX - worldX * scale, y: screenY - worldY * scale, scale };
}

/** Where a point on screen lies in the world. */
export function toWorld(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}

/**
 * Fits the planets' orbits and the workflows on them inside the frame. Labels that reach further
 * may run under the frame, which keeps the planets large enough to read.
 */
export function fitCamera(positions: readonly Point[], size: Size): Camera {
  const halfWidth = PLANET_ORBIT_RADIUS + 50;
  const halfHeight = PLANET_ORBIT_RADIUS + 60;
  const left = Math.min(...positions.map((position) => position.x - halfWidth));
  const right = Math.max(...positions.map((position) => position.x + halfWidth));
  const top = Math.min(...positions.map((position) => position.y - halfHeight));
  const bottom = Math.max(...positions.map((position) => position.y + halfHeight));
  const scale = clampScale(
    Math.min(
      (size.width - FRAME_PADDING * 2) / (right - left),
      (size.height - FRAME_PADDING * 2) / (bottom - top),
    ),
  );
  return {
    x: size.width / 2 - ((left + right) / 2) * scale,
    y: size.height / 2 - ((top + bottom) / 2) * scale,
    scale,
  };
}
