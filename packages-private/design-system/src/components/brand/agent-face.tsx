import { type CSSProperties, useEffect, useRef } from "react";

// How near the pointer must come before the eyes follow it, in pixels, and how far they move, as a
// share of the face's width.
const LOOK_RADIUS = 200;
const LOOK_REACH = 0.09;

// The top bar's face matches the workspace tile; a message's sits beside its author's name.
const SIZES = { bar: "28px", message: "20px" } as const;

/**
 * How the face moves (components.css). A lively face swirls, blinks, smiles in a hovered control
 * and follows the pointer; a thinking one swirls fast and glances from side to side instead, as a
 * message's face does while its turn loads.
 */
type AgentFaceMotion = "lively" | "thinking";

// Every mounted face shares one pointer listener and one frame, so a long chat of faces measures
// them all before moving any eyes, instead of forcing a layout per face.
const faces = new Set<HTMLElement>();
let pointer = { x: 0, y: 0 };
let frame = 0;

/**
 * The agent's face: a rounded square of the Leyway mark's pink, yellow and violet, with two white
 * eyes, moving as `motion` says. Decorative: the control or name beside it says who it is.
 */
export function AgentFace({ size, motion }: { size: keyof typeof SIZES; motion: AgentFaceMotion }) {
  const faceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const face = faceRef.current;
    if (
      face === null ||
      motion !== "lively" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return undefined;
    }
    if (faces.size === 0) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }
    faces.add(face);
    return () => {
      faces.delete(face);
      // A face that stops following the pointer looks ahead again.
      face.style.removeProperty("--bo-agent-face-look-x");
      face.style.removeProperty("--bo-agent-face-look-y");
      if (faces.size === 0) {
        window.removeEventListener("pointermove", onPointerMove);
        cancelAnimationFrame(frame);
      }
    };
  }, [motion]);

  return (
    <span
      ref={faceRef}
      aria-hidden="true"
      className="bo-agent-face"
      data-motion={motion}
      style={{ "--bo-agent-face-size": SIZES[size] } as CSSProperties}
    >
      <span className="bo-agent-face-eye" />
      <span className="bo-agent-face-eye" />
    </span>
  );
}

function onPointerMove(event: PointerEvent) {
  // Touch has no pointer hovering near a face to look at.
  if (event.pointerType !== "mouse") {
    return;
  }
  pointer = { x: event.clientX, y: event.clientY };
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(lookAtPointer);
}

/** Turns each face's eyes toward the pointer while it is within LOOK_RADIUS; beyond, they look ahead. */
function lookAtPointer() {
  const looks = [...faces].map((face) => {
    const rect = face.getBoundingClientRect();
    const dx = pointer.x - (rect.left + rect.width / 2);
    const dy = pointer.y - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    // A face that isn't laid out, such as the phone tab bar's on desktop, has nothing to look from.
    // Over the face itself the eyes move less than their reach, so they don't snap across it.
    const scale =
      rect.width === 0 || distance > LOOK_RADIUS || distance === 0
        ? 0
        : Math.min(distance, LOOK_REACH * rect.width) / distance;
    return { face, x: dx * scale, y: dy * scale };
  });
  for (const { face, x, y } of looks) {
    face.style.setProperty("--bo-agent-face-look-x", `${x}px`);
    face.style.setProperty("--bo-agent-face-look-y", `${y}px`);
  }
}
