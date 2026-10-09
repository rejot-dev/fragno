import { assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createBackofficeUserExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
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

const acme: BackofficeContextScope = { kind: "org", orgId: "org-acme" };

function terminal(ctx: BackofficeScenarioContext, userId: string, scope: BackofficeContextScope) {
  const context = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope, userId }),
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  return createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
    .bash;
}

async function runJson(bash: ReturnType<typeof terminal>, command: string) {
  const result = await bash.exec(`${command} --format json`);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("account and organization runtime tool scenarios", () => {
  test("an organization admin invites a user who accepts from their own account", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "organization invitation through runtime tools",
        env: { DOCS_PUBLIC_BASE_URL: "https://backoffice.test/" },
        vars: () => ({ invitationId: "" }),
        setup: ({ given }) => [
          given.auth.user({ id: "owner", email: "owner@example.com" }),
          given.auth.user({ id: "admin", email: "admin@example.com" }),
          given.auth.user({ id: "member", email: "member@example.com" }),
          given.auth.user({ id: "invitee", email: "invitee@example.com" }),
          given.auth.organization({
            id: "org-acme",
            name: "Acme",
            slug: "acme",
            ownerUserId: "owner",
          }),
          given.auth.member({ orgId: "org-acme", userId: "admin", roles: ["admin"] }),
          given.auth.member({ orgId: "org-acme", userId: "member", roles: ["member"] }),
        ],
        steps: ({ then }) => [
          then.assert("members can read but not manage the organization", async (ctx) => {
            const bash = terminal(ctx, "member", acme);
            expect(await runJson(bash, "org.get")).toMatchObject({
              organization: { name: "Acme", slug: "acme" },
              roles: ["member"],
            });
            const denied = await bash.exec(
              "org.invitations.create --email invitee@example.com --role member",
            );
            assert.equal(denied.exitCode, 1);
            expect(denied.stderr).toContain("Required permission: org.manage.");
          }),
          then.assert("admins cannot invite owners", async (ctx) => {
            const denied = await terminal(ctx, "admin", acme).exec(
              "org.invitations.create --email invitee@example.com --role owner",
            );
            assert.equal(denied.exitCode, 1);
            expect(denied.stderr).toMatch(/not allowed to invite a user with this role/iu);
          }),
          then.assert("admins rename the organization and invite by link", async (ctx) => {
            const bash = terminal(ctx, "admin", acme);
            expect(await runJson(bash, 'org.update --name "Acme Inc."')).toMatchObject({
              name: "Acme Inc.",
              slug: "acme",
            });
            const created = await bash.exec(
              "org.invitations.create --email Invitee@Example.com --role member",
            );
            assert.equal(created.exitCode, 0, created.stderr);
            const [invitation] = (await runJson(bash, "org.invitations.list")).invitations;
            expect(invitation).toMatchObject({ email: "invitee@example.com", roles: ["member"] });
            expect(created.stdout).toBe(
              `https://backoffice.test/backoffice/invitations/${invitation.invitationId}\n`,
            );
            expect(invitation.url).toBe(created.stdout.trim());
            ctx.vars.invitationId = invitation.invitationId;

            const repeated = await bash.exec(
              "org.invitations.create --email invitee@example.com --role member",
            );
            assert.equal(repeated.exitCode, 1);
            expect(repeated.stderr).toMatch(/already invited/iu);
          }),
          then.assert("the invitee accepts from their own account", async (ctx) => {
            const bash = terminal(ctx, "invitee", { kind: "user", userId: "invitee" });
            expect(await runJson(bash, "account.orgs.list")).toEqual({ organizations: [] });
            expect((await runJson(bash, "account.invitations.list")).invitations).toMatchObject([
              {
                invitationId: ctx.vars.invitationId,
                organization: { name: "Acme Inc.", slug: "acme" },
                roles: ["member"],
              },
            ]);
            const accepted = await bash.exec(
              `account.invitations.accept --invitation ${ctx.vars.invitationId}`,
            );
            assert.equal(accepted.exitCode, 0, accepted.stderr);
            assert(accepted.stdout === "Joined Acme Inc. (acme): member\n");
            expect(await runJson(bash, "account.invitations.list")).toEqual({ invitations: [] });
          }),
          then.assert("the organization reflects the accepted invitation", async (ctx) => {
            const bash = terminal(ctx, "invitee", acme);
            expect(await runJson(bash, "org.invitations.list")).toMatchObject({
              invitations: [],
            });
            const firstPage = await runJson(bash, "org.members.list --page-size 3");
            assert.equal(firstPage.hasNextPage, true);
            const secondPage = await runJson(
              bash,
              `org.members.list --page-size 3 --cursor ${firstPage.nextCursor}`,
            );
            assert.equal(secondPage.hasNextPage, false);
            const members = [...firstPage.members, ...secondPage.members];
            expect(
              members.map(({ email, roles }: { email: string; roles: string[] }) => ({
                email,
                roles,
              })),
            ).toEqual(
              expect.arrayContaining([
                { email: "owner@example.com", roles: ["owner"] },
                { email: "admin@example.com", roles: ["admin"] },
                { email: "member@example.com", roles: ["member"] },
                { email: "invitee@example.com", roles: ["member"] },
              ]),
            );
            assert.equal(members.length, 4);
          }),
          then.assert("users manage only their own profile", async (ctx) => {
            const bash = terminal(ctx, "invitee", acme);
            expect(await runJson(bash, 'account.profile.update --name "Ivy"')).toMatchObject({
              userId: "invitee",
              name: "Ivy",
            });
            const me = await bash.exec("account.me --print name");
            assert.equal(me.exitCode, 0, me.stderr);
            assert.equal(me.stdout, "Ivy\n");
            expect(await runJson(bash, "account.applications.list")).toMatchObject({
              consents: [],
              hasNextPage: false,
            });
          }),
        ],
      }),
    );
  });
});
