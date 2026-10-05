import { assert, expect, test, vi } from "vitest";

import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { projectConnectorConnectionSchema } from "@fragno-dev/project-connector-fragment/contracts";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeScenarioContext } from "@/fragno/automation/scenario";
import { runProjectConnectorScenario } from "@/fragno/runtime-tools/families/project-connector-scenario.test-utils";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { action, loader } from "./project-connector";

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
      body: JSON.stringify({ selection: "preferred", organizationId }),
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
    name: "Connector callback query parameters are navigation only",
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ when, then }) => [
      when.codemode.run({
        scope: { kind: "org", orgId: "org-1" },
        label: "start provider OAuth",
        code: 'async () => await context.user("user-1").connector.connect({ service: "gmail", connectionName: "work" })',
      }),
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
              "https://backoffice.example/backoffice/connections/connector/return/user%3Acallback-only-user",
          );
          assert(!ctx.runtime.hasObjectInstance(callbackOnlyUser));

          const connection = projectConnectorConnectionSchema.parse(
            ctx.codemodeRuns.at(-1)?.result.result,
          );
          const callback = await callPublicProjectConnector(
            ctx,
            "user:user-1",
            `/oauth/callback?status=success&connection_request_id=${connection.id}&connected_account_id=forged-account&user_id=forged-user`,
            "GET",
            null,
          );
          assert(callback.status === 302);
          assert(
            callback.headers.get("location") ===
              "https://backoffice.example/backoffice/connections/connector/return/user%3Auser-1",
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
          const before = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "list before gateway confirmation",
            code: 'async () => await context.user("user-1").connector.listAccounts()',
          });
          expect(before.result).toMatchObject({ accounts: [] });
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
            `/connection-requests/${connection.id}/refresh`,
            "POST",
            null,
          );
          assert(anonymousRefresh.status === 401);
          gateway.authorize(connection.id, "verified-account");
          await callPublicProjectConnector(
            ctx,
            "user:user-1",
            "/oauth/callback?status=success&connected_account_id=forged-account",
            "GET",
            null,
          );
          const afterReturn = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "callback still did not persist",
            code: 'async () => await context.user("user-1").connector.listAccounts()',
          });
          expect(afterReturn.result).toMatchObject({ accounts: [] });
          const verified = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "perform authorized gateway refresh",
            code: `async () => { const connector = context.user("user-1").connector; return { connection: await connector.refreshConnection({ requestId: ${JSON.stringify(connection.id)} }), accounts: await connector.listAccounts() }; }`,
          });
          expect(verified.result).toMatchObject({
            connection: { state: { status: "connected", connectedAccountId: "verified-account" } },
            accounts: { accounts: [{ id: "verified-account" }] },
          });
        },
      ),
    ],
  }));
});

test("public action requests enforce verified execution permissions before contacting a user's provider", async () => {
  await runProjectConnectorScenario((gateway) => ({
    name: "Connector public actions cannot bypass kernel permissions",
    env: { DOCS_PUBLIC_BASE_URL: "https://backoffice.example" },
    fakes: ({ fake }) => ({ resend: fake.resend() }),
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ when, then }) => [
      when.auth.signUp({
        email: "connector-member@example.test",
        captureSessionCookieAs: "sessionCookie",
      }),
      then.assert("scope access alone never authorizes provider execution", async (ctx) => {
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
        const scopes = [
          {
            publicScope: `user:${userId}`,
            provider: `context.user(${JSON.stringify(userId)}).connector`,
            accountId: "private-account",
          },
        ];
        for (const scope of scopes) {
          const started = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: `start consent for ${scope.accountId}`,
            code: `async () => await ${scope.provider}.connect({ service: "gmail", connectionName: "work" })`,
          });
          const connection = projectConnectorConnectionSchema.parse(started.result);
          gateway.authorize(connection.id, scope.accountId);
          await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: `verify ${scope.accountId}`,
            code: `async () => await ${scope.provider}.refreshConnection({ requestId: ${JSON.stringify(connection.id)} })`,
          });
          const profile = await callPublicProjectConnector(
            ctx,
            scope.publicScope,
            `/accounts/${scope.accountId}/profile`,
            "GET",
            memberCookie,
          );
          assert(profile.status === 403, await profile.clone().text());
          for (const suffix of ["", "/"]) {
            const denied = await callPublicProjectConnector(
              ctx,
              scope.publicScope,
              `/accounts/${scope.accountId}/actions/gmail.search_threads${suffix}`,
              "POST",
              memberCookie,
              { input: { query: "is:unread" } },
            );
            assert(denied.status === 403);
          }
        }
        expect(gateway.executions).toEqual([]);
        await auth.commands.applyScenarioFixture({
          users: [
            { id: userId, email: "connector-member@example.test", role: "admin", status: "active" },
          ],
        });
        const adminCookie = await issueBackofficeAccessCookie(ctx, sessionCookie, "org-1");
        for (const scope of scopes) {
          const staleAuthority = await callPublicProjectConnector(
            ctx,
            scope.publicScope,
            `/accounts/${scope.accountId}/actions/gmail.search_threads`,
            "POST",
            memberCookie,
            { input: {} },
          );
          assert(staleAuthority.status === 403);
          const executed = await callPublicProjectConnector(
            ctx,
            scope.publicScope,
            `/accounts/${scope.accountId}/actions/gmail.search_threads`,
            "POST",
            adminCookie,
            { input: { query: "is:unread" } },
          );
          assert(executed.status === 200);
          expect(await executed.json()).toMatchObject({
            actionId: "gmail.search_threads",
            output: { query: "is:unread" },
          });
        }
        expect(gateway.executions.map((execution) => execution.connectedAccountId)).toEqual([
          "private-account",
        ]);
      }),
    ],
  }));
});

test("public routes authenticate access tokens and reject foreign or non-user scopes", async () => {
  await runProjectConnectorScenario((gateway) => ({
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
          await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
            users: [
              {
                id: userId,
                email: "connector-user@example.test",
                role: "admin",
                status: "active",
              },
            ],
          });
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
