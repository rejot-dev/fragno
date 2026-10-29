import { expect, test, vi, assert } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { SandboxContainerControl } from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { CLOUDFLARE_SANDBOX_PROVIDER, type SandboxRuntimeProviders } from "@/sandbox/contracts";

import { ApiObject } from "../../../../workers/api-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { FormsObject } from "../../../../workers/forms-object";
import { OtpObject } from "../../../../workers/otp-object";
import { SandboxManagerObject } from "../../../../workers/sandbox-manager-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";

/** Containers that echo `printf` arguments, so command output is observable. */
function scenarioSandboxProviders(): SandboxRuntimeProviders {
  return {
    [CLOUDFLARE_SANDBOX_PROVIDER]: {
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      async getHandle(): Promise<SandboxContainerControl> {
        return {
          start: async () => ({ restoredSnapshot: null }),
          exec: async ({ argv }) => ({
            status: "exited",
            exitCode: 0,
            stdout: /^printf (\w+)$/.exec(argv.at(-1) ?? "")?.[1] ?? "",
            stderr: "",
          }),
          snapshot: async () => ({ status: "saved", snapshot: { id: "snapshot-1", size: 1024 } }),
          stop: async () => {},
        };
      },
    },
  };
}

const scenarioObjects = {
  BILLING: (input) => new BillingObject(input),
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  SANDBOX_MANAGER: (input) =>
    new SandboxManagerObject({
      ...input,
      sandboxProviders: input.createSandboxProviders(input.state.id.toString()),
    }),
} satisfies LocalBackofficeObjects;

const PERSONAL_SCOPE = { kind: "user", userId: "user-1", jurisdiction: null } as const;

test("a personal codemode run starts its own sandbox and runs commands in it", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Personal scopes manage their own sandboxes",
      createSandboxProviders: scenarioSandboxProviders,
      steps: ({ then }) => [
        then.assert("the personal sandbox starts and runs a command", async (ctx) => {
          await ctx.runCodemode({
            scope: PERSONAL_SCOPE,
            code: 'async () => await sandbox.startSandbox({ id: "convert", startupCommand: "true" })',
            assertToolCalls: ["sandbox.startSandbox"],
          });
          await ctx.drain();

          const listed = await ctx.runCodemode({
            scope: PERSONAL_SCOPE,
            code: "async () => await sandbox.listSandboxes()",
          });
          expect(listed.result).toEqual([
            expect.objectContaining({ id: "convert", status: "running" }),
          ]);

          const ran = await ctx.runCodemode({
            scope: PERSONAL_SCOPE,
            code: 'async () => await sandbox.executeCommand({ sandboxId: "convert", command: "printf converted" })',
          });
          expect(ran.result).toEqual({ ok: true, stdout: "converted", stderr: "", exitCode: 0 });
        }),
        then.assert("an organization does not see the personal sandbox", async (ctx) => {
          const listed = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1", jurisdiction: null },
            code: "async () => await sandbox.listSandboxes()",
          });
          expect(listed.result).toEqual([]);
        }),
      ],
    }),
  );
});

test("a personal sandbox's running time is billed to its user by instance type", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Personal sandbox usage billing",
      createSandboxProviders: scenarioSandboxProviders,
      steps: ({ when, then }) => [
        then.assert("a sandbox that runs until stopped starts", async (ctx) => {
          await ctx.runCodemode({
            scope: PERSONAL_SCOPE,
            code: 'async () => await sandbox.startSandbox({ id: "render", keepAlive: true, instanceType: "standard-2" })',
            assertToolCalls: ["sandbox.startSandbox"],
          });
          await ctx.drain();
        }),
        when.time.advance("1h"),
        then.assert("its first hour is on the user's ledger", async (ctx) => {
          await ctx.drain();
          const billing = ctx.runtime.objects.billing.for(PERSONAL_SCOPE);
          // The hour may straddle a month start, which bills each month its part.
          const periods = new Set(
            [ctx.runtime.now() - 60 * 60 * 1000, ctx.runtime.now()].map((epochMs) =>
              new Date(epochMs).toISOString().slice(0, 7),
            ),
          );
          const trackers = await Promise.all(
            [...periods].map(async (period) => {
              const page = await billing.commands.getTrackers({
                scope: PERSONAL_SCOPE,
                period,
                pageSize: 100,
              });
              return page.trackers.filter((tracker) => tracker.meter.startsWith("sandbox."));
            }),
          );
          expect(trackers.flat()).toEqual(
            Array.from({ length: periods.size }, () =>
              expect.objectContaining({ meter: "sandbox.instance.standard-2", unit: "second" }),
            ),
          );
          assert(
            trackers.flat().reduce((total, tracker) => total + Number(tracker.quantity), 0) ===
              3600,
          );
        }),
      ],
    }),
  );
});
