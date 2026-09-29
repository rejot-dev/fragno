import { assert, describe, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

async function createSystemTerminalBash(ctx: BackofficeScenarioContext) {
  const execution = createBackofficeSystemExecution({ kind: "system" });
  const kernel = new BackofficeKernel(ctx.runtime.services);
  const fileSystem = await createBackofficeFileSystem({
    objects: ctx.runtime.objects,
    kernel,
    execution,
    config: ctx.runtime.config,
  });
  return createInteractiveBashHost({
    fs: fileSystem,
    context: createRouteBackedRuntimeContext({
      runtime: ctx.runtime.services,
      kernel,
      execution,
    }),
  }).bash;
}

describe("system admin command scenarios", () => {
  test("shows organization creation help from the system terminal", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "System terminal admin organization help",
        steps: ({ then }) => [
          then.assert("system admin command help is available", async (ctx) => {
            const bash = await createSystemTerminalBash(ctx);
            const help = await bash.exec("admin.organisation.create --help");

            assert.equal(help.exitCode, 0, help.stderr);
            assert.match(help.stdout, /admin\.organisation\.create/u);
          }),
        ],
      }),
    );
  });

  test("creates an organization from the system terminal", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "System terminal admin organization creation",
        steps: ({ given, then }) => [
          given.auth.user({ id: "owner", email: "owner@example.com" }),
          then.assert("system admin organization creation succeeds", async (ctx) => {
            const bash = await createSystemTerminalBash(ctx);
            const created = await bash.exec(
              'admin.organisation.create --name "Acme" --slug acme --owner-email owner@example.com',
            );

            assert.equal(created.exitCode, 0, created.stderr);
            assert(
              await ctx.runtime.objects.auth.singleton().commands.getOrganizationBySlug("acme"),
            );
          }),
        ],
      }),
    );
  });
});
