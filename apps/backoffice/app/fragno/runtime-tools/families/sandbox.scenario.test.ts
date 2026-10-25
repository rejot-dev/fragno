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

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryBillingObject } from "../../../../workers/billing.do";
import { InMemoryCodemodeObject } from "../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemorySandboxManagerObject } from "../../../../workers/sandbox-manager.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";

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
  BILLING: (input) => new InMemoryBillingObject(input),
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
  SANDBOX_MANAGER: (input) =>
    new InMemorySandboxManagerObject({
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
