import { assert, expect, test, vi } from "vitest";

import { createHash, randomBytes } from "node:crypto";
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
import { loader as consentLoader } from "@/routes/backoffice/oauth-consent";
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
  "organizations.provision",
  "projects.provision",
  "invitations.accept",
] as const;

type Vars = {
  existingCookie: string;
  existingUserId: string;
  existingOrgId: string;
  clientId: string;
  clientSecret: string;
  appId: string;
  token: string;
  ownerCookie: string;
  ownerId: string;
  colleagueCookie: string;
  colleagueId: string;
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

/** The user signs in to Bookkeeping, and Backoffice records their consent without asking. */
async function authorizeBookkeeping(ctx: Ctx, cookie: string) {
  const authorization = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(
      `${origin}/api/auth/oauth2/authorize?${new URLSearchParams({
        client_id: ctx.vars.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile email offline_access backoffice",
        state: "bookkeeping-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(randomBytes(32).toString("base64url"))
          .digest("base64url"),
      })}`,
      { headers: { cookie, accept: "text/html" } },
    ),
  );
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const url = new URL(authorization.headers.get("location") ?? "", origin);
  assert.equal(url.pathname, "/backoffice/oauth/consent");
  const request = new Request(url, { headers: { cookie } });
  const approved = await consentLoader({
    request,
    context: routerContext(ctx, request),
    params: {},
    url,
    pattern: url.pathname,
  });
  assert(approved instanceof Response, "First-party apps are approved without a review.");
  const callback = new URL(approved.headers.get("location") ?? "");
  assert.equal(callback.origin + callback.pathname, redirectUri);
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
          ownerCookie: "",
          ownerId: "",
          colleagueCookie: "",
          colleagueId: "",
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

test("Bookkeeping provisions its organization and project, and brings invited people in", async () => {
  await runFirstPartyScenario("first-party provisioning", (then) => [
    then(
      "an organization is provisioned once for a user who signed in to Bookkeeping, with Bookkeeping installed and linked to it",
      async (ctx) => {
        const owner = await ctx.runtime.objects.auth.singleton().http.fetch(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({
              email: "owner@bookkeeping.test",
              password: "password123",
              name: "Owner",
            }),
          }),
        );
        assert.equal(owner.status, 200, await owner.clone().text());
        ctx.vars.ownerCookie = owner.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
        ctx.vars.ownerId = await sessionUserId(ctx, ctx.vars.ownerCookie);
        await authorizeBookkeeping(ctx, ctx.vars.ownerCookie);

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
        // A user who never signed in to Bookkeeping cannot be made an owner through it.
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
    then(
      "an invited colleague joins once they sign in to Bookkeeping with the invited address",
      async (ctx) => {
        const auth = ctx.runtime.objects.auth.singleton().commands;
        const client = provisioning(ctx);
        const { invitationId } = await auth.createOrganizationInvitation({
          organizationId: ctx.vars.orgId,
          inviterUserId: ctx.vars.ownerId,
          email: "colleague@bookkeeping.test",
          roles: ["member"],
        });
        const colleague = await ctx.runtime.objects.auth.singleton().http.fetch(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({
              email: "colleague@bookkeeping.test",
              password: "password123",
              name: "Colleague",
            }),
          }),
        );
        ctx.vars.colleagueCookie = colleague.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
        ctx.vars.colleagueId = await sessionUserId(ctx, ctx.vars.colleagueCookie);
        const accept = { invitationId, userId: ctx.vars.colleagueId };

        await authorizeBookkeeping(ctx, ctx.vars.colleagueCookie);
        // Signing in with a code proves the address; a password sign-up has not.
        await expectApiError(client.call("invitations.accept", accept), "forbidden");
        await auth.verifyAdminUserEmail({ email: "colleague@bookkeeping.test" });

        const membership = await client.call("invitations.accept", accept);
        expect(membership).toMatchObject({
          organization: { organizationId: ctx.vars.orgId, name: "Acme Books" },
          roles: ["member"],
        });
        expect(await client.call("invitations.accept", accept)).toEqual(membership);
      },
    ),
    then(
      "Bookkeeping cannot use an invitation for someone else, for someone who never signed in to it, or outside its organizations",
      async (ctx) => {
        const auth = ctx.runtime.objects.auth.singleton().commands;
        const client = provisioning(ctx);
        const forSomeoneElse = await auth.createOrganizationInvitation({
          organizationId: ctx.vars.orgId,
          inviterUserId: ctx.vars.ownerId,
          email: "existing@backoffice.test",
          roles: ["admin"],
        });
        await expectApiError(
          client.call("invitations.accept", {
            invitationId: forSomeoneElse.invitationId,
            userId: ctx.vars.colleagueId,
          }),
          "forbidden",
        );
        // The invited person themselves, but they never signed in to Bookkeeping.
        await auth.verifyAdminUserEmail({ email: "existing@backoffice.test" });
        await expectApiError(
          client.call("invitations.accept", {
            invitationId: forSomeoneElse.invitationId,
            userId: ctx.vars.existingUserId,
          }),
          "forbidden",
        );
        // Bookkeeping is not installed in the existing workspace.
        const elsewhere = await auth.createOrganizationInvitation({
          organizationId: ctx.vars.existingOrgId,
          inviterUserId: ctx.vars.existingUserId,
          email: "colleague@bookkeeping.test",
          roles: ["member"],
        });
        await expectApiError(
          client.call("invitations.accept", {
            invitationId: elsewhere.invitationId,
            userId: ctx.vars.colleagueId,
          }),
          "not_found",
        );
        expect(
          await auth.getScenarioMemberRoles({
            organizationId: ctx.vars.existingOrgId,
            userId: ctx.vars.colleagueId,
          }),
        ).toBeNull();
      },
    ),
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
                provisioningPermissions: ["organizations.provision"],
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
          client.call("organizations.provision", {
            externalOrganizationId: "bk-org-1",
            name: "Acme Books",
            ownerUserId: ctx.vars.ownerId,
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
        "organization.provisioned": 2,
        "project.provisioned": 2,
        "invitation.accepted": 2,
      });
      expect(
        provisioned.find(({ eventType }) => eventType === "invitation.accepted"),
      ).toMatchObject({
        scope: { kind: "system" },
        actors: { initiator: { scope: "internal", type: "app", id: ctx.vars.appId } },
        payload: {
          appId: ctx.vars.appId,
          input: { userId: ctx.vars.colleagueId },
          result: { organization: { organizationId: ctx.vars.orgId } },
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
