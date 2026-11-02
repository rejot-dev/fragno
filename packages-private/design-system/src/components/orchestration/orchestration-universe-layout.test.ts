import { assert, describe, test } from "vitest";

import { UNIVERSE } from "./orchestration-graph-story-support";
import { toWorld, type Size } from "./orchestration-universe-camera";
import { FRAME_PADDING, TILE_THICKNESS } from "./orchestration-universe-frame";
import { arrangeAtRest } from "./orchestration-universe-layout";
import { layoutUniverse, type UniversePlanet } from "./orchestration-universe-model";
import {
  seedUniverse,
  settleUniverse,
  universeLinks,
  universeRoom,
} from "./orchestration-universe-physics";
import { bearing, normalizeAngle, shortestDelta } from "./radial-geometry";
import { eventDepartureAngle } from "./workflow-trigger-graph-model";

const VIEWS: Size[] = [
  { width: 1900, height: 1250 },
  { width: 1200, height: 900 },
  { width: 900, height: 1300 },
];
// How far, in degrees, a forward may leave or arrive from the way to the other planet.
const FORWARD_SLACK = 40;

function degrees(angle: number): number {
  return (Math.abs(angle) * 180) / Math.PI;
}

/** The story's universe, left to settle in a view of `size` and laid out around where it rests. */
function atRest(size: Size) {
  const layout = layoutUniverse(UNIVERSE);
  const aspect = (size.width - FRAME_PADDING * 2) / (size.height - FRAME_PADDING * 2);
  const resting = settleUniverse(
    seedUniverse(UNIVERSE.scopes, layout.forwards, new Map()),
    universeLinks(layout.forwards),
    universeRoom(UNIVERSE.scopes.length, aspect),
  );
  const arranged = arrangeAtRest(layout, resting, size);
  const planet = (scopeId: string) => arranged.planets.find(({ scope }) => scope.id === scopeId)!;
  const position = (scopeId: string) => resting.get(scopeId) ?? { x: 0, y: 0 };
  return { layout, ...arranged, planet, position };
}

/** How far each calling workflow sits, in total, from the outside systems it calls. */
function callDeviation(rest: ReturnType<typeof atRest>, planets: readonly UniversePlanet[]) {
  return rest.layout.calls.reduce((total, call) => {
    const tile = rest.tiles.find(({ external }) => external.id === call.externalId);
    const workflow = planets
      .find(({ scope }) => scope.id === call.scopeId)
      ?.layout.workflows.find(({ workflow: { id } }) => id === call.workflowId);
    assert.exists(tile);
    assert.exists(workflow);
    const toward = bearing(rest.position(call.scopeId), toWorld(rest.fit, tile.center));
    return total + Math.abs(shortestDelta(workflow.angle, toward));
  }, 0);
}

describe("the universe at rest", () => {
  for (const size of VIEWS) {
    describe(`in a ${size.width}×${size.height} view`, () => {
      const rest = atRest(size);

      test("forwarded events face the planets they go to and come from", () => {
        for (const forward of rest.layout.forwards) {
          const toward = bearing(
            rest.position(forward.fromScopeId),
            rest.position(forward.toScopeId),
          );
          const leaving = rest
            .planet(forward.fromScopeId)
            .layout.events.find(({ event }) => event.id === forward.eventId);
          assert.exists(leaving);
          assert.isAtMost(
            degrees(shortestDelta(eventDepartureAngle(leaving, toward), toward)),
            FORWARD_SLACK,
            `${forward.id} leaves`,
          );
          const back = toward + Math.PI;
          const arriving = rest
            .planet(forward.toScopeId)
            .layout.events.find(({ event }) => event.id === forward.eventId);
          if (arriving) {
            assert.isAtMost(
              degrees(shortestDelta(eventDepartureAngle(arriving, back), back)),
              FORWARD_SLACK,
              `${forward.id} arrives`,
            );
          }
        }
      });

      test("workflows turn towards the outside systems they call", () => {
        assert.isBelow(
          callDeviation(rest, rest.planets),
          callDeviation(rest, rest.layout.planets) / 2,
        );
      });

      test("no two workflows on a planet cross their trigger edges", () => {
        for (const { scope, layout } of rest.planets) {
          const workflowAngle = new Map(
            layout.workflows.map(({ workflow, angle }) => [workflow.id, angle]),
          );
          const spans = layout.triggers.map(({ workflowId, angle }) => {
            const sits = workflowAngle.get(workflowId) ?? 0;
            const delta = shortestDelta(angle, sits);
            return { workflowId, from: delta >= 0 ? angle : sits, length: Math.abs(delta) };
          });
          for (const a of spans) {
            for (const b of spans) {
              if (a.workflowId >= b.workflowId) {
                continue;
              }
              const fromInside = normalizeAngle(b.from - a.from) <= a.length;
              const toInside = normalizeAngle(b.from + b.length - a.from) <= a.length;
              assert.equal(fromInside, toInside, `${scope.id}: ${a.workflowId} × ${b.workflowId}`);
            }
          }
        }
      });

      test("every called outside system sits on the frame, clear of the others", () => {
        assert.deepEqual(
          rest.tiles.map(({ external }) => external.id).toSorted(),
          rest.layout.externals.map(({ id }) => id).toSorted(),
        );
        for (const a of rest.tiles) {
          for (const b of rest.tiles) {
            if (a !== b && a.side === b.side) {
              const along =
                a.side === "top" || a.side === "bottom"
                  ? Math.abs(a.center.x - b.center.x)
                  : Math.abs(a.center.y - b.center.y);
              assert.isAtLeast(
                along,
                (a.length + b.length) / 2,
                `${a.external.id} and ${b.external.id}`,
              );
            }
          }
          assert.isTrue(
            a.center.x >= 0 &&
              a.center.y >= 0 &&
              a.center.x <= size.width &&
              a.center.y <= size.height &&
              (a.center.x < TILE_THICKNESS * 2 ||
                a.center.y < TILE_THICKNESS * 2 ||
                a.center.x > size.width - TILE_THICKNESS * 2 ||
                a.center.y > size.height - TILE_THICKNESS * 2),
            `${a.external.id} is on the frame`,
          );
        }
      });
    });
  }
});
