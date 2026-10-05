import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

test("event catalog commands combine built-in descriptors with scoped dynamic definitions", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Event catalog runtime extraction",
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", slug: "event-catalog", name: "Event catalog" }),
      ],
      steps: ({ then }) => [
        then.assert(
          "catalog creation and discovery keep schemas and scope ownership",
          async (ctx) => {
            const definition = {
              source: "custom",
              eventType: "thing.created",
              label: "Thing created",
              description: "A thing was created.",
              payloadSchema: {
                type: "object",
                properties: { thingId: { type: "string" } },
                required: ["thingId"],
              },
              actorSchema: { type: "object", properties: { id: { type: "string" } } },
              subjectSchema: { type: "object", properties: { userId: { type: "string" } } },
            };
            const kernel = new BackofficeKernel(ctx.runtime.services);
            const context = createRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel,
              execution: createBackofficeSystemExecution({ kind: "user", userId: "user-1" }),
              billingOrganizationId: null,
            });
            assert(context.stateBackend);
            const { bash } = createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const created = await bash.exec(
              `events.catalog.create --json '${JSON.stringify(definition)}' --format json`,
            );
            expect(created.exitCode, created.stderr).toBe(0);
            expect(JSON.parse(created.stdout)).toMatchObject(definition);
            expect(
              await ctx.runtime.objects.automations
                .forUser({ userId: "user-1" })
                .commands.getEventDefinition({ source: "custom", eventType: "thing.created" }),
            ).toMatchObject(definition);
            const list = await bash.exec("events.catalog.list --format json");
            expect(list.exitCode, list.stderr).toBe(0);
            const entries = JSON.parse(list.stdout);
            expect(entries).toContainEqual(
              expect.objectContaining({
                source: "custom",
                eventType: "thing.created",
                capabilityId: "dynamic",
              }),
            );
            expect(entries).toContainEqual(
              expect.objectContaining({ source: "telegram", eventType: "message.received" }),
            );
            expect(
              entries.find((entry: { source: string }) => entry.source === "custom"),
            ).not.toHaveProperty("payloadSchema");
            const listText = await bash.exec("events.catalog.list");
            expect(listText.exitCode, listText.stderr).toBe(0);
            expect(listText.stdout).toContain("thing.created");
            const get = "events.catalog.get --source custom --event-type thing.created";
            const json = await bash.exec(`${get} --format json`);
            expect(json.exitCode, json.stderr).toBe(0);
            expect(JSON.parse(json.stdout)).toMatchObject(definition);
            const text = await bash.exec(get);
            expect(text.exitCode, text.stderr).toBe(0);
            expect(text.stdout).toContain("custom:thing.created\nA thing was created.");
            expect(text.stdout).toContain("thingId");
            expect(text.stdout).toContain("actor\n");
            expect(text.stdout).toContain("subject\n");
            const builtIn = await bash.exec(
              "events.catalog.get --source telegram --event-type message.received --format json",
            );
            expect(builtIn.exitCode, builtIn.stderr).toBe(0);
            expect(JSON.parse(builtIn.stdout)).toMatchObject({
              source: "telegram",
              eventType: "message.received",
              payloadSchema: { type: "object" },
            });

            const otherContext = createRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel,
              execution: createBackofficeSystemExecution({ kind: "user", userId: "user-2" }),
              billingOrganizationId: null,
            });
            assert(otherContext.stateBackend);
            const otherBash = createInteractiveBashHost({
              context: { ...otherContext, stateBackend: otherContext.stateBackend },
            }).bash;
            expect(await otherBash.exec(get)).toMatchObject({
              exitCode: 1,
              stderr: expect.stringContaining("Automation event not found"),
            });
            const otherList = await otherBash.exec("events.catalog.list --format json");
            expect(otherList.exitCode, otherList.stderr).toBe(0);
            expect(JSON.parse(otherList.stdout)).not.toContainEqual(
              expect.objectContaining({ source: "custom" }),
            );
            const codemode = await ctx.runCodemode({
              scope: { kind: "org", orgId: "org-1" },
              code: 'async () => await context.user("user-1").events.catalogGet({ source: "custom", eventType: "thing.created" })',
            });
            expect(codemode.result).toMatchObject(definition);
          },
        ),
      ],
    }),
  );
});
