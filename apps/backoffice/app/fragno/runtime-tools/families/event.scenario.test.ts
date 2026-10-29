import { assert, expect, test, vi } from "vitest";

import {
  automationEventListResultSchema,
  type AutomationEventRouting,
  automationEventRoutesListResultSchema,
} from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  type BackofficeScenarioContext,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { FormsObject } from "../../../../workers/forms-object";
import { McpObject } from "../../../../workers/mcp-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  BILLING: (input) => new BillingObject(input),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

test("stored event commands read scoped SQLite records with text, JSON, and cursor pagination", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Stored automation event commands",
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", slug: "event-tools", name: "Event tools" }),
      ],
      steps: ({ then }) => [
        then.assert(
          "events list and get preserve event details without exposing another scope",
          async (ctx) => {
            const scope = { kind: "user", userId: "user-1", jurisdiction: null } as const;
            const actors = {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            };
            const older = {
              id: "older-event",
              scopeRestriction: null,
              scope,
              source: "custom",
              eventType: "thing.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: { thingId: "thing-1" },
              actors,
              subject: { userId: "user-1" },
              causation: { kind: "origin" as const },
            };
            const newer = {
              ...older,
              id: "newer-event",
              occurredAt: "2026-01-02T00:00:00.000Z",
              payload: { thingId: "thing-2" },
            };
            const object = ctx.runtime.objects.automations.for(scope);
            await object.commands.ingestEvent(older);
            await object.commands.ingestEvent(newer);
            await ctx.runtime.objects.automations
              .for({ kind: "user", userId: "user-2", jurisdiction: null })
              .commands.ingestEvent({
                ...older,
                id: "private-event",
                scope: { kind: "user", userId: "user-2", jurisdiction: null },
              });

            const context = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeSystemExecution(scope),
            });
            assert(context.stateBackend);
            const { bash } = await createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const first = await bash.exec("events.list --limit 1 --format json");
            expect(first.exitCode, first.stderr).toBe(0);
            const page = automationEventListResultSchema.parse(JSON.parse(first.stdout));
            expect(page.events).toMatchObject([newer]);
            assert(page.hasNextPage);
            assert(page.nextCursor);
            const next = await bash.exec(`events.list --cursor '${page.nextCursor}' --format json`);
            expect(next.exitCode, next.stderr).toBe(0);
            expect(automationEventListResultSchema.parse(JSON.parse(next.stdout))).toMatchObject({
              events: [older],
              hasNextPage: false,
            });

            const text = await bash.exec("events.list --limit 1");
            expect(text.exitCode, text.stderr).toBe(0);
            expect(text.stdout).toContain("id\toccurred at\tsource\tevent type");
            expect(text.stdout).toContain(
              "newer-event\t2026-01-02T00:00:00.000Z\tcustom\tthing.created",
            );
            expect(text.stdout).toContain("next cursor:");
            const explicitText = await bash.exec("events.list --limit 1 --format text");
            expect(explicitText.stdout).toBe(text.stdout);
            const printed = await bash.exec("events.list --print has-next-page");
            expect(printed).toMatchObject({ exitCode: 0, stdout: "false\n" });

            const detail = await bash.exec("events.get --id newer-event --format json");
            expect(detail.exitCode, detail.stderr).toBe(0);
            expect(JSON.parse(detail.stdout)).toMatchObject(newer);
            const detailText = await bash.exec("events.get --id newer-event");
            expect(detailText.exitCode, detailText.stderr).toBe(0);
            expect(detailText.stdout).toContain("id: newer-event");
            expect(detailText.stdout).toContain('"thingId": "thing-2"');
            expect(detailText.stdout).toContain("actors\n");
            expect(detailText.stdout).toContain('"userId": "user-1"');
            expect(
              await bash.exec("events.get --id newer-event --print payload.thing-id"),
            ).toMatchObject({ exitCode: 0, stdout: "thing-2\n" });
            for (const format of ["text", "json"]) {
              for (const id of ["missing", "private-event"]) {
                expect(await bash.exec(`events.get --id ${id} --format ${format}`)).toMatchObject({
                  exitCode: 1,
                  stdout: "",
                  stderr: expect.stringContaining("Automation event not found"),
                });
              }
            }
            for (const args of ["--limit 0", "--limit 501", "--limit nope", "--cursor invalid"]) {
              expect(await bash.exec(`events.list ${args}`)).toMatchObject({
                exitCode: 1,
                stdout: "",
              });
            }
            expect(await bash.exec("events.get")).toMatchObject({
              exitCode: 1,
              stderr: expect.stringContaining("--id"),
            });

            const emptyContext = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeSystemExecution({
                kind: "user",
                userId: "empty-user",
                jurisdiction: null,
              }),
            });
            assert(emptyContext.stateBackend);
            const emptyBash = (
              await createInteractiveBashHost({
                context: { ...emptyContext, stateBackend: emptyContext.stateBackend },
              })
            ).bash;
            expect(await emptyBash.exec("events.list")).toMatchObject({
              exitCode: 0,
              stdout: "No automation events found.\n",
            });
            const emptyJson = await emptyBash.exec("events.list --format json");
            expect(emptyJson.exitCode, emptyJson.stderr).toBe(0);
            expect(JSON.parse(emptyJson.stdout)).toEqual({ events: [], hasNextPage: false });

            const codemode = await ctx.runCodemode({
              scope: { kind: "org", orgId: "org-1", jurisdiction: null },
              code: 'async () => ({ page: await context.user("user-1").events.list({ limit: 1 }), event: await context.user("user-1").events.get({ id: "newer-event" }) })',
            });
            expect(codemode.result).toMatchObject({
              page: { events: [newer], hasNextPage: true },
              event: newer,
            });
          },
        ),
      ],
    }),
  );
});

test("an agent reads where each route its event matched stands", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Route states on a stored event",
      // The route forwarding outside the agent's scope fails for good.
      options: { allowFailedDurableHooks: true },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", slug: "event-tools", name: "Event tools" }),
        // Someone else's organization, which user-1's routes cannot reach.
        given.organization.exists({
          id: "org-2",
          slug: "elsewhere",
          name: "Elsewhere",
          ownerUserId: "user-2",
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "the event is matching until its routes are recorded, then shows each route",
          async (ctx) => {
            const scope = { kind: "user", userId: "user-1", jurisdiction: null } as const;
            const context = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeSystemExecution(scope),
            });
            assert(context.stateBackend);
            const { bash } = await createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const trigger = { kind: "event", source: "custom", eventType: "check.requested" };
            for (const route of [
              {
                id: "deliver",
                name: "Deliver to a run that does not exist",
                trigger,
                action: {
                  kind: "send_workflow_event",
                  target: { kind: "instance_id", template: "missing-run" },
                  eventType: "check",
                },
              },
              {
                id: "forward",
                name: "Forward to another organization",
                trigger,
                action: {
                  kind: "forward_event",
                  targetScope: { kind: "org", orgIdTemplate: "org-2" },
                },
              },
              {
                id: "reclassify",
                name: "Reclassify the check",
                trigger,
                action: {
                  kind: "reclassify_event",
                  source: "custom",
                  eventType: "check.reclassified",
                  payload: { kind: "projection", fields: { value: "$.payload.value" } },
                },
              },
            ]) {
              const created = await bash.exec(`router.create --json '${JSON.stringify(route)}'`);
              expect(created.exitCode, created.stderr).toBe(0);
            }

            const fired = await bash.exec(
              `events.fire --source custom --event-type check.requested --payload-json '{"value":"ready"}' --format json`,
            );
            expect(fired.exitCode, fired.stderr).toBe(0);
            const { eventId } = JSON.parse(fired.stdout) as { eventId: string };

            const matching = await bash.exec(`events.get --id ${eventId} --format json`);
            expect(matching.exitCode, matching.stderr).toBe(0);
            expect(JSON.parse(matching.stdout)).toMatchObject({ routing: { status: "matching" } });
            expect((await bash.exec(`events.get --id ${eventId}`)).stdout).toContain(
              "routes\nnot matched yet; run events.get again shortly\n",
            );

            await ctx.drain();

            const matched = await bash.exec(`events.get --id ${eventId} --format json`);
            expect(matched.exitCode, matched.stderr).toBe(0);
            const matchedAt = expect.any(String);
            expect(JSON.parse(matched.stdout).routing).toEqual({
              status: "matched",
              routes: [
                {
                  routeId: "deliver",
                  routeName: "Deliver to a run that does not exist",
                  matchedAt,
                  status: "retrying",
                  failedAttempts: 1,
                  error: "INSTANCE_NOT_FOUND",
                },
                {
                  routeId: "forward",
                  routeName: "Forward to another organization",
                  matchedAt,
                  status: "failed",
                  failedAttempts: 1,
                  error:
                    "automation.forward-event cannot use org:org-2 within user:user-1, whose owner may not emit events there.",
                },
                {
                  routeId: "reclassify",
                  routeName: "Reclassify the check",
                  matchedAt,
                  status: "completed",
                  outcome: {
                    kind: "event_reclassified",
                    eventId: `reclassified:reclassify:${eventId}`,
                  },
                  failedAttempts: 0,
                },
              ],
            });
            expect((await bash.exec(`events.get --id ${eventId}`)).stdout).toContain(
              [
                "routes",
                "deliver (Deliver to a run that does not exist): retrying after 1 failed attempt, last error: INSTANCE_NOT_FOUND",
                "forward (Forward to another organization): failed for good after 1 failed attempt: automation.forward-event cannot use org:org-2 within user:user-1, whose owner may not emit events there.",
                "reclassify (Reclassify the check): completed, event_reclassified",
              ].join("\n"),
            );

            // The list carries the same routing, newest first: the forward route's failure was
            // recorded as an event of its own.
            const listed = automationEventListResultSchema.parse(
              JSON.parse((await bash.exec("events.list --format json")).stdout),
            );
            expect(listed.events.map((event) => [event.id, event.routing.status])).toEqual([
              [expect.stringMatching(/^route-failed:forward:/), "matched"],
              [`reclassified:reclassify:${eventId}`, "matched"],
              [eventId, "matched"],
            ]);
            const reclassified = listed.events.find(
              (event) => event.id === `reclassified:reclassify:${eventId}`,
            );
            // Routes in one state list on their own, each with the event it matched.
            const failing = automationEventRoutesListResultSchema.parse(
              JSON.parse(
                (await bash.exec("events.routes.list --status failed --format json")).stdout,
              ),
            );
            const routing = JSON.parse(matched.stdout).routing as AutomationEventRouting;
            assert(routing.status === "matched");
            expect(failing).toEqual({
              routes: [
                { eventId, route: routing.routes.find((route) => route.routeId === "forward") },
              ],
              hasNextPage: false,
            });
            expect((await bash.exec("events.routes.list --status retrying")).stdout).toBe(
              [
                "event id\tmatched at\troute",
                `${eventId}\t${failing.routes[0]?.route.matchedAt}\tdeliver (Deliver to a run that does not exist): retrying after 1 failed attempt, last error: INSTANCE_NOT_FOUND`,
                "",
              ].join("\n"),
            );
            expect(await bash.exec("events.routes.list --status pending")).toMatchObject({
              exitCode: 0,
              stdout: "No routes found.\n",
            });
            for (const args of ["", "--status broken"]) {
              expect(await bash.exec(`events.routes.list ${args}`)).toMatchObject({
                exitCode: 1,
                stdout: "",
              });
            }
            expect((await bash.exec("events.list")).stdout).toContain(
              `reclassified:reclassify:${eventId}\t${reclassified?.occurredAt}\tcustom\tcheck.reclassified\tno route`,
            );

            // Only a route that failed for good can run again, and only one the event matched.
            expect(
              await bash.exec(`events.routes.retry --event ${eventId} --route deliver`),
            ).toMatchObject({
              exitCode: 1,
              stderr: expect.stringContaining("Only a route that failed for good can be retried"),
            });
            expect(
              await bash.exec(`events.routes.retry --event ${eventId} --route unknown`),
            ).toMatchObject({ exitCode: 1, stderr: "The event did not match this route.\n" });
            expect(
              await bash.exec(`events.routes.retry --event ${eventId} --route forward`),
            ).toMatchObject({
              exitCode: 0,
              stdout: "forward (Forward to another organization): pending, not attempted yet\n",
            });
            await ctx.drain();
            // The retried route ran again from a fresh count, as it was when the event matched.
            const retried = await bash.exec(`events.get --id ${eventId} --format json`);
            expect(
              (
                JSON.parse(retried.stdout) as {
                  routing: { routes: Array<{ routeId: string }> };
                }
              ).routing.routes.find((route) => route.routeId === "forward"),
            ).toMatchObject({ status: "failed", failedAttempts: 1 });
          },
        ),
      ],
    }),
  );
});

test("a personal route forwards to its owner's organization until they leave it", async () => {
  const personal = { kind: "user", userId: "user-1", jurisdiction: null } as const;
  const organization = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
  const fireBalance = async (ctx: BackofficeScenarioContext, balanceCents: number) => {
    const fired = await ctx.runCodemode({
      scope: personal,
      code: `async () => await events.fire({ source: "bank", eventType: "balance.updated", payload: { balanceCents: ${balanceCents} } })`,
    });
    const { eventId } = fired.result as { eventId: string };
    await ctx.drain();
    return eventId;
  };
  const readEvent = async (
    ctx: BackofficeScenarioContext,
    scope: BackofficeContextScope,
    id: string,
  ) =>
    (await ctx.runCodemode({ scope, code: `async () => await events.get({ id: "${id}" })` }))
      .result as { payload: unknown; routing: AutomationEventRouting } | null;

  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Forwarding from a personal scope to an organization",
      // The forward after user-1 leaves the organization fails for good.
      options: { allowFailedDurableHooks: true },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", name: "ReJot", ownerUserId: "owner-1" }),
        given.auth.user({ id: "user-1" }),
        given.auth.member({ orgId: "org-1", userId: "user-1" }),
        given.codemode.run({
          scope: personal,
          code: `async () => await router.create({
            id: "balances-to-org",
            name: "Balances to ReJot",
            trigger: { kind: "event", source: "bank", eventType: "balance.updated" },
            action: { kind: "forward_event", targetScope: { kind: "org", orgIdTemplate: "org-1" } },
          })`,
        }),
      ],
      steps: ({ when, then }) => [
        then.assert("a member's balance arrives in the organization", async (ctx) => {
          const eventId = await fireBalance(ctx, 8709);
          expect((await readEvent(ctx, personal, eventId))?.routing).toMatchObject({
            status: "matched",
            routes: [
              {
                routeId: "balances-to-org",
                status: "completed",
                outcome: { kind: "event_forwarded", eventId, scope: organization },
              },
            ],
          });
          expect((await readEvent(ctx, organization, eventId))?.payload).toEqual({
            balanceCents: 8709,
          });
        }),
        when.auth.removeMember({ orgId: "org-1", userId: "user-1" }),
        then.assert("after leaving, the next balance stays home", async (ctx) => {
          const eventId = await fireBalance(ctx, 1200);
          expect((await readEvent(ctx, personal, eventId))?.routing).toMatchObject({
            status: "matched",
            routes: [
              {
                routeId: "balances-to-org",
                status: "failed",
                error:
                  "automation.forward-event cannot use org:org-1 within user:user-1, whose owner may not emit events there.",
              },
            ],
          });
          expect(await readEvent(ctx, organization, eventId)).toBeNull();
        }),
      ],
    }),
  );
});
