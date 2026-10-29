import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { FormsObject } from "../../../../workers/forms-object";
import { action, loader } from "./durable-hooks-scope-layout";

const scenarioObjects = {
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const pagePath = "/backoffice/internals/system/system/durable-hooks/forms";
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
    params: { scopeKind: "system", scopeId: "system", objectId: "forms" },
  } as never;
}

async function openQueue(ctx: BackofficeScenarioContext) {
  return (await loader(routeArgs(ctx, new Request(`${origin}${pagePath}`)))).items;
}

test("an administrator wakes the hooks a lost alarm left pending", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "an administrator wakes the hooks a lost alarm left pending",
      // Only alarms run hooks here, as on Cloudflare: draining would run them regardless.
      options: { drain: false },
      steps: ({ then, runner }) => [
        then.assert("creating a form queues its hook", async (ctx) => {
          const response = await ctx.runtime.objects.forms.singleton().http.fetchAuthorized(
            new Request(`${origin}/api/forms/admin/forms`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: "Intake",
                slug: "intake",
                description: null,
                status: "draft",
                dataSchema: { type: "object" },
              }),
            }),
            { execution: createBackofficeSystemExecution({ kind: "system" }) },
          );
          assert(response.ok, await response.text());
          expect(await openQueue(ctx)).toEqual([
            expect.objectContaining({ hookName: "onFormCreated", status: "pending" }),
          ]);
        }),
        runner.dropObjectAlarm({ binding: "FORMS", scope: { kind: "singleton" } }),
        then.assert("without its alarm, the hook stays pending", async (ctx) => {
          await ctx.runtime.drainAlarms();
          expect(await openQueue(ctx)).toEqual([
            expect.objectContaining({ hookName: "onFormCreated", status: "pending" }),
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
          expect(await openQueue(ctx)).toEqual([
            expect.objectContaining({ hookName: "onFormCreated", status: "completed" }),
          ]);
        }),
      ],
    }),
  );
});
