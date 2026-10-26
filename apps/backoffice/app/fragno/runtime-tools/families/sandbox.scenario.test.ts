import { expect, test, vi } from "vitest";

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

const PERSONAL_SCOPE = { kind: "user", userId: "user-1" } as const;

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
            scope: { kind: "org", orgId: "org-1" },
            code: "async () => await sandbox.listSandboxes()",
          });
          expect(listed.result).toEqual([]);
        }),
      ],
    }),
  );
});
