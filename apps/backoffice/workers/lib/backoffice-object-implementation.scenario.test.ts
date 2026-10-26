import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { AutomationsObject } from "../automations-object";

const scenarioObjects = {
  AUTOMATIONS: (input) => new AutomationsObject(input),
} satisfies LocalBackofficeObjects;

test("a hook that fails for good reports one failed attempt for its object's scope", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Durable hook failure telemetry",
      // The route forwards outside its organization, which no retry can fix.
      options: { allowFailedDurableHooks: true },
      steps: ({ given, when, then }) => [
        given.router.route({
          orgId: "org-1",
          id: "forward",
          name: "Forward to another organization",
          enabled: true,
          priority: 0,
          trigger: {
            kind: "event",
            source: "custom",
            eventType: "check.requested",
            matcher: null,
          },
          action: { kind: "forward_event", targetScope: { kind: "org", orgIdTemplate: "org-2" } },
        }),
        when.automation.ingestEvent({
          id: "check-1",
          scopeRestriction: null,
          scope: { kind: "org", orgId: "org-1" },
          source: "custom",
          eventType: "check.requested",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
          actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
          subject: { orgId: "org-1" },
          causation: { kind: "origin" },
        }),
        then.assert("the route's dispatch hook reports its failure once", (ctx) => {
          const dispatches = ctx.telemetry.flatMap((signal) =>
            signal.kind === "durable-hook-attempt" &&
            signal.attempt.hookName === "internalDispatchRoute"
              ? [signal]
              : [],
          );
          expect(dispatches).toHaveLength(1);
          const [dispatch] = dispatches;
          assert(dispatch.outcome.status === "failed");
          expect(dispatch.object).toEqual({
            host: "Automations",
            scope: { kind: "org", orgId: "org-1" },
          });
          expect(dispatch.attempt).toMatchObject({ attempt: 1 });
          expect(dispatch.outcome.error).toBeInstanceOf(Error);
        }),
      ],
    }),
  );
});
