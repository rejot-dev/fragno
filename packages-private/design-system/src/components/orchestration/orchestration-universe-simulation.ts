import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { prefersReducedMotion } from "../controls/appearance-preferences";
import type { OrchestrationUniverseScope, UniverseForward } from "./orchestration-universe-model";
import {
  ALPHA_MIN,
  coolUniverse,
  seedUniverse,
  settleUniverse,
  stepUniverse,
  universeLinks,
  universeRoom,
  type Body,
  type HeldBody,
} from "./orchestration-universe-physics";

// How warm a held planet keeps the simulation, how warm a fresh layout starts, and how warm a reset
// or new scopes make it.
const HELD_ALPHA = 0.3;
const SEED_ALPHA = 1;
const JOIN_ALPHA = 0.5;
const RESHAPE_ALPHA = 0.3;
// How long planets no one has moved take to glide to where scopes joining or leaving, or links
// appearing, put them; what is laid out around them turns as long.
export const GLIDE_MS = 500;

/** Scope ids and links, which is all that decides whether the arrangement has to change. */
function arrangementKey(
  scopes: readonly OrchestrationUniverseScope[],
  forwards: readonly UniverseForward[],
): string {
  return JSON.stringify([
    scopes.map((scope) => scope.id),
    universeLinks(forwards).map(({ a, b }) => `${a}|${b}`),
  ]);
}

/**
 * The planets' positions, moved by the forces between them while someone holds a planet and for a
 * few seconds after. It ignores the reduced-motion preference on purpose: the motion is how the
 * graph shows which planets are linked. Planets no one has moved glide to their settled layout
 * instead, which reduced motion skips.
 */
export function useUniverseSimulation(
  scopes: readonly OrchestrationUniverseScope[],
  forwards: readonly UniverseForward[],
  aspect: number,
) {
  const links = useMemo(() => universeLinks(forwards), [forwards]);
  const room = useMemo(() => universeRoom(scopes.length, aspect), [scopes.length, aspect]);
  const [bodies, setBodies] = useState<ReadonlyMap<string, Body>>(() =>
    settleUniverse(
      seedUniverse(scopes, forwards, new Map()),
      universeLinks(forwards),
      room,
      SEED_ALPHA,
    ),
  );
  // Where the planets last came to rest, which what is laid out around them follows, so it holds
  // still while planets move and catches up once they settle.
  const [resting, setResting] = useState(bodies);
  const bodiesRef = useRef(bodies);
  // The animation loop reads the latest links and room, once the render that has them commits.
  const linksRef = useRef(links);
  const roomRef = useRef(room);
  useLayoutEffect(() => {
    linksRef.current = links;
    roomRef.current = room;
  }, [links, room]);
  // Until someone moves a planet, the planets simply are the settled layout for the room.
  const untouchedRef = useRef(true);
  const heldRef = useRef<HeldBody | null>(null);
  const alphaRef = useRef(0);
  const frameRef = useRef(0);
  const glideRef = useRef(0);

  const commit = useCallback((next: ReadonlyMap<string, Body>) => {
    bodiesRef.current = next;
    setBodies(next);
  }, []);

  const heat = useCallback(
    (alpha: number) => {
      alphaRef.current = Math.max(alphaRef.current, alpha);
      cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
      if (frameRef.current !== 0) {
        return;
      }
      const tick = () => {
        const held = heldRef.current;
        alphaRef.current = coolUniverse(alphaRef.current, held ? HELD_ALPHA : 0);
        commit(
          stepUniverse(
            bodiesRef.current,
            linksRef.current,
            roomRef.current,
            alphaRef.current,
            held,
          ),
        );
        if (held || alphaRef.current > ALPHA_MIN) {
          frameRef.current = requestAnimationFrame(tick);
        } else {
          frameRef.current = 0;
          setResting(bodiesRef.current);
        }
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [commit],
  );

  const glide = useCallback(
    (to: ReadonlyMap<string, Body>) => {
      cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
      if (prefersReducedMotion()) {
        commit(to);
        return;
      }
      const from = bodiesRef.current;
      const start = performance.now();
      const tick = () => {
        const progress = Math.min(1, (performance.now() - start) / GLIDE_MS);
        const eased = 1 - (1 - progress) ** 3;
        commit(
          new Map(
            [...to].map(([id, body]) => {
              const was = from.get(id);
              return [
                id,
                was
                  ? {
                      ...body,
                      x: was.x + (body.x - was.x) * eased,
                      y: was.y + (body.y - was.y) * eased,
                    }
                  : body,
              ];
            }),
          ),
        );
        glideRef.current = progress < 1 ? requestAnimationFrame(tick) : 0;
      };
      glideRef.current = requestAnimationFrame(tick);
    },
    [commit],
  );

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      cancelAnimationFrame(glideRef.current);
    },
    [],
  );

  // Until someone moves a planet, the planets are a settled layout. They take one at once when the
  // view's shape is measured, before the first paint. As scopes and links arrive while loading,
  // they glide to where drifting would bring them, so everything around them moves once instead
  // of after a drift. Once someone has arranged them, they drift: new scopes start at their seeds
  // and float into the arrangement, and the rest into a new shape.
  const key = arrangementKey(scopes, forwards);
  const keyRef = useRef(key);
  const roomKey = `${room.halfWidth}|${room.halfHeight}`;
  const roomKeyRef = useRef(roomKey);
  useLayoutEffect(() => {
    const joined = keyRef.current !== key;
    if (!joined && roomKeyRef.current === roomKey) {
      return;
    }
    keyRef.current = key;
    roomKeyRef.current = roomKey;
    if (untouchedRef.current && joined) {
      const settled = settleUniverse(
        seedUniverse(scopes, forwards, bodiesRef.current),
        links,
        room,
        JOIN_ALPHA,
      );
      setResting(settled);
      glide(settled);
    } else if (untouchedRef.current) {
      const settled = settleUniverse(
        seedUniverse(scopes, forwards, new Map()),
        links,
        room,
        SEED_ALPHA,
      );
      // A glide still under way heads for the old room, and would carry the planets back there.
      cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
      setResting(settled);
      commit(settled);
    } else if (joined) {
      commit(seedUniverse(scopes, forwards, bodiesRef.current));
      heat(JOIN_ALPHA);
    } else {
      heat(RESHAPE_ALPHA);
    }
  }, [key, roomKey, links, room, scopes, forwards, commit, glide, heat]);

  return {
    bodies,
    resting,
    hold(held: HeldBody) {
      untouchedRef.current = false;
      heldRef.current = held;
      heat(HELD_ALPHA);
    },
    release() {
      heldRef.current = null;
    },
    rearrange() {
      untouchedRef.current = false;
      commit(seedUniverse(scopes, forwards, new Map()));
      heat(SEED_ALPHA);
    },
  };
}
