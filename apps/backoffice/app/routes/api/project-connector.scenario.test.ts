import { assert, expect, test, vi } from "vitest";

import { integrationSetupProgressSchema } from "@fragno-dev/backoffice-api/v0/integrations";
import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { projectConnectorConnectionSchema } from "@fragno-dev/project-connector-fragment/contracts";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeScenarioContext } from "@/fragno/automation/scenario";
import { encodeConnectorConnectionId } from "@/fragno/runtime-tools/families/integrations/connector-connection-id";
import { runProjectConnectorScenario } from "@/fragno/runtime-tools/families/project-connector-scenario.test-utils";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { FormsObject } from "../../../workers/forms-object";
import { GitHubObject } from "../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../workers/github-webhook-router-object";
import { McpObject } from "../../../workers/mcp-object";
import { OtpObject } from "../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../workers/project-connector-object";
import { TelegramObject } from "../../../workers/telegram-object";
import { UploadObject } from "../../../workers/upload-object";
import { action, loader } from "./project-connector";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

async function callPublicProjectConnector(
  ctx: BackofficeScenarioContext,
  scopeSegment: string,
  suffix: string,
  method: "GET" | "POST",
  cookie: string | null,
  body: unknown = null,
) {
  const url = new URL(
    `https://backoffice.example/api/connector/${encodeURIComponent(scopeSegment)}${suffix}`,
  );
  const request = new Request(url, {
    method,
    headers: {
      "x-user-id": "forged-user",
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { "content-type": "application/json", origin: url.origin } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const args = {
    request,
    url,
    pattern: "/api/connector/:scopeSegment/*",
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: { scopeSegment, "*": new URL(request.url).pathname.split("/").slice(4).join("/") },
  };
  return method === "GET" ? await loader(args) : await action(args);
}

const workConnectionId = encodeConnectorConnectionId([
  "named",
  "project-1",
  "gmail-provider",
  "work",
]);

/** Runs one integrations call for a user from an organization's codemode, as an agent would. */
async function runUserIntegrations(ctx: BackofficeScenarioContext, userId: string, call: string) {
  const run = await ctx.runCodemode({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    label: `integrations for ${userId}`,
    code: `async () => await context.user(${JSON.stringify(userId)}).integrations.${call}`,
  });
  return run.result;
}

/** Starts consent through setup; the test gateway's authorization link ends in the request ID. */
async function startConnectorConsent(ctx: BackofficeScenarioContext, userId: string) {
  const progress = integrationSetupProgressSchema.parse(
    await runUserIntegrations(
      ctx,
      userId,
      `setup({ kind: "input", connectionId: ${JSON.stringify(workConnectionId)}, input: { start: true } })`,
    ),
  );
  assert(progress.status === "needs-authorization");
  const requestId = new URL(progress.authorizationUrl).pathname.split("/").at(-1);
  assert(requestId);
  return requestId;
}

/** A setup check refreshes the saved request, confirming consent with the gateway. */
async function checkConnectorSetup(ctx: BackofficeScenarioContext, userId: string) {
  return integrationSetupProgressSchema.parse(
    await runUserIntegrations(
      ctx,
      userId,
      `setup({ kind: "check", connectionId: ${JSON.stringify(workConnectionId)} })`,
    ),
  );
}

async function listConnectionIds(ctx: BackofficeScenarioContext, userId: string) {
  const page = (await runUserIntegrations(ctx, userId, "list({ cursor: null })")) as {
    connections: { connectionId: string }[];
  };
  return page.connections.map((connection) => connection.connectionId);
}

async function issueBackofficeAccessCookie(
  ctx: BackofficeScenarioContext,
  sessionCookie: string,
  organizationId: string | null,
) {
  const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.example/api/auth/backoffice-token", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://backoffice.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        organizationId ? { selection: "required", organizationId } : { selection: "preferred" },
      ),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  const accessCookie = exchange.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
  assert(accessCookie);
  return accessCookie;
}

test("an anonymous OAuth browser return cannot create or forge a Connector account binding", async () => {
  await runProjectConnectorScenario((gateway) => ({
    objects: scenarioObjects,
    name: "Connector callback query parameters are navigation only",
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
      // Public routes reach only users Auth knows.
      given.auth.user({ id: "callback-only-user" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "forged success returns navigate without gateway verification or account writes",
        async (ctx) => {
          const callbackOnlyUser = {
            binding: "PROJECT_CONNECTOR" as const,
            scope: { kind: "user" as const, userId: "callback-only-user", jurisdiction: null },
          };
          assert(!ctx.runtime.hasObjectInstance(callbackOnlyUser));
          const callbackOnlyRedirect = await callPublicProjectConnector(
            ctx,
            "user:callback-only-user",
            "/oauth/callback?status=success&connected_account_id=forged-account",
            "GET",
            null,
          );
          assert(callbackOnlyRedirect.status === 302);
          assert(
            callbackOnlyRedirect.headers.get("location") ===
              "https://backoffice.example/backoffice/integrations/user/callback-only-user?oauth=returned",
          );
          assert(!ctx.runtime.hasObjectInstance(callbackOnlyUser));

          const requestId = await startConnectorConsent(ctx, "user-1");
          const callback = await callPublicProjectConnector(
            ctx,
            "user:user-1",
            `/oauth/callback?status=success&connection_request_id=${requestId}&connected_account_id=forged-account&user_id=forged-user`,
            "GET",
            null,
          );
          assert(callback.status === 302);
          assert(
            callback.headers.get("location") ===
              "https://backoffice.example/backoffice/integrations/user/user-1?oauth=returned",
          );
          assert(gateway.control.requestReads === 0);
          const organizationCallback = await callPublicProjectConnector(
            ctx,
            "org:ada-labs",
            "/oauth/callback",
            "GET",
            null,
          );
          assert(organizationCallback.status === 404);
          expect(await listConnectionIds(ctx, "user-1")).toEqual([]);
          const post = await callPublicProjectConnector(
            ctx,
            "user:user-1",
            "/oauth/callback",
            "POST",
            null,
            { connectedAccountId: "forged-account" },
          );
          assert(post.status === 401);
          const anonymousRefresh = await callPublicProjectConnector(
            ctx,
            "user:user-1",
            `/connection-requests/${requestId}/refresh`,
            "POST",
            null,
          );
          assert(anonymousRefresh.status === 401);
          gateway.authorize(requestId, "verified-account");
          await callPublicProjectConnector(
            ctx,
            "user:user-1",
            "/oauth/callback?status=success&connected_account_id=forged-account",
            "GET",
            null,
          );
          // The browser return still did not persist anything.
          expect(await listConnectionIds(ctx, "user-1")).toEqual([]);
          expect(await checkConnectorSetup(ctx, "user-1")).toMatchObject({ status: "ready" });
          expect(await listConnectionIds(ctx, "user-1")).toEqual([workConnectionId]);
        },
      ),
    ],
  }));
});

test("public action requests enforce verified execution permissions before contacting a user's provider", async () => {
  await runProjectConnectorScenario((gateway) => ({
    objects: scenarioObjects,
    name: "Connector public actions cannot bypass kernel permissions",
    env: { DOCS_PUBLIC_BASE_URL: "https://backoffice.example" },
    fakes: ({ fake }) => ({ resend: fake.resend() }),
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ when, then }) => [
      when.auth.signUp({
        email: "connector-foreign@example.test",
        captureSessionCookieAs: "foreignSessionCookie",
      }),
      when.auth.signUp({
        email: "connector-member@example.test",
        captureSessionCookieAs: "sessionCookie",
      }),
      then.assert("only the owning user's token reaches the provider", async (ctx) => {
        const auth = ctx.runtime.objects.auth.singleton();
        const sessionCookie = ctx.vars.sessionCookie as string;
        const session = await auth.http.fetch(
          new Request("https://backoffice.example/api/auth/get-session", {
            headers: { cookie: sessionCookie },
          }),
        );
        const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
          .user.id;
        await auth.commands.applyScenarioFixture({
          members: [{ organizationId: "org-1", userId, roles: ["member"] }],
        });
        const memberCookie = await issueBackofficeAccessCookie(ctx, sessionCookie, "org-1");
        const foreignCookie = await issueBackofficeAccessCookie(
          ctx,
          ctx.vars.foreignSessionCookie as string,
          null,
        );
        const publicScope = `user:${userId}`;
        const accountId = "private-account";
        gateway.authorize(await startConnectorConsent(ctx, userId), accountId);
        expect(await checkConnectorSetup(ctx, userId)).toMatchObject({ status: "ready" });
        const profile = await callPublicProjectConnector(
          ctx,
          publicScope,
          `/accounts/${accountId}/profile`,
          "GET",
          foreignCookie,
        );
        assert(profile.status === 403, await profile.clone().text());
        for (const suffix of ["", "/"]) {
          const denied = await callPublicProjectConnector(
            ctx,
            publicScope,
            `/accounts/${accountId}/actions/gmail.search_threads${suffix}`,
            "POST",
            foreignCookie,
            { input: { query: "is:unread" } },
          );
          assert(denied.status === 403);
        }
        expect(gateway.executions).toEqual([]);
        const executed = await callPublicProjectConnector(
          ctx,
          publicScope,
          `/accounts/${accountId}/actions/gmail.search_threads`,
          "POST",
          memberCookie,
          { input: { query: "is:unread" } },
        );
        assert(executed.status === 200, await executed.clone().text());
        expect(await executed.json()).toMatchObject({
          actionId: "gmail.search_threads",
          output: { query: "is:unread" },
        });
        expect(gateway.executions.map((execution) => execution.connectedAccountId)).toEqual([
          accountId,
        ]);
      }),
    ],
  }));
});

test("public routes authenticate access tokens and reject foreign or non-user scopes", async () => {
  await runProjectConnectorScenario((gateway) => ({
    objects: scenarioObjects,
    name: "Connector enforces authenticated user routing",
    env: { DOCS_PUBLIC_BASE_URL: "https://backoffice.example" },
    fakes: ({ fake }) => ({ resend: fake.resend() }),
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
      // Public routes reach only users Auth knows.
      given.auth.user({ id: "another-user" }),
    ],
    steps: ({ when, then }) => [
      when.auth.signUp({
        email: "connector-user@example.test",
        captureSessionCookieAs: "sessionCookie",
      }),
      then.assert(
        "signed token scope, not request headers or bodies, owns connections",
        async (ctx) => {
          const auth = ctx.runtime.objects.auth.singleton().http;
          const sessionCookie = ctx.vars.sessionCookie as string;
          const session = await auth.fetch(
            new Request("https://backoffice.example/api/auth/get-session", {
              headers: { cookie: sessionCookie },
            }),
          );
          const userId = z
            .object({ user: z.object({ id: z.string() }) })
            .parse(await session.json()).user.id;
          const accessCookie = await issueBackofficeAccessCookie(ctx, sessionCookie, null);
          const scope = `user:${userId}`;
          const anonymous = await callPublicProjectConnector(ctx, scope, "/accounts", "GET", null);
          assert(anonymous.status === 401);
          const owned = await callPublicProjectConnector(
            ctx,
            scope,
            "/accounts",
            "GET",
            accessCookie,
          );
          assert(owned.status === 200, await owned.clone().text());
          expect(await owned.json()).toMatchObject({ accounts: [] });
          const foreignUser = await callPublicProjectConnector(
            ctx,
            "user:another-user",
            "/accounts",
            "GET",
            accessCookie,
          );
          assert(foreignUser.status === 403);
          const foreignOrg = await callPublicProjectConnector(
            ctx,
            "org:ada-labs",
            "/accounts",
            "GET",
            accessCookie,
          );
          assert(foreignOrg.status === 404);
          const callback = `https://backoffice.example/api/connector/${encodeURIComponent(scope)}/oauth/callback`;
          const returnUri = `${callback}/${encodeConnectorConnectionId(["named", "project-1", "gmail-provider", "personal"]).slice("connector#".length)}`;
          const started = await callPublicProjectConnector(
            ctx,
            scope,
            "/connection-requests?scope=user:forged-user",
            "POST",
            accessCookie,
            { service: "gmail", connectionName: "personal", returnUri },
          );
          assert(started.ok, await started.clone().text());
          const connection = projectConnectorConnectionSchema.parse(await started.json());
          expect(connection.externalUserId).toBe(scope);
          expect(gateway.links).toMatchObject([{ userId: scope, returnUri }]);
          const injectedIdentity = await callPublicProjectConnector(
            ctx,
            scope,
            "/connection-requests",
            "POST",
            accessCookie,
            {
              service: "gmail",
              connectionName: "personal",
              returnUri,
              externalUserId: "forged-user",
            },
          );
          assert(injectedIdentity.status === 400);
          const injectedReturn = await callPublicProjectConnector(
            ctx,
            scope,
            "/connection-requests",
            "POST",
            accessCookie,
            {
              service: "gmail",
              connectionName: "personal",
              returnUri: "https://attacker.example/oauth/callback",
            },
          );
          assert(injectedReturn.status === 400);
          // Every return must name a connection, so the bare callback is not a return URL.
          for (const unnamed of [callback, `${callback}/n_forged`]) {
            const rejected = await callPublicProjectConnector(
              ctx,
              scope,
              "/connection-requests",
              "POST",
              accessCookie,
              { service: "gmail", connectionName: "personal", returnUri: unnamed },
            );
            assert(rejected.status === 400);
          }
          expect(gateway.links).toHaveLength(1);
          gateway.authorize(connection.id, "personal-account");
          const refreshed = await callPublicProjectConnector(
            ctx,
            scope,
            `/connection-requests/${connection.id}/refresh`,
            "POST",
            accessCookie,
          );
          assert(refreshed.status === 200);
          expect(await refreshed.json()).toMatchObject({
            state: { status: "connected", connectedAccountId: "personal-account" },
          });
          const profile = await callPublicProjectConnector(
            ctx,
            scope,
            "/accounts/personal-account/profile",
            "GET",
            accessCookie,
          );
          assert(profile.status === 200);
          expect(await profile.json()).toMatchObject({
            externalUserId: scope,
            profile: { email: "gmail-user@example.test" },
          });
          expect(gateway.executions).toEqual([]);
        },
      ),
    ],
  }));
});

test("a signed-in owner's return confirms the consent its path names and lands on that connection", async () => {
  await runProjectConnectorScenario((gateway) => ({
    objects: scenarioObjects,
    name: "Connector returns confirm the named consent",
    env: { DOCS_PUBLIC_BASE_URL: "https://backoffice.example" },
    fakes: ({ fake }) => ({ resend: fake.resend() }),
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ when, then }) => [
      when.auth.signUp({
        email: "connector-return@example.test",
        captureSessionCookieAs: "sessionCookie",
      }),
      then.assert("each return confirms only its own connection's consent", async (ctx) => {
        const sessionCookie = ctx.vars.sessionCookie as string;
        const session = await ctx.runtime.objects.auth.singleton().http.fetch(
          new Request("https://backoffice.example/api/auth/get-session", {
            headers: { cookie: sessionCookie },
          }),
        );
        const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
          .user.id;
        const accessCookie = await issueBackofficeAccessCookie(ctx, sessionCookie, null);
        const scope = `user:${userId}`;
        const scopePath = `/backoffice/integrations/user/${userId}`;
        const mount = `/api/connector/${encodeURIComponent(scope)}`;
        /** Follows a return as the gateway sends it: the start's return URL plus its own query. */
        async function returnFromProvider(returnUri: string, cookie: string | null = accessCookie) {
          const { pathname } = new URL(returnUri);
          assert(pathname.startsWith(mount));
          const reads = gateway.control.requestReads;
          const response = await callPublicProjectConnector(
            ctx,
            scope,
            `${pathname.slice(mount.length)}?status=success&connectedAccountId=forged-account`,
            "GET",
            cookie,
          );
          assert(response.status === 302);
          const location = new URL(response.headers.get("location") ?? "");
          return {
            path: decodeURIComponent(location.pathname),
            oauth: location.searchParams.get("oauth"),
            message: location.searchParams.get("message"),
            gatewayReads: gateway.control.requestReads - reads,
          };
        }
        async function start(connectionName: string) {
          const progress = integrationSetupProgressSchema.parse(
            await runUserIntegrations(
              ctx,
              userId,
              `setup({ kind: "input", connectionId: ${JSON.stringify(workConnectionId)}, input: { start: true, connectionName: ${JSON.stringify(connectionName)} } })`,
            ),
          );
          assert(progress.status === "needs-authorization");
          const requestId = new URL(progress.authorizationUrl).pathname.split("/").at(-1);
          const link = gateway.links.at(-1);
          assert(requestId && link);
          return { connectionId: progress.connectionId, requestId, returnUri: link.returnUri };
        }

        const work = await start("work");
        expect(work.returnUri).toBe(
          `https://backoffice.example${mount}/oauth/callback/${workConnectionId.slice("connector#".length)}`,
        );
        // Another name's pending consent is never read by this name's return.
        const other = await start("other");

        // Pending consent, and anonymous returns, only navigate to the named connection.
        gateway.authorize(work.requestId, "returned-account");
        expect(await returnFromProvider(work.returnUri, null)).toEqual({
          path: `${scopePath}/${workConnectionId}`,
          oauth: "returned",
          message: null,
          gatewayReads: 0,
        });
        expect(await returnFromProvider(other.returnUri)).toEqual({
          path: `${scopePath}/${other.connectionId}`,
          oauth: "returned",
          message: null,
          gatewayReads: 1,
        });
        expect(await listConnectionIds(ctx, userId)).toEqual([]);

        // The bare callback of links issued before returns named connections only navigates.
        expect(
          await returnFromProvider(`https://backoffice.example${mount}/oauth/callback`),
        ).toEqual({
          path: scopePath,
          oauth: "returned",
          message: null,
          gatewayReads: 0,
        });
        // So does a segment that names no connection.
        expect(
          await returnFromProvider(`https://backoffice.example${mount}/oauth/callback/n_forged`),
        ).toEqual({ path: scopePath, oauth: "returned", message: null, gatewayReads: 0 });

        expect(await returnFromProvider(work.returnUri)).toEqual({
          path: `${scopePath}/${workConnectionId}`,
          oauth: "success",
          message: null,
          gatewayReads: 1,
        });
        expect(await listConnectionIds(ctx, userId)).toEqual([workConnectionId]);

        const personal = await start("personal");
        const personalRequest = gateway.requests.get(personal.requestId);
        assert(personalRequest);
        personalRequest.status = "failed";
        personalRequest.errorMessage = "Consent was rejected";
        expect(await returnFromProvider(personal.returnUri)).toEqual({
          path: `${scopePath}/${personal.connectionId}`,
          oauth: "error",
          message: "Consent was rejected",
          gatewayReads: 1,
        });

        // A confirmation that fails reports an error, never a request to finish authorizing.
        const otherRequest = gateway.requests.get(other.requestId);
        assert(otherRequest);
        otherRequest.alias = "mismatched";
        expect(await returnFromProvider(other.returnUri)).toMatchObject({
          path: `${scopePath}/${other.connectionId}`,
          oauth: "error",
          message: "Backoffice could not confirm this connection. Check its setup again.",
        });
        // A request the gateway no longer knows has expired.
        gateway.requests.delete(other.requestId);
        expect(await returnFromProvider(other.returnUri)).toMatchObject({
          path: `${scopePath}/${other.connectionId}`,
          oauth: "error",
          message: "The authorization link expired.",
        });
        expect(await listConnectionIds(ctx, userId)).toEqual([workConnectionId]);
      }),
    ],
  }));
});
