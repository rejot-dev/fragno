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

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../../workers/codemode.do";
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
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
  // The runtime context probes Resend for org scopes; listing identities never sends mail.
  RESEND: null,
} satisfies LocalBackofficeObjects;

const scope = { kind: "org" as const, orgId: "org-1" };
const telegramChat = (id: string) =>
  ({ scope: "external", source: "telegram", type: "chat", id }) as const;

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
                  identity: telegramChat(externalId),
                  userId,
                  verifiedByClaimId: `claim-${externalId}`,
                },
                { execution },
              );
            }
            await automations.commands.revokeExternalIdentity(
              { identity: telegramChat("1002"), expectedUserId: "user-2", expectedVersion: 0 },
              { execution },
            );

            const context = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution,
              billingOrganizationId: null,
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
            expect(text.stdout).toContain("telegram\tchat\t1002\tuser-2\trevoked");
          },
        ),
      ],
    }),
  );
});
