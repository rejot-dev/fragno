import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";
import { createBackofficeProvisioningClient } from "@fragno-dev/backoffice-api/v0/client";
import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { action as exchangeAction } from "@/routes/api/backoffice-execution-token";
import { action as installAction, loader as installLoader } from "@/routes/backoffice/app-install";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../workers/apps.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
import { InMemoryUploadObject } from "../../workers/upload.do";
import { backofficeApiRouter } from "./backoffice-api-router";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const redirectUri = "https://bookkeeping.example/api/auth/oauth2/callback/backoffice";
const emit = BACKOFFICE_PERMISSION.events.emit;
const branding = {
  displayName: "Bookkeeping",
  logoUrl: "https://bookkeeping.example/logo.svg",
  accentColor: "#2f6f4e",
  homeUrl: "https://bookkeeping.example",
  supportUrl: "https://bookkeeping.example/help",
};
const everyProvisioningPermission = [
  "users.provision",
  "organizations.provision",
  "projects.provision",
  "organizations.members.sync",
] as const;

type Vars = {
  existingCookie: string;
  existingUserId: string;
  existingOrgId: string;
  clientId: string;
  clientSecret: string;
  appId: string;
  token: string;
  ownerId: string;
  memberId: string;
  orgId: string;
  projectId: string;
};
type Ctx = BackofficeScenarioContext<Vars>;

function routerContext(ctx: Ctx, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

/** Plays Bookkeeping's server: the published client, with requests served by the API router. */
function provisioning(ctx: Ctx) {
  return createBackofficeProvisioningClient({
    origin,
    accessToken: ctx.vars.token,
    fetch: async (url, init) =>
      await backofficeApiRouter.fetch(new Request(url, init), {
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
      }),
  });
}

async function expectApiError(call: Promise<unknown>, code: BackofficeApiErrorCode) {
  await expect(call).rejects.toMatchObject({ name: "BackofficeApiRequestError", code });
}

async function requestClientCredentialsToken(ctx: Ctx): Promise<string> {
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${ctx.vars.clientId}:${ctx.vars.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "backoffice",
        resource: origin,
      }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

async function sessionUserId(ctx: Ctx, cookie: string) {
  const response = await ctx.runtime.objects.auth
    .singleton()
    .http.fetch(new Request(`${origin}/api/auth/get-session`, { headers: { cookie, origin } }));
  return z.object({ user: z.object({ id: z.string() }) }).parse(await response.json()).user.id;
}

/** The System events a global administrator sees with events.list. */
async function listSystemEvents(ctx: Ctx) {
  const context = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({
      scope: { kind: "system" },
      userId: "platform-admin",
    }),
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...context, stateBackend: context.stateBackend },
  });
  const listed = await bash.exec("events.list --format json");
  assert.equal(listed.exitCode, 0, listed.stderr);
  return automationEventListResultSchema.parse(JSON.parse(listed.stdout)).events;
}

async function runFirstPartyScenario(
  name: string,
  steps: (
    then: (label: string, assertion: (ctx: Ctx) => Promise<void>) => BackofficeScenarioStep,
  ) => BackofficeScenarioStep[],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-first-party-app-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario<Vars>({
        name,
        objects: scenarioObjects,
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({
          existingCookie: "",
          existingUserId: "",
          existingOrgId: "",
          clientId: "",
          clientSecret: "",
          appId: "",
          token: "",
          ownerId: "",
          memberId: "",
          orgId: "",
          projectId: "",
        }),
        setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "existing@backoffice.test",
            captureSessionCookieAs: "existingCookie",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.existingCookie,
            name: "Existing Workspace",
            slug: "existing-workspace",
            captureOrganizationIdAs: "existingOrgId",
          }),
          then.assert(
            "an administrator registers Bookkeeping as a first-party app",
            async (ctx) => {
              ctx.vars.existingUserId = await sessionUserId(ctx, ctx.vars.existingCookie);
              const client = await ctx.runtime.objects.auth
                .singleton()
                .commands.createAdminOAuthClient({
                  administratorUserId: "platform-admin",
                  name: "Bookkeeping",
                  redirectUris: [redirectUri],
                  scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
                  clientType: "confidential",
                  applicationType: "web",
                  clientCredentials: true,
                });
              assert(client.clientType === "confidential");
              ctx.vars.clientId = client.clientId;
              ctx.vars.clientSecret = client.clientSecret;
              const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
                slug: "bookkeeping",
                oauthClientId: client.clientId,
                requestedPermissions: [emit],
                actions: { kind: "none" },
                trust: {
                  kind: "first-party",
                  provisioningPermissions: [...everyProvisioningPermission],
                  branding,
                },
              });
              assert(registered.ok);
              ctx.vars.appId = registered.value.appId;
              ctx.vars.token = await requestClientCredentialsToken(ctx);
            },
          ),
          ...steps((label, assertion) => then.assert(label, assertion)),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Bookkeeping provisions its users, organization, project, and members, once each", async () => {
  await runFirstPartyScenario("first-party provisioning", (then) => [
    then("users are provisioned once, and an address someone holds needs linking", async (ctx) => {
      const client = provisioning(ctx);
      const owner = await client.call("users.provision", {
        externalUserId: "bk-user-1",
        email: "Owner@Bookkeeping.test",
        name: "Owner",
      });
      assert(owner.status === "provisioned" && owner.created);
      ctx.vars.ownerId = owner.userId;
      expect(
        await client.call("users.provision", {
          externalUserId: "bk-user-1",
          email: "owner@bookkeeping.test",
          name: "Owner",
        }),
      ).toEqual({ status: "provisioned", userId: owner.userId, created: false });
      expect(
        await client.call("users.provision", {
          externalUserId: "bk-user-2",
          email: "existing@backoffice.test",
          name: "Someone else",
        }),
      ).toEqual({ status: "requires_link" });
    }),
    then(
      "an organization is provisioned once for a linked owner, with Bookkeeping installed and linked to it",
      async (ctx) => {
        const client = provisioning(ctx);
        const input = {
          externalOrganizationId: "bk-org-1",
          name: "Acme Books",
          ownerUserId: ctx.vars.ownerId,
        };
        const organization = await client.call("organizations.provision", input);
        expect(organization).toEqual({
          organizationId: expect.any(String),
          slug: "acme-books",
          created: true,
        });
        ctx.vars.orgId = organization.organizationId;
        expect(await client.call("organizations.provision", input)).toEqual({
          ...organization,
          created: false,
        });
        expect(
          await ctx.runtime.objects.auth.singleton().commands.getScenarioMemberRoles({
            organizationId: ctx.vars.orgId,
            userId: ctx.vars.ownerId,
          }),
        ).toEqual(["owner"]);
        expect(
          await ctx.runtime.objects.appInstallations
            .forOrg(ctx.vars.orgId)
            .commands.getInstallation({ appId: ctx.vars.appId }),
        ).toMatchObject({
          status: "active",
          grantedPermissions: [emit],
          resourceScope: { kind: "owner" },
          externalAccount: { id: "bk-org-1", label: "Acme Books" },
        });
        // A user who never authorized Bookkeeping cannot be made an owner through it.
        await expectApiError(
          client.call("organizations.provision", {
            externalOrganizationId: "bk-org-2",
            name: "Not Theirs",
            ownerUserId: ctx.vars.existingUserId,
          }),
          "forbidden",
        );

        // Bookkeeping then acts as its installation there.
        const request = new Request(`${origin}/api/backoffice/execution-token`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${ctx.vars.token}`,
          },
          body: JSON.stringify({ scope: { kind: "org", orgId: ctx.vars.orgId } }),
        });
        const exchanged = await exchangeAction({
          request,
          context: routerContext(ctx, request),
          params: {},
          url: new URL(request.url),
          pattern: "/api/backoffice/execution-token",
        });
        assert.equal(exchanged.status, 200, await exchanged.clone().text());
        backofficeExecutionTokenResultSchema.parse(await exchanged.json());
      },
    ),
    then("an administration's project is provisioned once in its organization", async (ctx) => {
      const client = provisioning(ctx);
      const input = {
        externalOrganizationId: "bk-org-1",
        externalProjectId: "bk-administration-1",
        name: "Acme Books",
      };
      const project = await client.call("projects.provision", input);
      expect(project).toEqual({
        organizationId: ctx.vars.orgId,
        projectId: expect.any(String),
        slug: "acme-books",
        created: true,
      });
      expect(await client.call("projects.provision", input)).toEqual({
        ...project,
        created: false,
      });
      expect(
        await ctx.runtime.objects.automations
          .forOrg(ctx.vars.orgId)
          .commands.resolveProjectForExecution({ projectId: project.projectId }),
      ).toMatchObject({ slug: "acme-books", name: "Acme Books" });
      await expectApiError(
        client.call("projects.provision", { ...input, externalOrganizationId: "bk-org-unknown" }),
        "not_found",
      );
    }),
    then("member sync changes only Bookkeeping's members, and keeps an owner", async (ctx) => {
      const client = provisioning(ctx);
      const member = await client.call("users.provision", {
        externalUserId: "bk-user-3",
        email: "member@bookkeeping.test",
        name: "Member",
      });
      assert(member.status === "provisioned");
      ctx.vars.memberId = member.userId;
      // Someone added in Backoffice itself, whom Bookkeeping does not know.
      await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
        members: [
          { organizationId: ctx.vars.orgId, userId: ctx.vars.existingUserId, roles: ["admin"] },
        ],
      });
      const owner = { userId: ctx.vars.ownerId, role: "owner" } as const;

      expect(
        await client.call("organizations.members.sync", {
          externalOrganizationId: "bk-org-1",
          members: [owner, { userId: ctx.vars.memberId, role: "member" }],
        }),
      ).toEqual({ added: [ctx.vars.memberId], updated: [], removed: [] });
      expect(
        await client.call("organizations.members.sync", {
          externalOrganizationId: "bk-org-1",
          members: [owner, { userId: ctx.vars.memberId, role: "admin" }],
        }),
      ).toEqual({ added: [], updated: [ctx.vars.memberId], removed: [] });
      expect(
        await client.call("organizations.members.sync", {
          externalOrganizationId: "bk-org-1",
          members: [owner],
        }),
      ).toEqual({ added: [], updated: [], removed: [ctx.vars.memberId] });
      const auth = ctx.runtime.objects.auth.singleton().commands;
      expect(
        await auth.getScenarioMemberRoles({
          organizationId: ctx.vars.orgId,
          userId: ctx.vars.existingUserId,
        }),
      ).toEqual(["admin"]);

      await expectApiError(
        client.call("organizations.members.sync", {
          externalOrganizationId: "bk-org-1",
          members: [],
        }),
        "conflict",
      );
      await expectApiError(
        client.call("organizations.members.sync", {
          externalOrganizationId: "bk-org-1",
          members: [owner, { userId: ctx.vars.existingUserId, role: "member" }],
        }),
        "forbidden",
      );
    }),
    then(
      "each operation needs its own permission, and only first-party apps have any",
      async (ctx) => {
        const apps = ctx.runtime.objects.apps.singleton().commands;
        const client = provisioning(ctx);
        assert(
          (
            await apps.updateAppTrust({
              appId: ctx.vars.appId,
              trust: {
                kind: "first-party",
                provisioningPermissions: ["users.provision"],
                branding,
              },
            })
          ).ok,
        );
        await expectApiError(
          client.call("projects.provision", {
            externalOrganizationId: "bk-org-1",
            externalProjectId: "bk-administration-2",
            name: "Second",
          }),
          "forbidden",
        );
        assert(
          (await apps.updateAppTrust({ appId: ctx.vars.appId, trust: { kind: "third-party" } })).ok,
        );
        await expectApiError(
          client.call("users.provision", {
            externalUserId: "bk-user-1",
            email: "owner@bookkeeping.test",
            name: "Owner",
          }),
          "forbidden",
        );
      },
    ),
    then("administrators audit every provisioning call in the System events", async (ctx) => {
      const provisioned = (await listSystemEvents(ctx)).filter(
        ({ source }) => source === "provisioning",
      );
      const counts: Record<string, number> = {};
      for (const { eventType } of provisioned) {
        counts[eventType] = (counts[eventType] ?? 0) + 1;
      }
      expect(counts).toEqual({
        "user.provisioned": 4,
        "organization.provisioned": 2,
        "project.provisioned": 2,
        "organization.members.synced": 3,
      });
      expect(
        provisioned.find(({ eventType }) => eventType === "project.provisioned"),
      ).toMatchObject({
        scope: { kind: "system" },
        actors: { initiator: { scope: "internal", type: "app", id: ctx.vars.appId } },
        payload: {
          appId: ctx.vars.appId,
          input: { externalProjectId: "bk-administration-1" },
          result: { organizationId: ctx.vars.orgId },
        },
      });
    }),
  ]);
});

test("an owner links an existing organization to a first-party app without reviewing its permissions", async () => {
  await runFirstPartyScenario("first-party install page", (then) => [
    then(
      "the install page offers only where to install, and grants what the app asks for",
      async (ctx) => {
        const url = new URL(`${origin}/backoffice/apps/install`);
        url.search = new URLSearchParams({
          client_id: ctx.vars.clientId,
          redirect_uri: "https://bookkeeping.example/dashboard/backoffice/callback",
          state: "bookkeeping-link-state",
        }).toString();
        const cookie = ctx.vars.existingCookie;
        const page = new Request(url, { headers: { cookie } });
        const loaded = await installLoader({
          request: page,
          context: routerContext(ctx, page),
          params: {},
          url,
          pattern: "/backoffice/apps/install",
        });
        expect(loaded.data).toMatchObject({ firstParty: true });

        const decision = new Request(url, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams([
            ["intent", "install"],
            ["owner", `org:${ctx.vars.existingOrgId}`],
            ["resources", "owner"],
            ["actionsRevision", "1"],
          ]),
        });
        const installed = await installAction({
          request: decision,
          context: routerContext(ctx, decision),
          params: {},
          url,
          pattern: "/backoffice/apps/install",
        });
        assert(installed instanceof Response, JSON.stringify(installed));
        assert(new URL(installed.headers.get("location") ?? "").searchParams.has("code"));
        expect(
          await ctx.runtime.objects.appInstallations
            .forOrg(ctx.vars.existingOrgId)
            .commands.getInstallation({ appId: ctx.vars.appId }),
        ).toMatchObject({
          status: "active",
          grantedPermissions: [emit],
          resourceScope: { kind: "owner" },
        });
      },
    ),
  ]);
});
