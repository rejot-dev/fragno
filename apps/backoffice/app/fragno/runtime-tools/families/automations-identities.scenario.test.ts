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
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
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
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  // The runtime context probes Resend for org scopes; listing identities never sends mail.
  RESEND: null,
} satisfies LocalBackofficeObjects;

const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
const telegramUser = (id: string) =>
  ({ scope: "external", source: "telegram", type: "user", id }) as const;

test("identity.external.list pages through active and revoked bindings", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "external identity bindings are listable from runtime tools",
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, slug: "ada-labs", name: "Ada Labs" }),
      ],
      steps: ({ then }) => [
        then.assert(
          "bindings are bound, one is revoked, and the tool pages through them",
          async (ctx) => {
            const automations = ctx.runtime.objects.automations.for(scope);
            const execution = createBackofficeSystemExecution(scope);
            for (const [externalId, userId] of [
              ["1001", "user-1"],
              ["1002", "user-2"],
              ["1003", "user-1"],
            ] as const) {
              await automations.commands.bindExternalIdentity(
                {
                  identity: telegramUser(externalId),
                  userId,
                  verifiedByClaimId: `claim-${externalId}`,
                },
                { execution },
              );
            }
            await automations.commands.revokeExternalIdentity(
              { identity: telegramUser("1002"), expectedUserId: "user-2", expectedVersion: 0 },
              { execution },
            );

            const context = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution,
            });
            assert(context.stateBackend);
            const { bash } = await createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });

            const first = await bash.exec("identity.external.list --limit 2 --format json");
            expect(first.exitCode, first.stderr).toBe(0);
            const firstPage = JSON.parse(first.stdout);
            assert(firstPage.nextCursor);
            const second = await bash.exec(
              `identity.external.list --cursor '${firstPage.nextCursor}' --format json`,
            );
            expect(second.exitCode, second.stderr).toBe(0);
            const secondPage = JSON.parse(second.stdout);

            expect(secondPage.nextCursor).toBeNull();
            expect([...firstPage.bindings, ...secondPage.bindings]).toEqual([
              expect.objectContaining({
                externalId: "1001",
                userId: "user-1",
                status: "active",
                revokedAt: null,
              }),
              expect.objectContaining({
                externalId: "1002",
                userId: "user-2",
                status: "revoked",
                revokedAt: expect.any(String),
              }),
              expect.objectContaining({
                externalId: "1003",
                userId: "user-1",
                status: "active",
                verifiedByClaimId: "claim-1003",
              }),
            ]);

            const text = await bash.exec("identity.external.list");
            expect(text.exitCode, text.stderr).toBe(0);
            expect(text.stdout).toContain("telegram\tuser\t1002\tuser-2\trevoked");
          },
        ),
      ],
    }),
  );
});
