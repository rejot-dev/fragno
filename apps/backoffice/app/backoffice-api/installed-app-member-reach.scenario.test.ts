import { assert, describe, expect, test } from "vitest";

import { createBackofficeApiClient } from "@fragno-dev/backoffice-api/v0/client";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createInstalledAppExecution } from "@/fragno/app-installations/authority";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { action as exchangeAction } from "@/routes/api/backoffice-execution-token";
import {
  action as memberReachAction,
  loader as memberReachLoader,
} from "@/routes/backoffice/app-member-reach";
import { loader as authorizedApplicationsLoader } from "@/routes/backoffice/authorized-applications";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../workers/api-object";
import { AppInstallationsObject } from "../../workers/app-installations-object";
import { AppsObject } from "../../workers/apps-object";
import { AuthObject } from "../../workers/auth-object";
import { AutomationsObject } from "../../workers/automations-object";
import { BillingObject } from "../../workers/billing-object";
import { CodemodeObject } from "../../workers/codemode-object";
import { GitHubObject } from "../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../workers/github-webhook-router-object";
import { McpObject } from "../../workers/mcp-object";
import { OtpObject } from "../../workers/otp-object";
import { ProjectConnectorObject } from "../../workers/project-connector-object";
import { ResendObject } from "../../workers/resend-object";
import { TelegramObject } from "../../workers/telegram-object";
import { UploadObject } from "../../workers/upload-object";
import { backofficeApiRouter } from "./backoffice-api-router";

const origin = "https://backoffice.example";
const providerOrigin = "https://provider.test";
const providerRequests: string[] = [];

const scenarioObjects = {
  API: (input) =>
    new ApiObject({
      ...input,
      fetch: async (request, init) => {
        const url = new URL(new Request(request, init).url);
        providerRequests.push(`${url.host}${url.pathname}`);
        return Response.json({ ok: true });
      },
    }),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  PI_MANAGER: allLocalObjects.PI_MANAGER,
} satisfies LocalBackofficeObjects;

const workflowPath = "/workspace/automations/lookup.workflow.js";

/**
 * Plays the app's lookup: for each call, in the personal workspace of the person it names, executes
 * on, lists, or reads their connections, or reads a file, and records what it got or the denial.
 * With `wait`, it does the same again once it receives `continue`.
 */
const lookupWorkflowSource = `export default defineWorkflow({ name: "lookup" }, async (event, step) => {
  const lookUp = async () => {
    const outcomes = [];
    for (const { userId, call, connectionId } of event.payload.calls) {
      const person = context.user(userId);
      try {
        if (call === "execute") {
          await person.integrations.execute({
            connectionId,
            actionId: "request",
            input: { method: "GET", path: "/" + userId + "/" + connectionId.slice(4), body: { type: "empty" } },
          });
          outcomes.push("allowed");
        } else if (call === "list") {
          const page = await person.integrations.list({ cursor: null });
          outcomes.push("listed " + page.connections.map((c) => c.connectionId).sort().join(","));
        } else if (call === "actions") {
          const actions = await person.integrations.actions({ connectionId });
          outcomes.push("actions " + actions.map((a) => a.id).join(","));
        } else if (call === "resolvePath") {
          await person.state.resolvePath({ base: "/workspace", path: "notes.md" });
          outcomes.push("allowed");
        } else {
          await person.state.readFile({ path: "/workspace/notes.md" });
          outcomes.push("allowed");
        }
      } catch (error) {
        outcomes.push(String((error && error.message) || error));
      }
    }
    return outcomes;
  };
  const first = await step.do("look up", lookUp);
  if (!event.payload.wait) {
    return { first };
  }
  await step.waitForEvent("continue", { type: "continue" });
  const second = await step.do("look up again", lookUp);
  return { first, second };
});
`;

type Vars = {
  ownerCookie: string;
  memberCookie: string;
  otherCookie: string;
  ownerId: string;
  memberId: string;
  otherId: string;
  orgId: string;
  secondOrgId: string;
  brandAppId: string;
  brandClientId: string;
  brandClientSecret: string;
  otherAppId: string;
  brandCredential: string;
  secondOrgCredential: string;
  otherAppCredential: string;
  installationCredential: string;
  personalProjectId: string;
};
type Ctx = BackofficeScenarioContext<Vars>;

type RegisteredClient = { clientId: string; clientSecret: string };

function orgScope(orgId: string): BackofficeOrganizationContextScope {
  return { kind: "org", orgId, jurisdiction: null };
}

function personalScope(userId: string) {
  return { kind: "user", userId, jurisdiction: null } as const;
}

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

function redirectUri(slug: string) {
  return `https://${slug}.example/api/auth/oauth2/callback/backoffice`;
}

/** Registers an app that asks for what organizations grant it, and for members' workspaces. */
async function registerApp(ctx: Ctx, slug: string, name: string) {
  const client = await ctx.runtime.objects.auth.singleton().commands.createAdminOAuthClient({
    administratorUserId: "platform-admin",
    name,
    redirectUris: [redirectUri(slug)],
    scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
    clientType: "confidential",
    applicationType: "web",
    clientCredentials: true,
  });
  assert(client.clientType === "confidential");
  const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
    actions: { kind: "none" },
    trust: { kind: "third-party" },
    slug,
    oauthClientId: client.clientId,
    requestedPermissions: appGrants,
    requestedMemberReach: { kind: "consenting" },
  });
  assert(registered.ok);
  return {
    appId: registered.value.appId,
    client: { clientId: client.clientId, clientSecret: client.clientSecret },
  };
}

const appGrants = [
  BACKOFFICE_PERMISSION.workflow.modify,
  BACKOFFICE_PERMISSION.workflow.executeCode,
  BACKOFFICE_PERMISSION.workflow.read,
  BACKOFFICE_PERMISSION.upload.read,
  BACKOFFICE_PERMISSION.integrations.read,
  BACKOFFICE_PERMISSION.integrations.execute,
  // Connection sources read their connections with it.
  BACKOFFICE_PERMISSION.connections.read,
  BACKOFFICE_PERMISSION.pi.read,
];

function memberReach(consenting: boolean) {
  return consenting ? ({ kind: "consenting" } as const) : ({ kind: "none" } as const);
}

async function install(ctx: Ctx, orgId: string, appId: string, consenting: boolean) {
  const installed = await ctx.runtime.objects.appInstallations
    .for(orgScope(orgId))
    .commands.installApp({
      actionsRevision: 1,
      appId,
      grantedPermissions: appGrants,
      installedByUserId: ctx.vars.ownerId,
      resourceScope: { kind: "owner" },
      memberReach: memberReach(consenting),
    });
  assert(installed.ok, JSON.stringify(installed));
}

/** The organization lets the app ask its members, or stops it, keeping everything else. */
async function setMemberReach(ctx: Ctx, consenting: boolean) {
  const updated = await ctx.runtime.objects.appInstallations
    .for(orgScope(ctx.vars.orgId))
    .commands.updateInstallationAccess({
      appId: ctx.vars.brandAppId,
      grantedPermissions: appGrants,
      resourceScope: { kind: "owner" },
      memberReach: memberReach(consenting),
    });
  assert(updated.ok, JSON.stringify(updated));
}

/** Plays the app's server: authorization code + PKCE for the member, then an execution token. */
async function authorizeAndExchange(
  ctx: Ctx,
  slug: string,
  client: RegisteredClient,
  orgId: string,
) {
  const codeVerifier = "b".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  ).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(slug),
    response_type: "code",
    scope: "openid profile email offline_access backoffice",
    state: "login",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: origin,
    prompt: "consent",
  });
  const authorization = await authRequest(ctx, `/oauth2/authorize?${query}`, ctx.vars.memberCookie);
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const location = authorization.headers.get("location");
  assert(location);
  const approved = await authRequest(ctx, "/oauth2/consent", ctx.vars.memberCookie, {
    accept: true,
    oauth_query: new URL(location, origin).search.slice(1),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const code = new URL(
    z.object({ url: z.string() }).parse(await approved.json()).url,
  ).searchParams.get("code");
  assert(code);
  const token = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(slug),
        code_verifier: codeVerifier,
        resource: origin,
      }),
    }),
  );
  assert.equal(token.status, 200, await token.clone().text());
  const accessToken = z.object({ access_token: z.string() }).parse(await token.json()).access_token;

  const request = new Request(`${origin}/api/backoffice/execution-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ scope: orgScope(orgId) }),
  });
  const exchanged = await exchangeAction({
    request,
    context: routerContext(ctx, request),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/execution-token",
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  return backofficeExecutionTokenResultSchema.parse(await exchanged.json()).accessToken;
}

/** Plays the app's server acting as itself: a client-credentials token, then an execution token. */
async function exchangeAsInstallation(ctx: Ctx, client: RegisteredClient, orgId: string) {
  const token = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "backoffice",
        resource: origin,
      }),
    }),
  );
  assert.equal(token.status, 200, await token.clone().text());
  const accessToken = z.object({ access_token: z.string() }).parse(await token.json()).access_token;
  const request = new Request(`${origin}/api/backoffice/execution-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ scope: orgScope(orgId) }),
  });
  const exchanged = await exchangeAction({
    request,
    context: routerContext(ctx, request),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/execution-token",
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  return backofficeExecutionTokenResultSchema.parse(await exchanged.json()).accessToken;
}

function brandClient(ctx: Ctx): RegisteredClient {
  return { clientId: ctx.vars.brandClientId, clientSecret: ctx.vars.brandClientSecret };
}

/** The app's server, calling Backoffice through the published client. */
function appClient(ctx: Ctx, credential: string) {
  return createBackofficeApiClient({
    origin,
    accessToken: credential,
    fetch: async (url, init) =>
      await backofficeApiRouter.fetch(new Request(url, init), {
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
      }),
  });
}

type Call =
  | { userId: string; call: "execute" | "actions"; connectionId: string }
  | { userId: string; call: "list" | "readFile" | "resolvePath" };

/** The app starts a lookup as the member, in the organization its credential is for. */
async function startLookup(
  ctx: Ctx,
  input: { credential: string; orgId: string; instanceId: string; calls: Call[]; wait: boolean },
) {
  await appClient(ctx, input.credential).call(orgScope(input.orgId), "workflow.instances.create", {
    path: workflowPath,
    instanceId: input.instanceId,
    payload: { calls: input.calls, wait: input.wait },
  });
}

async function lookupOutput(ctx: Ctx, credential: string, orgId: string, instanceId: string) {
  const instance = await appClient(ctx, credential).call(
    orgScope(orgId),
    "workflow.instances.get",
    { instanceId },
  );
  assert.equal(instance.details.status, "complete", JSON.stringify(instance.details));
  return z
    .object({ first: z.array(z.string()), second: z.array(z.string()).optional() })
    .parse(instance.details.output);
}

function memberReachUrl(ctx: Ctx, orgId: string) {
  return new URL(`${origin}/backoffice/apps/${ctx.vars.brandAppId}/member-reach/${orgId}`);
}

/** The person's own page for the app in an organization, as the signed-in browser opens it. */
async function openMemberReach(ctx: Ctx, cookie: string, orgId: string) {
  const url = memberReachUrl(ctx, orgId);
  const request = new Request(url, { headers: { cookie } });
  const result = await memberReachLoader({
    request,
    context: routerContext(ctx, request),
    params: { appId: ctx.vars.brandAppId, orgId },
    url,
    pattern: "/backoffice/apps/:appId/member-reach/:orgId",
  });
  return result.data;
}

async function submitMemberReach(
  ctx: Ctx,
  cookie: string,
  orgId: string,
  fields: Record<string, string>,
  requestOrigin = origin,
) {
  const url = memberReachUrl(ctx, orgId);
  const request = new Request(url, {
    method: "POST",
    headers: {
      cookie,
      origin: requestOrigin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  return await memberReachAction({
    request,
    context: routerContext(ctx, request),
    params: { appId: ctx.vars.brandAppId, orgId },
    url,
    pattern: "/backoffice/apps/:appId/member-reach/:orgId",
  });
}

/** The member allows the installation the page shows them. */
async function letIn(ctx: Ctx) {
  const page = await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId);
  assert(page.appAsks && page.installation, "The page offers to let the app in.");
  const allowed = await submitMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId, {
    intent: "allow",
    activation: String(page.installation.activation),
  });
  assert(allowed instanceof Response, JSON.stringify(allowed));
}

async function stopLettingIn(ctx: Ctx) {
  const stopped = await submitMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId, {
    intent: "stop",
  });
  assert(stopped instanceof Response, JSON.stringify(stopped));
}

/** The apps the person sees with access to their personal workspace, under Authorized applications. */
async function listAppsInWorkspace(ctx: Ctx, cookie: string) {
  const url = new URL(`${origin}/backoffice/settings/authorized-applications`);
  const request = new Request(url, { headers: { cookie } });
  const result = await authorizedApplicationsLoader({
    request,
    context: routerContext(ctx, request),
    params: {},
    url,
    pattern: "/backoffice/settings/authorized-applications",
  });
  return result.data.memberReach.consents;
}

function notLetIn(appId: string, orgId: string) {
  return `This app may not act in your personal workspace for this organization. You can let it in at /backoffice/apps/${appId}/member-reach/${orgId} in Leyway, once the organization lets the app ask its members.`;
}

const outsideCredential = "Credential scope does not permit the target scope.";
const outsideCeiling = "Execution scope exceeds its retained scope ceiling.";

/** Refused by the API router before any operation runs. */
async function expectForbiddenScope(call: Promise<unknown>) {
  await expect(call).rejects.toMatchObject({
    name: "BackofficeApiRequestError",
    code: "forbidden",
  });
}

describe("an installed app acting for a member reaches the member's personal workspace", () => {
  test("only while the organization lets the app ask its members and the member lets it in, acting for them alone", async () => {
    providerRequests.length = 0;
    await runBackofficeScenario(
      defineBackofficeScenario<Vars>({
        name: "installed app reaches a member's personal workspace",
        objects: scenarioObjects,
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
        vars: () => ({
          ownerCookie: "",
          memberCookie: "",
          otherCookie: "",
          ownerId: "",
          memberId: "",
          otherId: "",
          orgId: "",
          secondOrgId: "",
          brandAppId: "",
          brandClientId: "",
          brandClientSecret: "",
          otherAppId: "",
          brandCredential: "",
          secondOrgCredential: "",
          otherAppCredential: "",
          installationCredential: "",
          personalProjectId: "",
        }),
        setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
        steps: ({ when, then, runner }) => [
          when.auth.signUp({ email: "owner@brand.test", captureSessionCookieAs: "ownerCookie" }),
          when.auth.signUp({ email: "member@brand.test", captureSessionCookieAs: "memberCookie" }),
          when.auth.signUp({ email: "other@brand.test", captureSessionCookieAs: "otherCookie" }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.ownerCookie,
            name: "Brand Brain",
            slug: "brand-brain",
            captureOrganizationIdAs: "orgId",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.ownerCookie,
            name: "Second Brand",
            slug: "second-brand",
            captureOrganizationIdAs: "secondOrgId",
          }),
          then.assert(
            "both organizations install the app, only the second letting it ask its members, the first also another app, and the member authorizes them",
            async (ctx) => {
              ctx.vars.ownerId = await sessionUserId(ctx, ctx.vars.ownerCookie);
              ctx.vars.memberId = await sessionUserId(ctx, ctx.vars.memberCookie);
              ctx.vars.otherId = await sessionUserId(ctx, ctx.vars.otherCookie);
              const auth = ctx.runtime.objects.auth.singleton().commands;
              await auth.applyScenarioFixture({
                // The owner also administers Leyway, as whom they can impersonate people.
                users: [
                  {
                    id: ctx.vars.ownerId,
                    email: "owner@brand.test",
                    role: "admin",
                    status: "active",
                  },
                ],
                members: [ctx.vars.orgId, ctx.vars.secondOrgId].map((organizationId) => ({
                  organizationId,
                  userId: ctx.vars.memberId,
                  roles: ["member"],
                })),
              });
              for (const orgId of [ctx.vars.orgId, ctx.vars.secondOrgId]) {
                await ctx.runCodemode({
                  scope: orgScope(orgId),
                  code: `async () => await state.writeFile(${JSON.stringify({
                    path: workflowPath,
                    content: lookupWorkflowSource,
                  })})`,
                });
              }
              const brand = await registerApp(ctx, "brand", "Brand Intelligence");
              const other = await registerApp(ctx, "other", "Other App");
              ctx.vars.brandAppId = brand.appId;
              ctx.vars.brandClientId = brand.client.clientId;
              ctx.vars.brandClientSecret = brand.client.clientSecret;
              ctx.vars.otherAppId = other.appId;
              await install(ctx, ctx.vars.orgId, brand.appId, false);
              await install(ctx, ctx.vars.secondOrgId, brand.appId, true);
              await install(ctx, ctx.vars.orgId, other.appId, true);
              ctx.vars.brandCredential = await authorizeAndExchange(
                ctx,
                "brand",
                brand.client,
                ctx.vars.orgId,
              );
              ctx.vars.secondOrgCredential = await authorizeAndExchange(
                ctx,
                "brand",
                brand.client,
                ctx.vars.secondOrgId,
              );
              ctx.vars.otherAppCredential = await authorizeAndExchange(
                ctx,
                "other",
                other.client,
                ctx.vars.orgId,
              );
              ctx.vars.installationCredential = await exchangeAsInstallation(
                ctx,
                brand.client,
                ctx.vars.orgId,
              );
            },
          ),
          then.assert(
            "the member and another person each connect their billing and CRM APIs, and the member keeps notes and a project; their own installation of the app cannot reach members",
            async (ctx) => {
              for (const userId of [ctx.vars.memberId, ctx.vars.otherId]) {
                for (const slug of ["billing", "crm"]) {
                  await ctx.runCodemode({
                    scope: personalScope(userId),
                    code: `async () => await integrations.setup({ kind: "input", connectionId: "api#${slug}", input: {
                      type: "none", baseUrl: "${providerOrigin}",
                    } })`,
                  });
                }
              }
              await ctx.runCodemode({
                scope: personalScope(ctx.vars.memberId),
                code: `async () => await state.writeFile({ path: "/workspace/notes.md", content: "notes" })`,
              });
              const project = await createAutomationsRouteCaller({
                object: ctx.runtime.objects.automations.for(personalScope(ctx.vars.memberId)),
              })("POST", "/projects", {
                body: { name: "Side project", createdByUserId: ctx.vars.memberId },
              });
              assert(project.type === "json", `Project creation failed with ${project.status}`);
              ctx.vars.personalProjectId = String(
                z.object({ id: z.unknown() }).parse(project.data).id,
              );
              // Only an organization's installation reaches members.
              const personalInstall = await ctx.runtime.objects.appInstallations
                .for(personalScope(ctx.vars.memberId))
                .commands.installApp({
                  actionsRevision: 1,
                  appId: ctx.vars.brandAppId,
                  grantedPermissions: appGrants,
                  installedByUserId: ctx.vars.memberId,
                  resourceScope: { kind: "owner" },
                  memberReach: { kind: "consenting" },
                });
              expect(personalInstall).toMatchObject({
                ok: false,
                error: { code: "APP_MEMBER_REACH_NOT_ORGANIZATION" },
              });
            },
          ),
          then.assert(
            "the member lets the app in for the first organization, which does not let it ask yet, and an impersonating administrator cannot do it for them",
            async (ctx) => {
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({
                appName: "Brand Intelligence",
                organization: { id: ctx.vars.orgId, name: "Brand Brain" },
                appAsks: true,
                installation: { organizationAllows: false },
                consent: null,
              });
              // Organizations the person is not in are unknown to them.
              await expect(
                openMemberReach(ctx, ctx.vars.otherCookie, ctx.vars.orgId),
              ).rejects.toMatchObject({ status: 404 });

              const impersonated = await authRequest(
                ctx,
                "/admin/impersonate-user",
                ctx.vars.ownerCookie,
                { userId: ctx.vars.memberId },
              );
              assert.equal(impersonated.status, 200, await impersonated.clone().text());
              // Impersonating clears the administrator's cookies before setting the member's.
              const cookies = new Map(
                impersonated.headers
                  .getSetCookie()
                  .map((header) => header.split(";", 1)[0].split("=") as [string, string]),
              );
              const impersonatedCookie = [...cookies]
                .filter(([, value]) => value !== "")
                .map(([name, value]) => `${name}=${value}`)
                .join("; ");
              const refused = await submitMemberReach(ctx, impersonatedCookie, ctx.vars.orgId, {
                intent: "allow",
                activation: "1",
              }).catch((error: unknown) => error);
              assert(refused instanceof Response, "An impersonated session is refused.");
              assert.equal(refused.status, 403);
              // Nor can another site, though the member's cookie rides along.
              const crossSite = await submitMemberReach(
                ctx,
                ctx.vars.memberCookie,
                ctx.vars.orgId,
                { intent: "allow", activation: "1" },
                "https://elsewhere.example",
              ).catch((error: unknown) => error);
              assert(crossSite instanceof Response, "A cross-site request is refused.");
              assert.equal(crossSite.status, 403);
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({ consent: null });

              await letIn(ctx);
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({
                installation: { organizationAllows: false },
                consent: { orgId: ctx.vars.orgId, forInstallation: true },
              });
              expect(await listAppsInWorkspace(ctx, ctx.vars.memberCookie)).toMatchObject([
                {
                  appName: "Brand Intelligence",
                  organizationName: "Brand Brain",
                  managePath: `/backoffice/apps/${ctx.vars.brandAppId}/member-reach/${ctx.vars.orgId}`,
                },
              ]);
              expect(await listAppsInWorkspace(ctx, ctx.vars.otherCookie)).toEqual([]);
              await startLookup(ctx, {
                credential: ctx.vars.brandCredential,
                orgId: ctx.vars.orgId,
                instanceId: "organization-not-asking",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                ],
                wait: false,
              });
            },
          ),
          runner.drain(),
          then.assert(
            "the app was refused, and the organization lets it ask its members",
            async (ctx) => {
              const { first } = await lookupOutput(
                ctx,
                ctx.vars.brandCredential,
                ctx.vars.orgId,
                "organization-not-asking",
              );
              expect(first).toEqual([
                expect.stringContaining(notLetIn(ctx.vars.brandAppId, ctx.vars.orgId)),
              ]);
              expect(providerRequests).toEqual([]);
              await setMemberReach(ctx, true);
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({
                installation: { organizationAllows: true },
                consent: { orgId: ctx.vars.orgId, forInstallation: true },
              });
            },
          ),
          then.assert(
            "the app's server reaches the member's workspace for them, but not as itself, not another person's, and not the member's projects",
            async (ctx) => {
              const page = await appClient(ctx, ctx.vars.brandCredential).call(
                personalScope(ctx.vars.memberId),
                "integrations.list",
                { cursor: null },
              );
              expect(page.connections.map(({ connectionId }) => connectionId).sort()).toEqual([
                "api#billing",
                "api#crm",
              ]);
              await expectForbiddenScope(
                appClient(ctx, ctx.vars.brandCredential).call(
                  personalScope(ctx.vars.otherId),
                  "integrations.list",
                  { cursor: null },
                ),
              );
              await expectForbiddenScope(
                appClient(ctx, ctx.vars.brandCredential).call(
                  {
                    kind: "project",
                    owner: personalScope(ctx.vars.memberId),
                    projectId: ctx.vars.personalProjectId,
                  },
                  "integrations.list",
                  { cursor: null },
                ),
              );
              // A watch is authorized only when it opens, so it never follows the app in.
              const organizationInstallation = await ctx.runtime.objects.appInstallations
                .for(orgScope(ctx.vars.orgId))
                .commands.getInstallation({ appId: ctx.vars.brandAppId });
              assert(organizationInstallation);
              expect(
                await ctx.runtime.objects.piManager
                  .for(personalScope(ctx.vars.memberId))
                  .commands.authorizeViewer({
                    agentName: "assistant",
                    execution: {
                      ...createInstalledAppExecution({
                        scope: orgScope(ctx.vars.orgId),
                        actor: { kind: "user", userId: ctx.vars.memberId },
                        installation: { ...organizationInstallation, externalAccount: null },
                      }),
                      scope: personalScope(ctx.vars.memberId),
                    },
                  }),
              ).toEqual({
                type: "refused",
                message: "An app cannot watch an agent in a member's personal workspace.",
              });
              await expectForbiddenScope(
                appClient(ctx, ctx.vars.installationCredential).call(
                  personalScope(ctx.vars.memberId),
                  "integrations.list",
                  { cursor: null },
                ),
              );
            },
          ),
          then.assert(
            "the app starts lookups for the member in both organizations and as itself, and another app one in the first",
            async (ctx) => {
              await startLookup(ctx, {
                credential: ctx.vars.brandCredential,
                orgId: ctx.vars.orgId,
                instanceId: "let-in",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                  { userId: ctx.vars.memberId, call: "actions", connectionId: "api#billing" },
                  { userId: ctx.vars.memberId, call: "list" },
                  { userId: ctx.vars.memberId, call: "readFile" },
                  // Checks no permission, so it never runs beyond the credential's scope.
                  { userId: ctx.vars.memberId, call: "resolvePath" },
                  { userId: ctx.vars.otherId, call: "execute", connectionId: "api#billing" },
                ],
                wait: true,
              });
              await startLookup(ctx, {
                credential: ctx.vars.installationCredential,
                orgId: ctx.vars.orgId,
                instanceId: "as-installation",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                ],
                wait: false,
              });
              await startLookup(ctx, {
                credential: ctx.vars.secondOrgCredential,
                orgId: ctx.vars.secondOrgId,
                instanceId: "second-org",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                ],
                wait: false,
              });
              await startLookup(ctx, {
                credential: ctx.vars.otherAppCredential,
                orgId: ctx.vars.orgId,
                instanceId: "other-app",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                ],
                wait: false,
              });
            },
          ),
          runner.drain(),
          then.assert(
            "the member stops it while the lookup waits, and the app is told to continue",
            async (ctx) => {
              await stopLettingIn(ctx);
              expect(await listAppsInWorkspace(ctx, ctx.vars.memberCookie)).toEqual([]);
              await appClient(ctx, ctx.vars.brandCredential).call(
                orgScope(ctx.vars.orgId),
                "workflow.instances.send-event",
                { instanceId: "let-in", type: "continue" },
              );
            },
          ),
          runner.drain(),
          then.assert(
            "the member's workspace answered until they stopped it, and only for this app in this organization acting for them",
            async (ctx) => {
              const { first, second } = await lookupOutput(
                ctx,
                ctx.vars.brandCredential,
                ctx.vars.orgId,
                "let-in",
              );
              expect(first).toEqual([
                "allowed",
                "actions request,connection.describe",
                "listed api#billing,api#crm",
                "allowed",
                expect.stringContaining(outsideCeiling),
                expect.stringContaining(outsideCredential),
              ]);
              const refused = notLetIn(ctx.vars.brandAppId, ctx.vars.orgId);
              expect(second).toEqual([
                expect.stringContaining(refused),
                expect.stringContaining(refused),
                expect.stringContaining(refused),
                expect.stringContaining(refused),
                expect.stringContaining(outsideCeiling),
                expect.stringContaining(outsideCredential),
              ]);
              expect(
                (
                  await lookupOutput(
                    ctx,
                    ctx.vars.installationCredential,
                    ctx.vars.orgId,
                    "as-installation",
                  )
                ).first,
              ).toEqual([expect.stringContaining(outsideCredential)]);
              expect(
                (
                  await lookupOutput(
                    ctx,
                    ctx.vars.secondOrgCredential,
                    ctx.vars.secondOrgId,
                    "second-org",
                  )
                ).first,
              ).toEqual([
                expect.stringContaining(notLetIn(ctx.vars.brandAppId, ctx.vars.secondOrgId)),
              ]);
              expect(
                (await lookupOutput(ctx, ctx.vars.otherAppCredential, ctx.vars.orgId, "other-app"))
                  .first,
              ).toEqual([expect.stringContaining(notLetIn(ctx.vars.otherAppId, ctx.vars.orgId))]);
              expect(providerRequests).toEqual([`provider.test/${ctx.vars.memberId}/billing`]);
            },
          ),
          then.assert(
            "the member lets it in again, but the organization stops letting the app ask its members",
            async (ctx) => {
              await letIn(ctx);
              await setMemberReach(ctx, false);
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({
                installation: { organizationAllows: false },
                consent: { orgId: ctx.vars.orgId, forInstallation: true },
              });
              await startLookup(ctx, {
                credential: ctx.vars.brandCredential,
                orgId: ctx.vars.orgId,
                instanceId: "organization-stopped",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                ],
                wait: false,
              });
            },
          ),
          runner.drain(),
          then.assert(
            "the organization reinstalls the app letting it ask, and the member's earlier consent no longer applies",
            async (ctx) => {
              expect(
                (
                  await lookupOutput(
                    ctx,
                    ctx.vars.brandCredential,
                    ctx.vars.orgId,
                    "organization-stopped",
                  )
                ).first,
              ).toEqual([expect.stringContaining(notLetIn(ctx.vars.brandAppId, ctx.vars.orgId))]);

              // The member has the page open while the organization reinstalls the app.
              const opened = await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId);
              assert(opened.installation);
              const installations = ctx.runtime.objects.appInstallations.for(
                orgScope(ctx.vars.orgId),
              ).commands;
              assert((await installations.uninstallApp({ appId: ctx.vars.brandAppId })).ok);
              await install(ctx, ctx.vars.orgId, ctx.vars.brandAppId, true);
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({
                installation: {
                  organizationAllows: true,
                  activation: opened.installation.activation + 1,
                },
                consent: { activation: opened.installation.activation, forInstallation: false },
              });
              // Allowing from the page opened before lets nothing in unseen.
              expect(
                await submitMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId, {
                  intent: "allow",
                  activation: String(opened.installation.activation),
                }),
              ).toMatchObject({
                data: { message: expect.stringContaining("installed this app again") },
                init: { status: 400 },
              });
              ctx.vars.brandCredential = await authorizeAndExchange(
                ctx,
                "brand",
                brandClient(ctx),
                ctx.vars.orgId,
              );
              await startLookup(ctx, {
                credential: ctx.vars.brandCredential,
                orgId: ctx.vars.orgId,
                instanceId: "reinstalled",
                calls: [
                  { userId: ctx.vars.memberId, call: "execute", connectionId: "api#billing" },
                ],
                wait: false,
              });
            },
          ),
          runner.drain(),
          then.assert(
            "the reinstalled app is refused until the member lets it in again, and then the lookup waits",
            async (ctx) => {
              expect(
                (await lookupOutput(ctx, ctx.vars.brandCredential, ctx.vars.orgId, "reinstalled"))
                  .first,
              ).toEqual([expect.stringContaining(notLetIn(ctx.vars.brandAppId, ctx.vars.orgId))]);
              await letIn(ctx);
              await startLookup(ctx, {
                credential: ctx.vars.brandCredential,
                orgId: ctx.vars.orgId,
                instanceId: "member-leaves",
                calls: [{ userId: ctx.vars.memberId, call: "execute", connectionId: "api#crm" }],
                wait: true,
              });
            },
          ),
          runner.drain(),
          then.assert("the app is told to continue", async (ctx) => {
            await appClient(ctx, ctx.vars.brandCredential).call(
              orgScope(ctx.vars.orgId),
              "workflow.instances.send-event",
              { instanceId: "member-leaves", type: "continue" },
            );
          }),
          when.auth.removeMember({
            orgId: ({ vars }) => vars.orgId,
            userId: ({ vars }) => vars.memberId,
          }),
          runner.drain(),
          then.assert(
            "the member's workspace answered while they belonged to the organization, and not after they left",
            async (ctx) => {
              // The member rejoins only so the app can read the lookup for them.
              await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
                members: [
                  { organizationId: ctx.vars.orgId, userId: ctx.vars.memberId, roles: ["member"] },
                ],
              });
              expect(
                await lookupOutput(ctx, ctx.vars.brandCredential, ctx.vars.orgId, "member-leaves"),
              ).toEqual({
                first: ["allowed"],
                second: [expect.stringContaining(notLetIn(ctx.vars.brandAppId, ctx.vars.orgId))],
              });
              expect(providerRequests).toEqual([
                `provider.test/${ctx.vars.memberId}/billing`,
                `provider.test/${ctx.vars.memberId}/crm`,
              ]);
            },
          ),
          then.assert(
            "the app stops asking for members' workspaces, which the organization's installation keeps, and the member still stops it",
            async (ctx) => {
              const updated = await ctx.runtime.objects.apps
                .singleton()
                .commands.updateAppPermissions({
                  appId: ctx.vars.brandAppId,
                  requestedPermissions: appGrants,
                  requestedMemberReach: { kind: "none" },
                });
              assert(updated.ok, JSON.stringify(updated));
              const listWorkspace = () =>
                appClient(ctx, ctx.vars.brandCredential).call(
                  personalScope(ctx.vars.memberId),
                  "integrations.list",
                  { cursor: null },
                );
              expect((await listWorkspace()).connections).toHaveLength(2);
              expect(
                await openMemberReach(ctx, ctx.vars.memberCookie, ctx.vars.orgId),
              ).toMatchObject({
                // The page tells the member the app still gets in, though it no longer asks.
                appAsks: false,
                installation: { organizationAllows: true },
                consent: { orgId: ctx.vars.orgId, forInstallation: true },
              });
              await stopLettingIn(ctx);
              expect(await listAppsInWorkspace(ctx, ctx.vars.memberCookie)).toEqual([]);
              await expectForbiddenScope(listWorkspace());
            },
          ),
        ],
      }),
    );
  });
});
