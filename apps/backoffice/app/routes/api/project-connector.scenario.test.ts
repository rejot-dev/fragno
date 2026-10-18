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

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryProjectConnectorObject } from "../../../workers/project-connector.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { action, loader } from "./project-connector";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
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
    scope: { kind: "org", orgId: "org-1" },
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
    ],
    steps: ({ then }) => [
      then.assert(
        "forged success returns navigate without gateway verification or account writes",
        async (ctx) => {
          const callbackOnlyUser = {
            binding: "PROJECT_CONNECTOR" as const,
            scope: { kind: "user" as const, userId: "callback-only-user" },
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
          const returnUri = `https://backoffice.example/api/connector/${encodeURIComponent(scope)}/oauth/callback`;
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
