import { expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { action, loader } from "./durable-hooks-scope-layout";

const scenarioObjects = {
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const pagePath = "/backoffice/internals/system/system/durable-hooks/automations";
const administrator = {
  user: { id: "admin-1", email: "admin@example.test", role: "admin", jurisdiction: null },
} as unknown as BackofficeMeData;

function routeArgs(ctx: BackofficeScenarioContext, request: Request) {
  const context = createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  provideBackofficeShellRequest(context, { me: administrator, routeScope: { kind: "system" } });
  return {
    request,
    context,
    url: new URL(request.url),
    params: { scopeKind: "system", scopeId: "system", objectId: "automations" },
  } as never;
}

async function openIngestHooks(ctx: BackofficeScenarioContext) {
  const { items } = await loader(routeArgs(ctx, new Request(`${origin}${pagePath}`)));
  return items.filter((hook) => hook.hookName === "internalIngestEvent");
}

test("an administrator wakes the hooks a lost alarm left pending", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "an administrator wakes the hooks a lost alarm left pending",
      // Only alarms run hooks here, as on Cloudflare: draining would run them regardless.
      options: { drain: false },
      steps: ({ then, runner }) => [
        then.assert("ingesting an event queues its hook", async (ctx) => {
          await ctx.runtime.objects.automations.singleton().commands.ingestEvent({
            id: "intake-event",
            scopeRestriction: null,
            scope: { kind: "system" },
            source: "custom",
            eventType: "intake.received",
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: {},
            actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
            subject: null,
            causation: { kind: "origin" },
          });
          expect(await openIngestHooks(ctx)).toEqual([
            expect.objectContaining({ status: "pending" }),
          ]);
        }),
        runner.dropObjectAlarm({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
        then.assert("without its alarm, the hook stays pending", async (ctx) => {
          await ctx.runtime.drainAlarms();
          expect(await openIngestHooks(ctx)).toEqual([
            expect.objectContaining({ status: "pending" }),
          ]);
        }),
        then.assert("waking the object's hooks runs the pending hook", async (ctx) => {
          const woke = await action(
            routeArgs(
              ctx,
              new Request(`${origin}${pagePath}`, { method: "POST", headers: { origin } }),
            ),
          );
          expect(woke).toEqual({ woke: true });
          await ctx.runtime.drainAlarms();
          expect(await openIngestHooks(ctx)).toEqual([
            expect.objectContaining({ status: "completed" }),
          ]);
        }),
      ],
    }),
  );
});
