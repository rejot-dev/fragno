import { assert, expect, test, vi } from "vitest";

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
import { automationEventListResultSchema } from "@/fragno/automation/events";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
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
            const scope = { kind: "user", userId: "user-1" } as const;
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
              .forUser({ userId: "user-2" })
              .commands.ingestEvent({
                ...older,
                id: "private-event",
                scope: { kind: "user", userId: "user-2" },
              });

            const context = createRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeSystemExecution(scope),
              billingOrganizationId: null,
            });
            assert(context.stateBackend);
            const { bash } = createInteractiveBashHost({
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
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeSystemExecution({ kind: "user", userId: "empty-user" }),
              billingOrganizationId: null,
            });
            assert(emptyContext.stateBackend);
            const emptyBash = createInteractiveBashHost({
              context: { ...emptyContext, stateBackend: emptyContext.stateBackend },
            }).bash;
            expect(await emptyBash.exec("events.list")).toMatchObject({
              exitCode: 0,
              stdout: "No automation events found.\n",
            });
            const emptyJson = await emptyBash.exec("events.list --format json");
            expect(emptyJson.exitCode, emptyJson.stderr).toBe(0);
            expect(JSON.parse(emptyJson.stdout)).toEqual({ events: [], hasNextPage: false });

            const codemode = await ctx.runCodemode({
              scope: { kind: "org", orgId: "org-1" },
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
