import type { ReactNode } from "react";

// One stroke weight everywhere. Units: x-height 230, baseline 315, descender 397.
const W = 66;
// Bowls are stroked along this centerline, so their weight matches the stems all the way round.
const RX = 92;
const RY = 85;
const CY = 200;
// The second "o" is the first one pulled this far apart; the keyframes in components.css move by the same length.
const STRETCH = 200;
const LOOP_LEFT = 503;
const LOOP_RIGHT = LOOP_LEFT + STRETCH;

/**
 * The Loopp wordmark, whose stretched second "o" is the loop. It takes the surrounding text color;
 * `className` sets its height. Animated, the loop opens from a round "o" when it mounts, and
 * whatever carries `loopp-wordmark-after` fades in after it.
 * Decorative: the links around it carry the name.
 */
export function LooppWordmark({ className, animated }: { className: string; animated: boolean }) {
  return (
    <svg
      viewBox="0 0 1396 397"
      aria-hidden="true"
      className={`block shrink-0 ${animated ? "loopp-wordmark-animated" : ""} ${className}`}
    >
      <g fill="currentColor">
        <rect x={0} y={0} width={W} height={315} />
        {/* The loop's straight sides, overlapping its halves by a unit so no seam shows. */}
        <g className="loopp-wordmark-sides">
          <rect x={LOOP_LEFT - 1} y={CY - RY - W / 2} width={STRETCH + 2} height={W} />
          <rect x={LOOP_LEFT - 1} y={CY + RY - W / 2} width={STRETCH + 2} height={W} />
        </g>
      </g>
      <g fill="none" stroke="currentColor" strokeWidth={W}>
        <ellipse cx={225} cy={CY} rx={RX} ry={RY} />
        <path d={`M${LOOP_LEFT} ${CY - RY}A${RX} ${RY} 0 0 0 ${LOOP_LEFT} ${CY + RY}`} />
      </g>
      <g className="loopp-wordmark-tail">
        <path
          d={`M${LOOP_RIGHT} ${CY - RY}A${RX} ${RY} 0 0 1 ${LOOP_RIGHT} ${CY + RY}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={W}
        />
        {[862, 1146].map((stemX) => (
          <g key={stemX}>
            <rect x={stemX} y={85} width={W} height={312} fill="currentColor" />
            <ellipse
              cx={stemX + 125}
              cy={CY}
              rx={RX}
              ry={RY}
              fill="none"
              stroke="currentColor"
              strokeWidth={W}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * The inside of the wordmark's stretched "o", behind its parent: a pill as tall as the parent plus
 * some room, so the parent always sits inside it, and at least `holeWidth` wide, so the parent's
 * surroundings stay clear too. The "o" itself reaches out without end, so only the pill shows, never
 * the outer edge. Lanes of light run round the pill. On narrow screens the pill keeps at least the
 * wordmark's proportions, and its ends run past the screen's edges. `behind` is drawn inside the
 * pill but behind the "o", in a screen-wide box as tall as the pill. It takes the surrounding text
 * color; the parent must be positioned and centered on the screen.
 */
export function LooppLoopAround({
  holeWidth,
  behind,
  className,
}: {
  holeWidth: string;
  behind: ReactNode;
  className: string;
}) {
  // Container units, since a width cannot be a share of the box's height.
  const lane = `100cqh * ${LOOP_LANE_SHARE}`;
  return (
    <div
      aria-hidden="true"
      className={`[container-type:size] pointer-events-none absolute left-[calc(50%-50vw)] w-screen ${className}`}
      style={{ top: `-${LOOP_ROOM}`, bottom: `-${LOOP_ROOM}` }}
    >
      {/* What passes behind the "o", as tall as the pill and centered on it. It fades out towards
          the pill's top and bottom edges rather than being cut off by them. */}
      <div className="absolute inset-0 [mask-image:linear-gradient(transparent,#000_5rem,#000_calc(100%-5rem),transparent)]">
        {behind}
      </div>
      <div
        className="absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-full shadow-[0_0_0_200vmax_currentColor]"
        // The "o" reaches out without end.
        style={{
          width: `max(${holeWidth}, 100cqh * ${(STRETCH + 2 * RX - W) / LOOP_HOLE_HEIGHT})`,
        }}
      >
        {LOOP_LANE_DIVIDERS.map((divider) => (
          <span
            key={divider}
            className="absolute rounded-full border border-(--loopp-loop-lane,rgb(255_255_255/0.35))"
            style={{ inset: `calc(-1 * ${lane} * ${divider})` }}
          />
        ))}
        {LOOP_PARTICLES.map((particle, index) => {
          // A streak is a run of short segments, each a little further behind on the path, so it
          // bends with the loop's curves instead of sticking out straight.
          const segments = Math.max(1, Math.round(particle.length / LOOP_SEGMENT_SPACING));
          return Array.from({ length: segments }, (_, segment) => (
            <span
              key={`${index}-${segment}`}
              className="loopp-loop-particle"
              style={{
                // Down the middle of the particle's lane, counted out from the pill's edge.
                offsetPath: `inset(calc(-1 * ${lane} * ${particle.lane + 0.5}) round 9999px)`,
                ["--loopp-loop-lag" as string]: `${segment * LOOP_SEGMENT_SPACING}px`,
                // Overlapping the next segment, so no gaps show between them.
                width: LOOP_SEGMENT_SPACING + 2,
                height: particle.thickness,
                // Bright at the head, fading towards the tail.
                opacity: particle.opacity * (1 - segment / segments),
                animationDuration: `${particle.seconds}s`,
                // Negative, so every particle is already on its way round when the page loads.
                animationDelay: `${-particle.start * particle.seconds}s`,
              }}
            />
          ));
        })}
      </div>
    </div>
  );
}

// How far the pill reaches past its parent's top and bottom.
const LOOP_ROOM = "4rem";
const LOOP_HOLE_HEIGHT = 2 * RY - W;
const LOOP_LANES = 6;
const LOOP_SEGMENT_SPACING = 6;
// Each lane's width, as a share of the pill's height: the lanes split what would be the wordmark's
// band at this size.
const LOOP_LANE_SHARE = W / LOOP_HOLE_HEIGHT / LOOP_LANES;
// Every lane is bounded by a line, the outermost one too, since the "o" has no outer edge.
const LOOP_LANE_DIVIDERS = Array.from({ length: LOOP_LANES }, (_, index) => index + 1);

/**
 * The middle of a lane below a LooppLoopAround, counted out from the pill's bottom edge (lane 0
 * hugs it), as a `top` for an element positioned in the same parent as the loop.
 */
export function loopLaneBelowTop(lane: number) {
  return `calc(100% + ${LOOP_ROOM} + (100% + 2 * ${LOOP_ROOM}) * ${LOOP_LANE_SHARE * (lane + 0.5)})`;
}

// Light running round the loop, clockwise, a few streaks per lane; lane 0 hugs the hole. Derived
// from the lane and slot rather than random, so the server and the browser render the same.
const LOOP_PARTICLES = Array.from({ length: LOOP_LANES * 3 }, (_, index) => {
  const lane = index % LOOP_LANES;
  const slot = Math.floor(index / LOOP_LANES);
  return {
    lane,
    length: [64, 24, 40][slot] + lane * 4,
    thickness: [3, 2, 2][slot],
    opacity: [0.3, 0.18, 0.24][slot],
    seconds: 22 + ((lane * 5 + slot * 7) % 16),
    start: (slot / 3 + lane * 0.11) % 1,
  };
});
