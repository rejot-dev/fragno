import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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

// How warm a held planet keeps the simulation, and how warm a reset or new scopes make it.
const HELD_ALPHA = 0.3;
const REARRANGE_ALPHA = 1;
const JOIN_ALPHA = 0.5;
const RESHAPE_ALPHA = 0.3;

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
 * graph shows which planets are linked.
 */
export function useUniverseSimulation(
  scopes: readonly OrchestrationUniverseScope[],
  forwards: readonly UniverseForward[],
  aspect: number,
) {
  const links = useMemo(() => universeLinks(forwards), [forwards]);
  const room = useMemo(() => universeRoom(scopes.length, aspect), [scopes.length, aspect]);
  const [bodies, setBodies] = useState<ReadonlyMap<string, Body>>(() =>
    settleUniverse(seedUniverse(scopes, forwards, new Map()), universeLinks(forwards), room),
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

  const commit = useCallback((next: ReadonlyMap<string, Body>) => {
    bodiesRef.current = next;
    setBodies(next);
  }, []);

  const heat = useCallback(
    (alpha: number) => {
      alphaRef.current = Math.max(alphaRef.current, alpha);
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

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // New scopes start at their seeds and float into the arrangement; the rest stay where they are.
  const key = arrangementKey(scopes, forwards);
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) {
      return;
    }
    keyRef.current = key;
    untouchedRef.current = false;
    commit(seedUniverse(scopes, forwards, bodiesRef.current));
    heat(JOIN_ALPHA);
  }, [key, scopes, forwards, commit, heat]);

  // The view's shape is measured before the first paint, so an untouched layout settles into it
  // straight away; a layout someone arranged drifts into the new shape instead.
  const roomKey = `${room.halfWidth}|${room.halfHeight}`;
  const roomKeyRef = useRef(roomKey);
  useLayoutEffect(() => {
    if (roomKeyRef.current === roomKey) {
      return;
    }
    roomKeyRef.current = roomKey;
    if (untouchedRef.current) {
      const settled = settleUniverse(
        seedUniverse(scopes, forwards, new Map()),
        linksRef.current,
        room,
      );
      commit(settled);
      setResting(settled);
    } else {
      heat(RESHAPE_ALPHA);
    }
  }, [roomKey, room, scopes, forwards, commit, heat]);

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
      heat(REARRANGE_ALPHA);
    },
  };
}
