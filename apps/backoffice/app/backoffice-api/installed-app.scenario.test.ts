import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BackofficeApiErrorCode } from "@fragno-dev/backoffice-api/errors";
import type { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import { createBackofficeApiClient } from "@fragno-dev/backoffice-api/v0/client";
import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
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
import { createInstalledAppExecution } from "@/fragno/app-installations/authority";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import { createAutomationExecutionFromActors } from "@/fragno/automation/authority";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { action as claimAction } from "@/routes/api/backoffice-app-installation-claim";
import { action as exchangeAction } from "@/routes/api/backoffice-execution-token";
import { action as installAction, loader as installLoader } from "@/routes/backoffice/app-install";
import { loader as dashboardLoader } from "@/routes/backoffice/dashboard/dashboard";
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

const wholeOrganization = { kind: "owner" } as const;

const origin = "https://backoffice.example";
const redirectUri = "https://bookkeeping.example/api/auth/oauth2/callback/backoffice";
const connectionTested = "bookkeeping.connection.tested";
const emit = BACKOFFICE_PERMISSION.events.emit;

type Vars = {
  ownerCookie: string;
  memberCookie: string;
  ownerId: string;
  memberId: string;
  orgId: string;
  memberOrgId: string;
  clientId: string;
  clientSecret: string;
  appId: string;
  oauthAccessToken: string;
  credential: string;
  eventId: string;
  financeProjectId: string;
  payrollProjectId: string;
  installCode: string;
  installationToken: string;
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

function authRequest(ctx: Ctx, pathname: string, cookie: string, body?: unknown) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function sessionUserId(ctx: Ctx, cookie: string) {
  const response = await authRequest(ctx, "/get-session", cookie);
  return z.object({ user: z.object({ id: z.string() }) }).parse(await response.json()).user.id;
}

/** Plays Bookkeeping's server: authorization code + PKCE for the Backoffice resource. */
async function authorizeBookkeeping(ctx: Ctx, cookie: string): Promise<string> {
  const codeVerifier = "b".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  ).toString("base64url");
  const query = new URLSearchParams({
    client_id: ctx.vars.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access backoffice",
    state: "bookkeeping-login",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: origin,
    prompt: "consent",
  });
  const authorization = await authRequest(ctx, `/oauth2/authorize?${query}`, cookie);
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const location = authorization.headers.get("location");
  assert(location);
  const approved = await authRequest(ctx, "/oauth2/consent", cookie, {
    accept: true,
    oauth_query: new URL(location, origin).search.slice(1),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const code = new URL(
    z.object({ url: z.string() }).parse(await approved.json()).url,
  ).searchParams.get("code");
  assert(code);
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${ctx.vars.clientId}:${ctx.vars.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        resource: origin,
      }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

type OrgScope = { kind: "org"; orgId: string };
type OwnerScope = OrgScope | { kind: "user"; userId: string };
type WorkspaceScope = { kind: "app"; owner: OwnerScope; appId: string };
type AppScope =
  | OwnerScope
  | WorkspaceScope
  | { kind: "project"; owner: OwnerScope; projectId: string };

function orgScope(orgId: string): OrgScope {
  return { kind: "org", orgId };
}

async function exchange(ctx: Ctx, oauthAccessToken: string, scope: AppScope) {
  const request = new Request(`${origin}/api/backoffice/execution-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${oauthAccessToken}` },
    body: JSON.stringify({ scope }),
  });
  return await exchangeAction({
    request,
    context: routerContext(ctx, request),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/execution-token",
  });
}

async function issueCredential(ctx: Ctx): Promise<string> {
  const response = await exchange(ctx, ctx.vars.oauthAccessToken, orgScope(ctx.vars.orgId));
  assert.equal(response.status, 200, await response.clone().text());
  return backofficeExecutionTokenResultSchema.parse(await response.json()).accessToken;
}

type EventFireInput = z.input<(typeof backofficeApiV0)["operations"]["events.fire"]["input"]>;

/** Plays Bookkeeping's server: the published client, with requests served by the API router. */
async function sendEvent(
  ctx: Ctx,
  input: { credential: string; scope?: AppScope; body?: Record<string, unknown> },
) {
  const client = createBackofficeApiClient({
    origin,
    accessToken: input.credential,
    fetch: async (url, init) =>
      await backofficeApiRouter.fetch(new Request(url, init), {
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
      }),
  });
  return await client.call(
    input.scope ?? orgScope(ctx.vars.orgId),
    "events.fire",
    // Forged bodies deliberately step outside the contract.
    (input.body ?? {
      eventType: connectionTested,
      payload: { message: "Hello from Bookkeeping" },
    }) as EventFireInput,
  );
}

/** Lists events the way Bookkeeping's server does, through the published client. */
async function listEventIds(ctx: Ctx, credential: string, scope: AppScope): Promise<string[]> {
  const client = createBackofficeApiClient({
    origin,
    accessToken: credential,
    fetch: async (url, init) =>
      await backofficeApiRouter.fetch(new Request(url, init), {
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
      }),
  });
  const { events } = await client.call(scope, "events.list", {});
  return events.map(({ id }) => id);
}

async function exchangeCredential(ctx: Ctx, token: string, scope: AppScope): Promise<string> {
  const response = await exchange(ctx, token, scope);
  assert.equal(response.status, 200, await response.clone().text());
  return backofficeExecutionTokenResultSchema.parse(await response.json()).accessToken;
}

/**
 * Loads the app workspace's dashboard for a signed-in browser, or returns the Response it threw.
 * The owner is named as in page URLs, e.g. `org:<org-slug>` or `user:<userId>`.
 */
async function openWorkspaceDashboard(ctx: Ctx, sessionCookie: string, owner: string) {
  const exchanged = await authRequest(ctx, "/backoffice-token", sessionCookie, {
    selection: "required",
    organizationId: ctx.vars.orgId,
  });
  assert(exchanged.ok, await exchanged.clone().text());
  const cookie = [
    sessionCookie,
    ...exchanged.headers.getSetCookie().map((header) => header.split(";", 1)[0]),
  ].join("; ");
  const scopeId = `${owner}:${ctx.vars.appId}`;
  const url = new URL(`/backoffice/dashboard/app/${scopeId}`, origin);
  const request = new Request(url, { headers: { cookie, origin } });
  return await behindBackofficeLayout(dashboardLoader)({
    request,
    url,
    pattern: url.pathname,
    params: { scopeKind: "app", scopeId },
    context: routerContext(ctx, request),
  }).catch((error: unknown) => {
    assert(error instanceof Response, `Expected a thrown Response, got ${String(error)}`);
    return error;
  });
}

async function expectApiError(delivery: Promise<unknown>, code: BackofficeApiErrorCode) {
  await expect(delivery).rejects.toMatchObject({ name: "BackofficeApiRequestError", code });
}

const installReturnUri = "https://bookkeeping.example/dashboard/backoffice/callback";

/** Plays Bookkeeping's server acting as itself: a client-credentials token for Backoffice. */
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

async function createProject(ctx: Ctx, name: string): Promise<string> {
  const response = await createAutomationsRouteCaller({
    object: ctx.runtime.objects.automations.forOrg(ctx.vars.orgId),
  })("POST", "/projects", { body: { name, createdByUserId: ctx.vars.ownerId } });
  assert(response.type === "json", `Project creation failed with ${response.status}`);
  return String(z.object({ id: z.unknown() }).parse(response.data).id);
}

function installUrl(ctx: Ctx, redirectUri = installReturnUri) {
  const url = new URL(`${origin}/backoffice/apps/install`);
  url.search = new URLSearchParams({
    client_id: ctx.vars.clientId,
    redirect_uri: redirectUri,
    state: "bookkeeping-link-state",
  }).toString();
  return url;
}

/** Opens the install page as a signed-in Backoffice user, the way the browser does. */
async function openInstallPage(ctx: Ctx, cookie: string, url = installUrl(ctx)) {
  const request = new Request(url, { headers: { cookie } });
  const result = await installLoader({
    request,
    context: routerContext(ctx, request),
    params: {},
    url,
    pattern: "/backoffice/apps/install",
  });
  return result.data;
}

async function submitInstallPage(ctx: Ctx, cookie: string, fields: [string, string][]) {
  const url = installUrl(ctx);
  const request = new Request(url, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return await installAction({
    request,
    context: routerContext(ctx, request),
    params: {},
    url,
    pattern: "/backoffice/apps/install",
  });
}

async function claim(ctx: Ctx, bearer: string, body: unknown) {
  const request = new Request(`${origin}/api/backoffice/app-installations/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return await claimAction({
    request,
    context: routerContext(ctx, request),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/app-installations/claim",
  });
}

/** Inspects events the way an organization member does, through the authorized Bash tools. */
async function getEventAsOwner(ctx: Ctx, eventId: string): Promise<unknown> {
  const ownerContext = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({
      scope: { kind: "org", orgId: ctx.vars.orgId },
      userId: ctx.vars.ownerId,
    }),
    billingOrganizationId: null,
  });
  assert(ownerContext.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...ownerContext, stateBackend: ownerContext.stateBackend },
  });
  const listed = await bash.exec("events.list --format json");
  assert.equal(listed.exitCode, 0, listed.stderr);
  const appEvents = automationEventListResultSchema
    .parse(JSON.parse(listed.stdout))
    .events.filter(({ source }) => source === `app:${ctx.vars.appId}`);
  expect(appEvents.map(({ id }) => id)).toEqual([eventId]);
  const shown = await bash.exec(`events.get --id ${eventId} --format json`);
  assert.equal(shown.exitCode, 0, shown.stderr);
  return JSON.parse(shown.stdout);
}

async function expectDenied(response: Response, status: number, error: string) {
  assert.equal(response.status, status, await response.clone().text());
  expect(await response.json()).toMatchObject({ error });
}

async function updateGrants(ctx: Ctx, grantedPermissions: BackofficePermissionRequirement[]) {
  const updated = await ctx.runtime.objects.appInstallations
    .forOrg(ctx.vars.orgId)
    .commands.updateInstallationAccess({
      appId: ctx.vars.appId,
      grantedPermissions,
      resourceScope: wholeOrganization,
    });
  assert(updated.ok);
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
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...context, stateBackend: context.stateBackend },
  });
  const result = await bash.exec(command);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

async function runInstalledAppScenario(
  name: string,
  steps: (
    then: (label: string, assertion: (ctx: Ctx) => Promise<void>) => BackofficeScenarioStep,
  ) => BackofficeScenarioStep[],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-installed-app-events-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario<Vars>({
        name,
        objects: scenarioObjects,
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
        vars: () => ({
          ownerCookie: "",
          memberCookie: "",
          ownerId: "",
          memberId: "",
          orgId: "",
          memberOrgId: "",
          clientId: "",
          clientSecret: "",
          appId: "",
          oauthAccessToken: "",
          credential: "",
          eventId: "",
          financeProjectId: "",
          payrollProjectId: "",
          installCode: "",
          installationToken: "",
        }),
        setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "owner@bookkeeping.test",
            captureSessionCookieAs: "ownerCookie",
          }),
          when.auth.signUp({
            email: "member@bookkeeping.test",
            captureSessionCookieAs: "memberCookie",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.ownerCookie,
            name: "Owner Workspace",
            slug: "owner-workspace",
            captureOrganizationIdAs: "orgId",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.memberCookie,
            name: "Member Workspace",
            slug: "member-workspace",
            captureOrganizationIdAs: "memberOrgId",
          }),
          then.assert(
            "an administrator provisions Bookkeeping, and the owner approves only event emission",
            async (ctx) => {
              const auth = ctx.runtime.objects.auth.singleton().commands;
              ctx.vars.ownerId = await sessionUserId(ctx, ctx.vars.ownerCookie);
              ctx.vars.memberId = await sessionUserId(ctx, ctx.vars.memberCookie);
              await auth.applyScenarioFixture({
                members: [
                  { organizationId: ctx.vars.orgId, userId: ctx.vars.memberId, roles: ["member"] },
                ],
              });

              const client = await auth.createAdminOAuthClient({
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
                actions: { kind: "none" },
                trust: { kind: "third-party" },
                slug: "accounting",
                oauthClientId: client.clientId,
                requestedPermissions: [emit, BACKOFFICE_PERMISSION.events.read],
              });
              assert(registered.ok);
              ctx.vars.appId = registered.value.appId;
              const installed = await ctx.runtime.objects.appInstallations
                .forOrg(ctx.vars.orgId)
                .commands.installApp({
                  actionsRevision: 1,
                  appId: ctx.vars.appId,
                  grantedPermissions: [emit],
                  installedByUserId: ctx.vars.ownerId,
                  resourceScope: wholeOrganization,
                });
              assert(installed.ok);
            },
          ),
          then.assert(
            "the member authorizes Bookkeeping without losing identity claims, and Bookkeeping obtains an app credential",
            async (ctx) => {
              ctx.vars.oauthAccessToken = await authorizeBookkeeping(ctx, ctx.vars.memberCookie);
              const userinfo = await ctx.runtime.objects.auth.singleton().http.fetch(
                new Request(`${origin}/api/auth/oauth2/userinfo`, {
                  headers: { authorization: `Bearer ${ctx.vars.oauthAccessToken}` },
                }),
              );
              assert.equal(userinfo.status, 200, await userinfo.clone().text());
              expect(await userinfo.json()).toMatchObject({
                sub: ctx.vars.memberId,
                email: "member@bookkeeping.test",
              });
              ctx.vars.credential = await issueCredential(ctx);
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

describe("installed-app event delivery SQLite scenarios", () => {
  test("Bookkeeping sends an event on behalf of a member, and an organization member inspects it", async () => {
    await runInstalledAppScenario("Bookkeeping delivers a connection test event", (then) => [
      then("Backoffice durably accepts the event and returns a receipt", async (ctx) => {
        const receipt = await sendEvent(ctx, { credential: ctx.vars.credential });
        expect(receipt).toMatchObject({
          accepted: true,
          scope: { kind: "org", orgId: ctx.vars.orgId },
          source: `app:${ctx.vars.appId}`,
          eventType: connectionTested,
        });
        ctx.vars.eventId = receipt.eventId;
      }),
      then(
        "the owner sees exactly one event with the member as principal and the app as a restricting delegate",
        async (ctx) => {
          const scope = { kind: "org" as const, orgId: ctx.vars.orgId };
          expect(await getEventAsOwner(ctx, ctx.vars.eventId)).toMatchObject({
            id: ctx.vars.eventId,
            scope,
            eventType: connectionTested,
            payload: { message: "Hello from Bookkeeping" },
            actors: {
              initiator: { scope: "internal", type: "app", id: ctx.vars.appId },
              principal: { scope: "internal", type: "user", id: ctx.vars.memberId },
              delegation: [
                {
                  scope: "internal",
                  type: "app-installation",
                  id: `${ctx.vars.appId}:1`,
                  role: "delegate",
                },
              ],
            },
          });
        },
      ),
      then(
        "work resumed from the stored event keeps the app restriction and loses it on uninstall",
        async (ctx) => {
          const kernel = new BackofficeKernel(ctx.runtime.services);
          const scope = { kind: "org" as const, orgId: ctx.vars.orgId };
          const stored = z
            .object({ actors: z.unknown() })
            .parse(await getEventAsOwner(ctx, ctx.vars.eventId));
          const resumed = createAutomationExecutionFromActors({
            scope,
            scopeRestriction: scope,
            actors: stored.actors,
          });
          await kernel.assertAuthorized({ execution: resumed, operation: emit });
          await expect(
            kernel.assertAuthorized({
              execution: resumed,
              operation: BACKOFFICE_PERMISSION.events.read,
            }),
          ).rejects.toMatchObject({ reason: "actor-capability-denied" });
          const uninstalled = await ctx.runtime.objects.appInstallations
            .forOrg(ctx.vars.orgId)
            .commands.uninstallApp({ appId: ctx.vars.appId });
          assert(uninstalled.ok);
          await expect(
            kernel.assertAuthorized({ execution: resumed, operation: emit }),
          ).rejects.toMatchObject({ reason: "actor-capability-denied" });
        },
      ),
    ]);
  });

  test("forged fields, other organizations, raw OAuth tokens, and human-only authority are rejected", async () => {
    await runInstalledAppScenario(
      "installed-app credentials stay inside their approval",
      (then) => [
        then("request bodies cannot choose identity, source, or target scope", async (ctx) => {
          for (const forged of [
            { actors: { principal: { scope: "internal", type: "user", id: ctx.vars.ownerId } } },
            { scope: { kind: "org", orgId: ctx.vars.memberOrgId } },
            { userId: ctx.vars.ownerId },
          ]) {
            await expectApiError(
              sendEvent(ctx, {
                credential: ctx.vars.credential,
                body: { eventType: connectionTested, payload: {}, ...forged },
              }),
              "invalid_request",
            );
          }
          for (const forged of [
            { source: "github" },
            { targetScope: orgScope(ctx.vars.memberOrgId) },
          ]) {
            await expectApiError(
              sendEvent(ctx, {
                credential: ctx.vars.credential,
                body: { eventType: connectionTested, payload: {}, ...forged },
              }),
              "forbidden",
            );
          }
          expect(
            await sendEvent(ctx, {
              credential: ctx.vars.credential,
              body: { eventType: connectionTested, payload: {}, source: `app:${ctx.vars.appId}` },
            }),
          ).toMatchObject({ source: `app:${ctx.vars.appId}` });
        }),
        then(
          "a credential stays bound to its organization, even where the app is also installed",
          async (ctx) => {
            await expectDenied(
              await exchange(ctx, ctx.vars.oauthAccessToken, orgScope(ctx.vars.memberOrgId)),
              403,
              "scope_unavailable",
            );
            const installed = await ctx.runtime.objects.appInstallations
              .forOrg(ctx.vars.memberOrgId)
              .commands.installApp({
                actionsRevision: 1,
                appId: ctx.vars.appId,
                grantedPermissions: [emit],
                installedByUserId: ctx.vars.memberId,
                resourceScope: wholeOrganization,
              });
            assert(installed.ok);
            await expectApiError(
              sendEvent(ctx, {
                credential: ctx.vars.credential,
                scope: orgScope(ctx.vars.memberOrgId),
              }),
              "forbidden",
            );
            const exchanged = await exchange(
              ctx,
              ctx.vars.oauthAccessToken,
              orgScope(ctx.vars.memberOrgId),
            );
            assert.equal(exchanged.status, 200, await exchanged.clone().text());
            const otherOrganizationCredential = backofficeExecutionTokenResultSchema.parse(
              await exchanged.json(),
            ).accessToken;
            expect(
              await sendEvent(ctx, {
                credential: otherOrganizationCredential,
                scope: orgScope(ctx.vars.memberOrgId),
              }),
            ).toMatchObject({ scope: orgScope(ctx.vars.memberOrgId) });
          },
        ),
        then("raw OAuth access tokens cannot call the API", async (ctx) => {
          await expectApiError(
            sendEvent(ctx, { credential: ctx.vars.oauthAccessToken }),
            "authentication_failed",
          );
        }),
        then(
          "app delegation cannot exercise unapproved or installation-management authority, even for the owner",
          async (ctx) => {
            const kernel = new BackofficeKernel(ctx.runtime.services);
            const owner = createInstalledAppExecution({
              scope: orgScope(ctx.vars.orgId),
              actor: { kind: "user", userId: ctx.vars.ownerId },
              installation: { appId: ctx.vars.appId, activation: 1, externalAccount: null },
            });
            await kernel.assertAuthorized({ execution: owner, operation: emit });
            for (const operation of [
              BACKOFFICE_PERMISSION.events.read,
              BACKOFFICE_PERMISSION.apps.read,
              BACKOFFICE_PERMISSION.apps.manage,
            ]) {
              await expect(
                kernel.assertAuthorized({ execution: owner, operation }),
              ).rejects.toMatchObject({ reason: "actor-capability-denied" });
            }
          },
        ),
      ],
    );
  });

  test("grant changes, membership removal, consent revocation, and reinstallation govern issued credentials", async () => {
    await runInstalledAppScenario("installed-app credentials follow live authority", (then) => [
      then(
        "removing the emit grant stops an issued credential until it is restored",
        async (ctx) => {
          await updateGrants(ctx, []);
          await expectApiError(sendEvent(ctx, { credential: ctx.vars.credential }), "forbidden");
          await updateGrants(ctx, [emit]);
          expect(await sendEvent(ctx, { credential: ctx.vars.credential })).toMatchObject({
            accepted: true,
          });
        },
      ),
      then("removing the member stops delivery and new exchanges", async (ctx) => {
        const auth = ctx.runtime.objects.auth.singleton().commands;
        await auth.applyScenarioFixture({
          removedMembers: [{ organizationId: ctx.vars.orgId, userId: ctx.vars.memberId }],
        });
        await expectApiError(sendEvent(ctx, { credential: ctx.vars.credential }), "forbidden");
        await expectDenied(
          await exchange(ctx, ctx.vars.oauthAccessToken, orgScope(ctx.vars.orgId)),
          403,
          "scope_unavailable",
        );
        await auth.applyScenarioFixture({
          members: [
            { organizationId: ctx.vars.orgId, userId: ctx.vars.memberId, roles: ["member"] },
          ],
        });
        expect(await sendEvent(ctx, { credential: ctx.vars.credential })).toMatchObject({
          accepted: true,
        });
      }),
      then(
        "uninstalling revokes credentials, and reinstalling does not revive them",
        async (ctx) => {
          const installations = ctx.runtime.objects.appInstallations.forOrg(
            ctx.vars.orgId,
          ).commands;
          assert((await installations.uninstallApp({ appId: ctx.vars.appId })).ok);
          await expectApiError(sendEvent(ctx, { credential: ctx.vars.credential }), "forbidden");
          await expectDenied(
            await exchange(ctx, ctx.vars.oauthAccessToken, orgScope(ctx.vars.orgId)),
            403,
            "scope_unavailable",
          );
          const reinstalled = await installations.installApp({
            actionsRevision: 1,
            appId: ctx.vars.appId,
            grantedPermissions: [emit],
            installedByUserId: ctx.vars.ownerId,
            resourceScope: wholeOrganization,
          });
          assert(reinstalled.ok);
          expect(await installations.getInstallation({ appId: ctx.vars.appId })).toMatchObject({
            status: "active",
            activation: 2,
          });
          await expectApiError(sendEvent(ctx, { credential: ctx.vars.credential }), "forbidden");
          expect(await sendEvent(ctx, { credential: await issueCredential(ctx) })).toMatchObject({
            accepted: true,
          });
        },
      ),
      then("revoking OAuth consent prevents further credential exchanges", async (ctx) => {
        const consents = await authRequest(ctx, "/oauth2/get-consents", ctx.vars.memberCookie);
        assert(consents.ok, await consents.clone().text());
        const consent = z
          .array(z.object({ id: z.string(), clientId: z.string() }))
          .parse(await consents.json())
          .find(({ clientId }) => clientId === ctx.vars.clientId);
        assert(consent);
        const deleted = await authRequest(ctx, "/oauth2/delete-consent", ctx.vars.memberCookie, {
          id: consent.id,
        });
        assert(deleted.ok, await deleted.clone().text());
        await expectDenied(
          await exchange(ctx, ctx.vars.oauthAccessToken, orgScope(ctx.vars.orgId)),
          401,
          "authentication_failed",
        );
      }),
    ]);
  });
  test("an administrator changes what Bookkeeping requests, and installations keep what their owner granted", async () => {
    await runInstalledAppScenario("requested permissions change in place", (then) => [
      then(
        "Bookkeeping stops requesting emission, and the owner's emission grant stays until they change access",
        async (ctx) => {
          const update = `admin.apps.update-permissions --app-id ${ctx.vars.appId} --requested-permissions-json '[{"namespace":"events","permission":"read"}]'`;
          assert.equal(await execAsAdministrator(ctx, update), "Updated app permissions.\n");
          assert.equal(await execAsAdministrator(ctx, update), "App permissions unchanged.\n");
          expect(
            await ctx.runtime.objects.apps.singleton().commands.getApp({ appId: ctx.vars.appId }),
          ).toMatchObject({ requestedPermissions: [BACKOFFICE_PERMISSION.events.read] });

          expect(await sendEvent(ctx, { credential: ctx.vars.credential })).toMatchObject({
            accepted: true,
          });
          const installations = ctx.runtime.objects.appInstallations.forOrg(
            ctx.vars.orgId,
          ).commands;
          expect(
            await installations.updateInstallationAccess({
              appId: ctx.vars.appId,
              grantedPermissions: [emit],
              resourceScope: wholeOrganization,
            }),
          ).toMatchObject({ ok: false, error: { code: "APP_GRANTS_NOT_REQUESTED" } });
        },
      ),
      then("reading events applies once the owner grants it, which drops emission", async (ctx) => {
        const scope = orgScope(ctx.vars.orgId);
        await expectApiError(listEventIds(ctx, ctx.vars.credential, scope), "forbidden");
        await updateGrants(ctx, [BACKOFFICE_PERMISSION.events.read]);
        expect(await listEventIds(ctx, ctx.vars.credential, scope)).toHaveLength(1);
        await expectApiError(sendEvent(ctx, { credential: ctx.vars.credential }), "forbidden");
      }),
    ]);
  });
  test("an owner installs Bookkeeping for one project, and Bookkeeping links and acts as its installation there", async () => {
    await runInstalledAppScenario(
      "Bookkeeping is installed, linked, and acts as itself",
      (then) => [
        then(
          "only organizations the user administers and their personal scope are offered, and foreign return addresses are refused",
          async (ctx) => {
            const installations = ctx.runtime.objects.appInstallations.forOrg(
              ctx.vars.orgId,
            ).commands;
            assert((await installations.uninstallApp({ appId: ctx.vars.appId })).ok);
            ctx.vars.financeProjectId = await createProject(ctx, "Finance");
            ctx.vars.payrollProjectId = await createProject(ctx, "Payroll");

            const ownerPage = await openInstallPage(ctx, ctx.vars.ownerCookie);
            expect(ownerPage).toMatchObject({
              clientName: "Bookkeeping",
              requestedPermissions: [
                {
                  permission: "events.emit",
                  operations: [
                    "Fire an automation event for the current context or a selected target scope.",
                  ],
                },
                {
                  permission: "events.read",
                  operations: expect.arrayContaining([
                    "List stored automation events in the current scope, newest first.",
                  ]),
                },
              ],
              returnOrigin: "https://bookkeeping.example",
              owners: [
                { value: `org:${ctx.vars.orgId}`, label: expect.any(String) },
                { value: `user:${ctx.vars.ownerId}`, label: "Personal" },
              ],
              selectedOwner: { value: `org:${ctx.vars.orgId}`, kind: "org" },
              installation: null,
            });
            expect(ownerPage.projects.map(({ name }) => name).sort()).toEqual([
              "Finance",
              "Payroll",
            ]);
            // The member administers only the organization created for them.
            const memberPage = await openInstallPage(ctx, ctx.vars.memberCookie);
            expect(memberPage.owners).toEqual([
              { value: `org:${ctx.vars.memberOrgId}`, label: expect.any(String) },
              { value: `user:${ctx.vars.memberId}`, label: "Personal" },
            ]);
            await expect(
              openInstallPage(
                ctx,
                ctx.vars.ownerCookie,
                installUrl(ctx, "https://evil.example/cb"),
              ),
            ).rejects.toMatchObject({ status: 400 });

            const forbidden = await submitInstallPage(ctx, ctx.vars.memberCookie, [
              ["intent", "install"],
              ["actionsRevision", "1"],
              ["owner", `org:${ctx.vars.orgId}`],
              ["permission", "events.emit"],
              ["resources", "owner"],
            ]);
            expect(forbidden).toMatchObject({
              data: { message: "Choose where to install and the access to approve." },
            });
            expect(await installations.getInstallation({ appId: ctx.vars.appId })).toMatchObject({
              status: "uninstalled",
            });
            const cancelled = await submitInstallPage(ctx, ctx.vars.ownerCookie, [
              ["intent", "cancel"],
            ]);
            assert(cancelled instanceof Response);
            const cancelledLocation = new URL(cancelled.headers.get("location") ?? "");
            expect(Object.fromEntries(cancelledLocation.searchParams)).toEqual({
              error: "access_denied",
              state: "bookkeeping-link-state",
            });
          },
        ),
        then(
          "the owner approves event emission for the Finance project and returns to Bookkeeping with a code",
          async (ctx) => {
            const approved = await submitInstallPage(ctx, ctx.vars.ownerCookie, [
              ["intent", "install"],
              ["actionsRevision", "1"],
              ["owner", `org:${ctx.vars.orgId}`],
              ["permission", "events.emit"],
              ["resources", "projects"],
              ["projectId", ctx.vars.financeProjectId],
            ]);
            assert(approved instanceof Response, JSON.stringify(approved));
            const location = new URL(approved.headers.get("location") ?? "");
            assert.equal(`${location.origin}${location.pathname}`, installReturnUri);
            assert.equal(location.searchParams.get("state"), "bookkeeping-link-state");
            ctx.vars.installCode = location.searchParams.get("code") ?? "";
            expect(
              await ctx.runtime.objects.appInstallations
                .forOrg(ctx.vars.orgId)
                .commands.getInstallation({ appId: ctx.vars.appId }),
            ).toMatchObject({
              status: "active",
              activation: 2,
              grantedPermissions: [emit],
              resourceScope: { kind: "projects", projectIds: [ctx.vars.financeProjectId] },
              externalAccount: null,
            });
          },
        ),
        then(
          "only Bookkeeping's server, holding both the code and its client credentials, can link its organization",
          async (ctx) => {
            ctx.vars.installationToken = await requestClientCredentialsToken(ctx);
            const acme = { id: "bookkeeping-org-acme", label: "Acme Books" };
            await expectDenied(
              await claim(ctx, ctx.vars.oauthAccessToken, {
                code: ctx.vars.installCode,
                externalAccount: acme,
              }),
              401,
              "authentication_failed",
            );
            await expectDenied(
              await claim(ctx, ctx.vars.installationToken, {
                code: `${ctx.vars.installCode.slice(0, -3)}bad`,
                externalAccount: acme,
              }),
              400,
              "invalid_code",
            );
            const claimed = await claim(ctx, ctx.vars.installationToken, {
              code: ctx.vars.installCode,
              externalAccount: acme,
            });
            assert.equal(claimed.status, 200, await claimed.clone().text());
            expect(await claimed.json()).toEqual({
              id: expect.any(String),
              appId: ctx.vars.appId,
              owner: orgScope(ctx.vars.orgId),
              grantedPermissions: [emit],
              resourceScope: { kind: "projects", projectIds: [ctx.vars.financeProjectId] },
              externalAccount: acme,
              activation: 2,
            });
            const relabelled = await claim(ctx, ctx.vars.installationToken, {
              code: ctx.vars.installCode,
              externalAccount: { ...acme, label: "Acme Bookkeeping" },
            });
            assert.equal(relabelled.status, 200);
            await expectDenied(
              await claim(ctx, ctx.vars.installationToken, {
                code: ctx.vars.installCode,
                externalAccount: { id: "bookkeeping-org-other", label: "Other Books" },
              }),
              409,
              "app_installation_already_claimed",
            );
          },
        ),
        then(
          "the installation acts as itself only inside the approved project, attributed to the linked account",
          async (ctx) => {
            const finance = {
              kind: "project" as const,
              owner: { kind: "org" as const, orgId: ctx.vars.orgId },
              projectId: ctx.vars.financeProjectId,
            };
            for (const outside of [
              orgScope(ctx.vars.orgId),
              { ...finance, projectId: ctx.vars.payrollProjectId },
              orgScope(ctx.vars.memberOrgId),
            ]) {
              await expectDenied(
                await exchange(ctx, ctx.vars.installationToken, outside),
                403,
                "scope_unavailable",
              );
            }
            const exchanged = await exchange(ctx, ctx.vars.installationToken, finance);
            assert.equal(exchanged.status, 200, await exchanged.clone().text());
            const installationCredential = backofficeExecutionTokenResultSchema.parse(
              await exchanged.json(),
            ).accessToken;
            await expectApiError(
              sendEvent(ctx, { credential: installationCredential }),
              "forbidden",
            );
            expect(
              await sendEvent(ctx, { credential: installationCredential, scope: finance }),
            ).toMatchObject({
              scope: finance,
              source: `app:${ctx.vars.appId}`,
            });

            const kernel = new BackofficeKernel(ctx.runtime.services);
            const asInstallation = createInstalledAppExecution({
              scope: finance,
              actor: { kind: "installation" },
              installation: {
                appId: ctx.vars.appId,
                activation: 2,
                externalAccount: { id: "bookkeeping-org-acme", label: "Acme Bookkeeping" },
              },
            });
            expect(asInstallation.actors).toEqual({
              initiator: {
                scope: "external",
                source: `app:${ctx.vars.appId}`,
                type: "account",
                id: "bookkeeping-org-acme",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "app-installation",
                id: `${ctx.vars.appId}:2`,
                role: "principal",
              },
              delegation: [],
            });
            await kernel.assertAuthorized({ execution: asInstallation, operation: emit });
            await expect(
              kernel.assertAuthorized({
                execution: asInstallation,
                operation: BACKOFFICE_PERMISSION.events.read,
              }),
            ).rejects.toMatchObject({ reason: "principal-permission-denied" });

            // Members acting through Bookkeeping are held to the same project.
            await expectDenied(
              await exchange(ctx, ctx.vars.oauthAccessToken, orgScope(ctx.vars.orgId)),
              403,
              "scope_unavailable",
            );
            const memberExchange = await exchange(ctx, ctx.vars.oauthAccessToken, finance);
            assert.equal(memberExchange.status, 200, await memberExchange.clone().text());

            // Narrowing access applies to credentials that were already issued.
            const narrowed = await ctx.runtime.objects.appInstallations
              .forOrg(ctx.vars.orgId)
              .commands.updateInstallationAccess({
                appId: ctx.vars.appId,
                grantedPermissions: [emit],
                resourceScope: { kind: "projects", projectIds: [ctx.vars.payrollProjectId] },
              });
            assert(narrowed.ok);
            await expectApiError(
              sendEvent(ctx, { credential: installationCredential, scope: finance }),
              "forbidden",
            );
          },
        ),
        then(
          "uninstalling clears the link and revokes the installation's credentials",
          async (ctx) => {
            const installations = ctx.runtime.objects.appInstallations.forOrg(
              ctx.vars.orgId,
            ).commands;
            assert((await installations.uninstallApp({ appId: ctx.vars.appId })).ok);
            expect(await installations.getInstallation({ appId: ctx.vars.appId })).toMatchObject({
              status: "uninstalled",
              externalAccount: null,
            });
            await expectDenied(
              await exchange(ctx, ctx.vars.installationToken, {
                kind: "project",
                owner: { kind: "org" as const, orgId: ctx.vars.orgId },
                projectId: ctx.vars.financeProjectId,
              }),
              403,
              "scope_unavailable",
            );
            await expectDenied(
              await claim(ctx, ctx.vars.installationToken, {
                code: ctx.vars.installCode,
                externalAccount: { id: "bookkeeping-org-acme", label: "Acme Books" },
              }),
              409,
              "app_installation_inactive",
            );
          },
        ),
      ],
    );
  });

  test("Bookkeeping keeps its own data in its workspace, which the organization can read but not change", async () => {
    await runInstalledAppScenario("Bookkeeping keeps data in its workspace", (then) => [
      then(
        "Bookkeeping, acting as its installation, records events in its workspace",
        async (ctx) => {
          await updateGrants(ctx, [emit, BACKOFFICE_PERMISSION.events.read]);
          ctx.vars.installationToken = await requestClientCredentialsToken(ctx);
          const workspace = {
            kind: "app",
            owner: orgScope(ctx.vars.orgId),
            appId: ctx.vars.appId,
          } as const;
          const credential = await exchangeCredential(ctx, ctx.vars.installationToken, workspace);
          const fired = await sendEvent(ctx, { credential, scope: workspace });
          ctx.vars.eventId = fired.eventId;
          expect(await listEventIds(ctx, credential, workspace)).toEqual([fired.eventId]);
          // A workspace is private: the organization's routes never see its events.
          const orgCredential = await exchangeCredential(
            ctx,
            ctx.vars.installationToken,
            orgScope(ctx.vars.orgId),
          );
          expect(await listEventIds(ctx, orgCredential, orgScope(ctx.vars.orgId))).not.toContain(
            fired.eventId,
          );
        },
      ),
      then("an organization credential does not reach into the workspace", async (ctx) => {
        const workspace = {
          kind: "app",
          owner: orgScope(ctx.vars.orgId),
          appId: ctx.vars.appId,
        } as const;
        const orgCredential = await exchangeCredential(
          ctx,
          ctx.vars.installationToken,
          orgScope(ctx.vars.orgId),
        );
        await expectApiError(listEventIds(ctx, orgCredential, workspace), "forbidden");
        await expectDenied(
          await exchange(ctx, ctx.vars.installationToken, { ...workspace, appId: "another-app" }),
          403,
          "scope_unavailable",
        );
      }),
      then(
        "a member acting through Bookkeeping reads the workspace but cannot write",
        async (ctx) => {
          const workspace = {
            kind: "app",
            owner: orgScope(ctx.vars.orgId),
            appId: ctx.vars.appId,
          } as const;
          const memberCredential = await exchangeCredential(
            ctx,
            ctx.vars.oauthAccessToken,
            workspace,
          );
          expect(await listEventIds(ctx, memberCredential, workspace)).toEqual([ctx.vars.eventId]);
          await expectApiError(
            sendEvent(ctx, { credential: memberCredential, scope: workspace }),
            "forbidden",
          );
        },
      ),
      then(
        "the workspace opens while Bookkeeping is installed, and closes on uninstall",
        async (ctx) => {
          const organization = (
            await ctx.runtime.objects.auth.singleton().commands.getAllOrganizations()
          ).find(({ id }) => id === ctx.vars.orgId);
          assert(organization);
          expect(
            await openWorkspaceDashboard(ctx, ctx.vars.ownerCookie, `org:${organization.slug}`),
          ).toMatchObject({
            selectedScope: {
              kind: "app",
              owner: { kind: "org", organization: { id: ctx.vars.orgId } },
              appId: ctx.vars.appId,
            },
            agents: { agents: [], agentsError: null },
          });

          const installations = ctx.runtime.objects.appInstallations.forOrg(
            ctx.vars.orgId,
          ).commands;
          assert((await installations.uninstallApp({ appId: ctx.vars.appId })).ok);
          const closed = await openWorkspaceDashboard(
            ctx,
            ctx.vars.ownerCookie,
            `org:${organization.slug}`,
          );
          assert(closed instanceof Response);
          assert(closed.status === 404);
          await expectDenied(
            await exchange(ctx, ctx.vars.installationToken, {
              kind: "app",
              owner: orgScope(ctx.vars.orgId),
              appId: ctx.vars.appId,
            }),
            403,
            "scope_unavailable",
          );
        },
      ),
    ]);
  });
  test("a member installs Bookkeeping for themselves, and only they and Bookkeeping reach their personal scope", async () => {
    await runInstalledAppScenario("Bookkeeping is installed in a personal scope", (then) => [
      then(
        "the member installs Bookkeeping in their personal scope, which nobody else can choose for them",
        async (ctx) => {
          const personal = { kind: "user", userId: ctx.vars.memberId } as const;
          const url = installUrl(ctx);
          url.searchParams.set("owner", `user:${ctx.vars.memberId}`);
          expect(await openInstallPage(ctx, ctx.vars.memberCookie, url)).toMatchObject({
            selectedOwner: { value: `user:${ctx.vars.memberId}`, kind: "user" },
            projects: [],
            installation: null,
          });
          const forOther = await submitInstallPage(ctx, ctx.vars.ownerCookie, [
            ["intent", "install"],
            ["actionsRevision", "1"],
            ["owner", `user:${ctx.vars.memberId}`],
            ["permission", "events.emit"],
            ["resources", "owner"],
          ]);
          expect(forOther).toMatchObject({
            data: { message: "Choose where to install and the access to approve." },
          });

          const approved = await submitInstallPage(ctx, ctx.vars.memberCookie, [
            ["intent", "install"],
            ["actionsRevision", "1"],
            ["owner", `user:${ctx.vars.memberId}`],
            ["permission", "events.emit"],
            ["permission", "events.read"],
            ["resources", "owner"],
          ]);
          assert(approved instanceof Response, JSON.stringify(approved));
          ctx.vars.installCode =
            new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
          expect(
            await ctx.runtime.objects.appInstallations
              .for(personal)
              .commands.getInstallation({ appId: ctx.vars.appId }),
          ).toMatchObject({
            owner: personal,
            installedByUserId: ctx.vars.memberId,
            status: "active",
            resourceScope: { kind: "owner" },
          });

          ctx.vars.installationToken = await requestClientCredentialsToken(ctx);
          const claimed = await claim(ctx, ctx.vars.installationToken, {
            code: ctx.vars.installCode,
            externalAccount: { id: "bookkeeping-org-solo", label: "Solo Books" },
          });
          assert.equal(claimed.status, 200, await claimed.clone().text());
          expect(await claimed.json()).toMatchObject({ owner: personal });
        },
      ),
      then(
        "Bookkeeping acts in the personal scope and its workspace there, as itself or for the member only",
        async (ctx) => {
          const personal = { kind: "user", userId: ctx.vars.memberId } as const;
          const workspace = { kind: "app", owner: personal, appId: ctx.vars.appId } as const;
          const asInstallation = await exchangeCredential(
            ctx,
            ctx.vars.installationToken,
            personal,
          );
          const { eventId } = await sendEvent(ctx, {
            credential: asInstallation,
            scope: personal,
          });
          expect(await listEventIds(ctx, asInstallation, personal)).toEqual([eventId]);
          await sendEvent(ctx, {
            credential: await exchangeCredential(ctx, ctx.vars.installationToken, workspace),
            scope: workspace,
          });
          await sendEvent(ctx, {
            credential: await exchangeCredential(ctx, ctx.vars.oauthAccessToken, personal),
            scope: personal,
          });

          // The organization's installation does not reach its members' personal scopes, and
          // nobody else can authorize Bookkeeping in the member's.
          await expectDenied(
            await exchange(ctx, ctx.vars.installationToken, {
              kind: "user",
              userId: ctx.vars.ownerId,
            }),
            403,
            "scope_unavailable",
          );
          const ownerToken = await authorizeBookkeeping(ctx, ctx.vars.ownerCookie);
          for (const scope of [personal, workspace]) {
            await expectDenied(await exchange(ctx, ownerToken, scope), 403, "scope_unavailable");
          }
        },
      ),
      then(
        "only the member opens the workspace and manages the installation, and uninstalling closes both",
        async (ctx) => {
          const personal = { kind: "user", userId: ctx.vars.memberId } as const;
          expect(
            await openWorkspaceDashboard(ctx, ctx.vars.memberCookie, `user:${ctx.vars.memberId}`),
          ).toMatchObject({
            selectedScope: { kind: "app", owner: personal, appId: ctx.vars.appId },
          });
          const hidden = await openWorkspaceDashboard(
            ctx,
            ctx.vars.ownerCookie,
            `user:${ctx.vars.memberId}`,
          );
          assert(hidden instanceof Response);
          assert.equal(hidden.status, 404);

          const manage = async (userId: string, command: string) => {
            const context = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeUserExecution({ scope: personal, userId }),
              billingOrganizationId: null,
            });
            assert(context.stateBackend);
            const { bash } = await createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            return await bash.exec(command);
          };
          const uninstall = `apps.uninstall --app-id ${ctx.vars.appId}`;
          expect((await manage(ctx.vars.ownerId, uninstall)).exitCode).not.toBe(0);
          const uninstalled = await manage(ctx.vars.memberId, uninstall);
          assert.equal(uninstalled.exitCode, 0, uninstalled.stderr);

          await expectDenied(
            await exchange(ctx, ctx.vars.installationToken, personal),
            403,
            "scope_unavailable",
          );
          const closed = await openWorkspaceDashboard(
            ctx,
            ctx.vars.memberCookie,
            `user:${ctx.vars.memberId}`,
          );
          assert(closed instanceof Response);
          assert.equal(closed.status, 404);
        },
      ),
    ]);
  });
});
