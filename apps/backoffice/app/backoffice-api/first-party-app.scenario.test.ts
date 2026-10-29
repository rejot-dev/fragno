import { assert, expect, test, vi } from "vitest";

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";
import {
  createBackofficeApiClient,
  createBackofficeProvisioningClient,
} from "@fragno-dev/backoffice-api/v0/client";
import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import type { CreateInvitationInput } from "@fragno-dev/backoffice-api/v0/provisioning";
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

import { ApiObject } from "../../workers/api-object";
import { AppInstallationsObject } from "../../workers/app-installations-object";
import { AppsObject } from "../../workers/apps-object";
import { AuthObject } from "../../workers/auth-object";
import { AutomationsObject } from "../../workers/automations-object";
import { FormsObject } from "../../workers/forms-object";
import { OtpObject } from "../../workers/otp-object";
import { UploadObject } from "../../workers/upload-object";
import { backofficeApiRouter } from "./backoffice-api-router";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
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
  "organizations.provisionForInvitee",
  "projects.provision",
  "invitations.create",
  "invitations.send",
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
/** Bookkeeping sends a browser to Backoffice's authorization; returns where it lands. */
async function startAuthorization(ctx: Ctx, cookie: string, params: Record<string, string>) {
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
        ...params,
      })}`,
      { headers: { cookie, accept: "text/html" } },
    ),
  );
  assert.equal(authorization.status, 302, await authorization.clone().text());
  return new URL(authorization.headers.get("location") ?? "", origin);
}

async function authorizeBookkeeping(ctx: Ctx, cookie: string) {
  const url = await startAuthorization(ctx, cookie, {});
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

/** Runs a Bash command as Backoffice's global administrator, in System context. */
async function execAsAdministrator(ctx: Ctx, command: string): Promise<string> {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({
      scope: { kind: "system" },
      userId: "platform-admin",
    }),
  });
  assert(context.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...context, stateBackend: context.stateBackend },
  });
  const result = await bash.exec(command);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

/** Plays Bookkeeping's server acting as its installation in the organization. */
async function callAsInstallation(ctx: Ctx) {
  const request = new Request(`${origin}/api/backoffice/execution-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.vars.token}` },
    body: JSON.stringify({ scope: { kind: "org", orgId: ctx.vars.orgId, jurisdiction: null } }),
  });
  const exchanged = await exchangeAction({
    request,
    context: routerContext(ctx, request),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/execution-token",
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const client = createBackofficeApiClient({
    origin,
    accessToken: backofficeExecutionTokenResultSchema.parse(await exchanged.json()).accessToken,
    fetch: async (url, init) =>
      await backofficeApiRouter.fetch(new Request(url, init), {
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
      }),
  });
  const scope = { kind: "org", orgId: ctx.vars.orgId, jurisdiction: null } as const;
  return {
    fire: () =>
      client.call(scope, "events.fire", {
        eventType: "bookkeeping.connection.tested",
        payload: { message: "Hello from Bookkeeping" },
      }),
    list: () => client.call(scope, "events.list", {}),
  };
}

/** The System events a global administrator sees with events.list. */
async function listSystemEvents(ctx: Ctx) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({
      scope: { kind: "system" },
      userId: "platform-admin",
    }),
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
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
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
          jurisdiction: null,
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
            .for({ kind: "org", orgId: ctx.vars.orgId, jurisdiction: null })
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
        expect(await (await callAsInstallation(ctx)).fire()).toMatchObject({ accepted: true });
      },
    ),
    then("an administration's project is provisioned once in its organization", async (ctx) => {
      const client = provisioning(ctx);
      const input = {
        organizationId: ctx.vars.orgId,
        externalProjectId: "bk-administration-1",
        name: "Acme Books",
        createdByUserId: ctx.vars.ownerId,
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
          .for({ kind: "org", orgId: ctx.vars.orgId, jurisdiction: null })
          .commands.resolveProjectForExecution({ projectId: project.projectId }),
      ).toMatchObject({ slug: "acme-books", name: "Acme Books" });
      // Bookkeeping is not installed in the existing workspace.
      await expectApiError(
        client.call("projects.provision", {
          ...input,
          organizationId: ctx.vars.existingOrgId,
          createdByUserId: ctx.vars.existingUserId,
        }),
        "not_found",
      );
      // The same identifier in another of Bookkeeping's organizations is another project.
      const other = await client.call("organizations.provision", {
        externalOrganizationId: "bk-org-other",
        name: "Other Books",
        ownerUserId: ctx.vars.ownerId,
      });
      expect(
        await client.call("projects.provision", { ...input, organizationId: other.organizationId }),
      ).toMatchObject({ created: true, projectId: expect.not.stringMatching(project.projectId) });
    }),
    then(
      "an invited colleague joins once they sign in to Bookkeeping with the invited address",
      async (ctx) => {
        const client = provisioning(ctx);
        // The owner invites on Bookkeeping's members page, and Bookkeeping invites as them.
        const invite: CreateInvitationInput = {
          organizationId: ctx.vars.orgId,
          inviterUserId: ctx.vars.ownerId,
          email: "Colleague@Bookkeeping.test",
          roles: ["member"],
        };
        const invitation = await client.call("invitations.create", invite);
        expect(invitation).toMatchObject({
          organizationId: ctx.vars.orgId,
          email: "colleague@bookkeeping.test",
          roles: ["member"],
        });
        expect(await client.call("invitations.create", invite)).toEqual(invitation);
        await expectApiError(
          client.call("invitations.create", { ...invite, roles: ["admin"] }),
          "conflict",
        );
        const { invitationId } = invitation;
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

        // Bookkeeping has Backoffice email the invitation in its name, linking to its own page.
        const send = { invitationId, url: `${branding.homeUrl}/invitations/${invitationId}` };
        expect(await client.call("invitations.send", send)).toEqual({
          email: "colleague@bookkeeping.test",
        });
        await client.call("invitations.send", send);
        const sent = ctx.fakes.resend?.queueEmailCalls ?? [];
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({
          input: {
            to: "colleague@bookkeeping.test",
            subject: expect.stringMatching(/ invited you to Acme Books on Bookkeeping$/u),
            text: expect.stringContaining(send.url),
          },
          options: { senderName: "Bookkeeping" },
        });
        // Asking again queues the same email, which Resend sends once.
        assert.equal(sent[1]?.options.idempotencyKey, sent[0]?.options.idempotencyKey);
        await expectApiError(
          client.call("invitations.send", { ...send, url: "https://elsewhere.example/join" }),
          "invalid_request",
        );

        await authorizeBookkeeping(ctx, ctx.vars.colleagueCookie);
        // Until they join, Bookkeeping cannot create projects there as them.
        await expectApiError(
          client.call("projects.provision", {
            organizationId: ctx.vars.orgId,
            externalProjectId: "bk-administration-colleague",
            name: "Colleague's",
            createdByUserId: ctx.vars.colleagueId,
          }),
          "forbidden",
        );
        // Without email verification, the colleague's password sign-up counts as verified.
        const membership = await client.call("invitations.accept", accept);
        expect(membership).toMatchObject({
          organization: { organizationId: ctx.vars.orgId, name: "Acme Books" },
          roles: ["member"],
        });
        expect(await client.call("invitations.accept", accept)).toEqual(membership);
        await expectApiError(client.call("invitations.send", send), "conflict");
        await expectApiError(client.call("invitations.create", invite), "conflict");
        // As a member, the colleague cannot invite anyone.
        await expectApiError(
          client.call("invitations.create", {
            ...invite,
            inviterUserId: ctx.vars.colleagueId,
            email: "friend@bookkeeping.test",
          }),
          "forbidden",
        );
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
        // Joining in Backoffice makes them a member, but Bookkeeping still cannot act for them.
        await auth.acceptAccountInvitation({
          userId: ctx.vars.existingUserId,
          invitationId: forSomeoneElse.invitationId,
        });
        await expectApiError(
          client.call("projects.provision", {
            organizationId: ctx.vars.orgId,
            externalProjectId: "bk-administration-existing",
            name: "Theirs",
            createdByUserId: ctx.vars.existingUserId,
          }),
          "forbidden",
        );
        await expectApiError(
          client.call("invitations.create", {
            organizationId: ctx.vars.orgId,
            inviterUserId: ctx.vars.existingUserId,
            email: "friend@bookkeeping.test",
            roles: ["member"],
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
        await expectApiError(
          client.call("invitations.send", {
            invitationId: elsewhere.invitationId,
            url: `${branding.homeUrl}/invitations/${elsewhere.invitationId}`,
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
      "an admin invites through Bookkeeping as in Backoffice, but not owners, and only where it is installed",
      async (ctx) => {
        const client = provisioning(ctx);
        await authorizeBookkeeping(ctx, ctx.vars.existingCookie);
        const invite: CreateInvitationInput = {
          organizationId: ctx.vars.orgId,
          inviterUserId: ctx.vars.existingUserId,
          email: "friend@bookkeeping.test",
          roles: ["owner"],
        };
        await expectApiError(client.call("invitations.create", invite), "forbidden");
        expect(
          await client.call("invitations.create", { ...invite, roles: ["admin"] }),
        ).toMatchObject({ email: "friend@bookkeeping.test", roles: ["admin"] });
        // A member does not get the invitation by asking for the same one.
        await expectApiError(
          client.call("invitations.create", {
            ...invite,
            inviterUserId: ctx.vars.colleagueId,
            roles: ["admin"],
          }),
          "forbidden",
        );
        // They own the existing workspace, but Bookkeeping is not installed there.
        await expectApiError(
          client.call("invitations.create", { ...invite, organizationId: ctx.vars.existingOrgId }),
          "not_found",
        );
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
            organizationId: ctx.vars.orgId,
            externalProjectId: "bk-administration-2",
            name: "Second",
            createdByUserId: ctx.vars.ownerId,
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
        "organization.provisioned": 3,
        "project.provisioned": 3,
        "invitation.created": 3,
        "invitation.sent": 2,
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

test("a provisioned organization follows what Bookkeeping requests, within a minute of a change", async () => {
  await runFirstPartyScenario("first-party grants follow the app", (then) => [
    then("Bookkeeping's organization is provisioned with the emission it requests", async (ctx) => {
      await authorizeBookkeeping(ctx, ctx.vars.existingCookie);
      const organization = await provisioning(ctx).call("organizations.provision", {
        externalOrganizationId: "bk-org-1",
        name: "Acme Books",
        ownerUserId: ctx.vars.existingUserId,
      });
      ctx.vars.orgId = organization.organizationId;
      const bookkeeping = await callAsInstallation(ctx);
      expect(await bookkeeping.fire()).toMatchObject({ accepted: true });
      await expectApiError(bookkeeping.list(), "forbidden");
    }),
    then(
      "Bookkeeping starts requesting to read events, and reads them without anyone approving it",
      async (ctx) => {
        await execAsAdministrator(
          ctx,
          `admin.apps.update-permissions --app-id ${ctx.vars.appId} --requested-permissions-json '[{"namespace":"events","permission":"emit"},{"namespace":"events","permission":"read"}]'`,
        );
        ctx.runtime.advanceTime(61_000);
        const { events } = await (await callAsInstallation(ctx)).list();
        expect(events).toHaveLength(1);
        expect(
          await ctx.runtime.objects.appInstallations
            .for({ kind: "org", orgId: ctx.vars.orgId, jurisdiction: null })
            .commands.getInstallation({ appId: ctx.vars.appId }),
        ).toMatchObject({ grantedPermissions: [emit, BACKOFFICE_PERMISSION.events.read] });
      },
    ),
    then(
      "Bookkeeping cannot request to manage organizations, which only people do",
      async (ctx) => {
        await expect(
          ctx.runtime.objects.apps.singleton().commands.updateAppPermissions({
            appId: ctx.vars.appId,
            requestedPermissions: [
              BACKOFFICE_PERMISSION.events.read,
              BACKOFFICE_PERMISSION.org.manage,
            ],
          }),
        ).rejects.toThrow("Apps cannot hold 'org.manage'");
      },
    ),
    then("Bookkeeping stops requesting emission, and loses it", async (ctx) => {
      await execAsAdministrator(
        ctx,
        `admin.apps.update-permissions --app-id ${ctx.vars.appId} --requested-permissions-json '[{"namespace":"events","permission":"read"}]'`,
      );
      ctx.runtime.advanceTime(61_000);
      const bookkeeping = await callAsInstallation(ctx);
      await expectApiError(bookkeeping.fire(), "forbidden");
      expect((await bookkeeping.list()).events).toHaveLength(1);
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
            .for({ kind: "org", orgId: ctx.vars.existingOrgId, jurisdiction: null })
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

/** Someone signs up to Backoffice with a password; returns their session cookie and user ID. */
async function signUpWithPassword(ctx: Ctx, email: string, name: string) {
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
  return { cookie, userId: await sessionUserId(ctx, cookie) };
}

/** The signed-in member changes their own roles in the organization, as the members page does. */
async function setOwnRoles(ctx: Ctx, user: { cookie: string; userId: string }, roles: string[]) {
  const auth = ctx.runtime.objects.auth.singleton().http;
  const headers = { origin, cookie: user.cookie, "content-type": "application/json" };
  const listed = await auth.fetch(
    new Request(`${origin}/api/auth/organization/list-members?organizationId=${ctx.vars.orgId}`, {
      headers,
    }),
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const { members } = (await listed.json()) as { members: { id: string; userId: string }[] };
  const memberId = members.find((member) => member.userId === user.userId)?.id;
  const updated = await auth.fetch(
    new Request(`${origin}/api/auth/organization/update-member-role`, {
      method: "POST",
      headers,
      body: JSON.stringify({ organizationId: ctx.vars.orgId, memberId, role: roles.join(",") }),
    }),
  );
  assert.equal(updated.status, 200, await updated.clone().text());
}

test("Bookkeeping provisions an organization for an owner who never signed in, who owns it once they accept", async () => {
  await runFirstPartyScenario("first-party provisioning for an invitee", (then) => [
    then(
      "an operator who signed in to Bookkeeping has it create a firm with a pending owner invitation, and no members",
      async (ctx) => {
        const operator = await signUpWithPassword(ctx, "operator@bookkeeping.test", "Operator");
        ctx.vars.ownerCookie = operator.cookie;
        ctx.vars.ownerId = operator.userId;
        await authorizeBookkeeping(ctx, operator.cookie);

        const client = provisioning(ctx);
        const input = {
          externalOrganizationId: "bk-firm-1",
          name: "Lovelace & Co",
          ownerEmail: "Ada@Example.test",
          invitedByUserId: operator.userId,
        };
        const provisioned = await client.call("organizations.provisionForInvitee", input);
        expect(provisioned).toEqual({
          organizationId: expect.any(String),
          slug: "lovelace-co",
          jurisdiction: null,
          created: true,
          ownerInvitation: { invitationId: expect.any(String), expiresAt: expect.any(String) },
        });
        ctx.vars.orgId = provisioned.organizationId;
        // Provisioning it again returns the same pending invitation, but not to another address.
        expect(await client.call("organizations.provisionForInvitee", input)).toEqual({
          ...provisioned,
          created: false,
        });
        await expectApiError(
          client.call("organizations.provisionForInvitee", {
            ...input,
            ownerEmail: "someone@example.test",
          }),
          "conflict",
        );
        // The operator invited, but is not a member.
        expect(
          await ctx.runtime.objects.auth.singleton().commands.getScenarioMemberRoles({
            organizationId: ctx.vars.orgId,
            userId: operator.userId,
          }),
        ).toBeNull();
        expect(
          await ctx.runtime.objects.appInstallations
            .for({ kind: "org", orgId: ctx.vars.orgId, jurisdiction: null })
            .commands.getInstallation({ appId: ctx.vars.appId }),
        ).toMatchObject({
          status: "active",
          externalAccount: { id: "bk-firm-1", label: "Lovelace & Co" },
        });
        // Someone who never signed in to Bookkeeping cannot invite through it.
        await expectApiError(
          client.call("organizations.provisionForInvitee", {
            ...input,
            externalOrganizationId: "bk-firm-2",
            invitedByUserId: ctx.vars.existingUserId,
          }),
          "forbidden",
        );
        expect(
          (await listSystemEvents(ctx)).filter(
            (event) => event.eventType === "organization.provisionedForInvitee",
          ),
        ).toHaveLength(2);
      },
    ),
    then(
      "the invited owner gets the email, signs in to Bookkeeping, and accepts to own the firm",
      async (ctx) => {
        const client = provisioning(ctx);
        const { ownerInvitation } = await client.call("organizations.provisionForInvitee", {
          externalOrganizationId: "bk-firm-1",
          name: "Lovelace & Co",
          ownerEmail: "ada@example.test",
          invitedByUserId: ctx.vars.ownerId,
        });
        assert(ownerInvitation);
        const { invitationId } = ownerInvitation;
        const url = `${branding.homeUrl}/invitations/${invitationId}`;
        expect(await client.call("invitations.send", { invitationId, url })).toEqual({
          email: "ada@example.test",
        });
        expect(ctx.fakes.resend?.queueEmailCalls.at(-1)).toMatchObject({
          input: {
            to: "ada@example.test",
            subject: "Operator invited you to Lovelace & Co on Bookkeeping",
          },
        });

        // Signed in to Backoffice as the operator, Bookkeeping's sign-in for Ada asks to sign in,
        // instead of returning the operator; the operator's own sign-in still goes straight back.
        expect(
          await startAuthorization(ctx, ctx.vars.ownerCookie, { login_hint: "Ada@Example.test" }),
        ).toMatchObject({ pathname: "/backoffice/login" });
        const operatorSignIn = await startAuthorization(ctx, ctx.vars.ownerCookie, {
          login_hint: "operator@bookkeeping.test",
        });
        expect(operatorSignIn.origin + operatorSignIn.pathname).toBe(redirectUri);
        const ada = await signUpWithPassword(ctx, "ada@example.test", "Ada");
        await authorizeBookkeeping(ctx, ada.cookie);
        await ctx.runtime.objects.auth
          .singleton()
          .commands.verifyAdminUserEmail({ email: "ada@example.test" });
        expect(
          await client.call("invitations.accept", { invitationId, userId: ada.userId }),
        ).toMatchObject({
          organization: { organizationId: ctx.vars.orgId, name: "Lovelace & Co" },
          roles: ["owner"],
        });
        // An owner who is also an admin still owns it, so provisioning it again invites no one,
        // not even the operator, who would otherwise take ownership without Ada's approval.
        await setOwnRoles(ctx, ada, ["admin", "owner"]);
        expect(
          await client.call("organizations.provisionForInvitee", {
            externalOrganizationId: "bk-firm-1",
            name: "Lovelace & Co",
            ownerEmail: "operator@bookkeeping.test",
            invitedByUserId: ctx.vars.ownerId,
          }),
        ).toMatchObject({ created: false, ownerInvitation: null });
        // As its owner, Ada invites colleagues through Bookkeeping.
        expect(
          await client.call("invitations.create", {
            organizationId: ctx.vars.orgId,
            inviterUserId: ada.userId,
            email: "charles@example.test",
            roles: ["admin"],
          }),
        ).toMatchObject({ email: "charles@example.test", roles: ["admin"] });
      },
    ),
    then("an expired owner invitation is replaced when provisioned again", async (ctx) => {
      const client = provisioning(ctx);
      const input = {
        externalOrganizationId: "bk-firm-3",
        name: "Hopper Books",
        ownerEmail: "grace@example.test",
        invitedByUserId: ctx.vars.ownerId,
      };
      const first = await client.call("organizations.provisionForInvitee", input);
      // Auth reads `Date`, not the scenario's clock; invitations last 48 hours.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 49 * 60 * 60 * 1_000 });
      let second;
      try {
        // Bookkeeping's own token expired too.
        ctx.vars.token = await requestClientCredentialsToken(ctx);
        second = await provisioning(ctx).call("organizations.provisionForInvitee", input);
      } finally {
        vi.useRealTimers();
      }
      expect(second).toMatchObject({ organizationId: first.organizationId, created: false });
      expect(second.ownerInvitation?.invitationId).not.toBe(first.ownerInvitation?.invitationId);
    }),
  ]);
});
