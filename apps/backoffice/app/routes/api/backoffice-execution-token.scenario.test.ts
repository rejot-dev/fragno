import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  authorizeBackofficeCodemodeContext,
  requireBackofficeContext,
} from "@/fragno/auth/backoffice-principal.server";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import {
  BACKOFFICE_JWT_LIFETIME_SECONDS,
  verifyBackofficeJwt,
} from "@/fragno/auth/token-lifecycle";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { action } from "./backoffice-execution-token";

const wholeOrganization = { kind: "organization" } as const;

const origin = "https://backoffice.example";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

function routerContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

function authRequest(
  ctx: BackofficeScenarioContext,
  pathname: string,
  body: URLSearchParams | Record<string, unknown> | null,
) {
  const cookie = ctx.vars.session;
  assert(typeof cookie === "string");
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth${pathname}`, {
      method: body === null ? "GET" : "POST",
      headers: {
        origin,
        cookie,
        ...(body === null
          ? {}
          : {
              "content-type":
                body instanceof URLSearchParams
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            }),
      },
      body:
        body === null ? undefined : body instanceof URLSearchParams ? body : JSON.stringify(body),
    }),
  );
}

async function authorizeOAuthDevice(
  ctx: BackofficeScenarioContext,
  input: { clientId: string; scopes: string },
): Promise<string> {
  const deviceResponse = await authRequest(
    ctx,
    "/device/code",
    new URLSearchParams({
      client_id: input.clientId,
      scope: input.scopes,
      resource: origin,
    }),
  );
  assert(deviceResponse.ok, await deviceResponse.clone().text());
  const device = z
    .object({ user_code: z.string(), device_code: z.string() })
    .parse(await deviceResponse.json());
  const claim = await authRequest(
    ctx,
    `/device?user_code=${encodeURIComponent(device.user_code)}`,
    null,
  );
  assert(claim.ok, await claim.clone().text());
  const approval = await authRequest(ctx, "/device/approve", { userCode: device.user_code });
  assert(approval.ok, await approval.clone().text());
  const response = await authRequest(
    ctx,
    "/oauth2/token",
    new URLSearchParams({
      grant_type: deviceGrant,
      device_code: device.device_code,
      client_id: input.clientId,
      resource: origin,
    }),
  );
  assert(response.ok, await response.clone().text());
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

async function requestExecutionToken(
  ctx: BackofficeScenarioContext,
  input: { authorization: string | null; body: string; origin: string },
) {
  const request = new Request(`${input.origin}/api/backoffice/execution-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.authorization === null ? {} : { authorization: input.authorization }),
    },
    body: input.body,
  });
  return await action({
    request,
    context: routerContext(ctx, request),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/execution-token",
  });
}

async function runExecutionTokenScenario(check: (ctx: BackofficeScenarioContext) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-execution-token-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "shared OAuth execution token exchange",
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "execution-user@example.test",
            captureSessionCookieAs: "session",
          }),
          then.assert(
            "the real OAuth, Auth, route, and kernel boundaries enforce execution policy",
            check,
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function authorizeFirstPartyClient(ctx: BackofficeScenarioContext) {
  const auth = ctx.runtime.objects.auth.singleton().commands;
  const config = await auth.getBackofficeCliOAuthConfig({ requestUrl: origin });
  const token = await authorizeOAuthDevice(ctx, {
    clientId: config.clientId,
    scopes: config.scope,
  });
  const session = await authRequest(ctx, "/get-session", null);
  assert(session.ok, await session.clone().text());
  const { user } = z
    .object({ user: z.object({ id: z.string(), email: z.email() }) })
    .parse(await session.json());
  const organization = (await auth.getAllOrganizations())[0];
  assert(organization);
  return { token, user, organization };
}

function exchangeRequest(token: string, scope: unknown) {
  return { authorization: `Bearer ${token}`, body: JSON.stringify({ scope }), origin };
}

describe("Backoffice execution token SQLite scenarios", () => {
  test("first-party exchange preserves scope ceilings and leaves Codemode restrictions at its entry point", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { token, user, organization } = await authorizeFirstPartyClient(ctx);
      const scope = { kind: "org" as const, orgId: organization.id };
      const response = await requestExecutionToken(ctx, exchangeRequest(token, scope));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = backofficeExecutionTokenResultSchema.parse(await response.json());
      expect(result.scope).toEqual(scope);
      const verified = await verifyBackofficeJwt(
        result.accessToken,
        origin,
        ctx.runtime.objects.auth.singleton().http,
      );
      assert(verified.ok);
      expect(verified.payload).toMatchObject({
        sub: user.id,
        globalRole: "user",
        scopeRestriction: scope,
        organization: { id: organization.id },
      });
      assert.equal(verified.payload.exp - verified.payload.iat, BACKOFFICE_JWT_LIFETIME_SECONDS);

      const request = new Request(`${origin}/api/backoffice/codemode/org/${organization.id}`, {
        headers: { authorization: `Bearer ${result.accessToken}` },
      });
      const context = routerContext(ctx, request);
      const execution = await requireBackofficeContext(request, context, scope);
      assert.equal(execution.actors.principal?.id, user.id);
      await expect(
        requireBackofficeContext(request, context, { kind: "org", orgId: "another-org" }),
      ).rejects.toThrow("Credential scope");
      const codemode = await authorizeBackofficeCodemodeContext(request, context, scope);
      assert(!codemode.ok);
      assert.equal(codemode.response.status, 403);
      assert.equal(
        await codemode.response.text(),
        "Backoffice codemode requires a @rejot.dev account.",
      );

      const defaults = await requestExecutionToken(ctx, exchangeRequest(token, null));
      assert.equal(defaults.status, 200);
      expect(backofficeExecutionTokenResultSchema.parse(await defaults.json()).scope).toEqual(
        scope,
      );
    });
  });

  test("malformed credentials and forged principal or policy fields fail at the route and RPC boundaries", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      for (const authorization of [null, "Basic credential", "Bearer", "Bearer token with-space"]) {
        const response = await requestExecutionToken(ctx, {
          authorization,
          body: JSON.stringify({ scope: null }),
          origin,
        });
        assert.equal(response.status, 401);
      }
      for (const body of [
        "not-json",
        "{}",
        JSON.stringify({ scope: "system" }),
        JSON.stringify({ scope: null, userId: "another-user" }),
        JSON.stringify({ scope: null, policy: "first-party-user" }),
      ]) {
        const response = await requestExecutionToken(ctx, {
          authorization: "Bearer invalid-token",
          body,
          origin,
        });
        assert.equal(response.status, 400);
        expect(await response.json()).toMatchObject({ error: "invalid_request" });
      }
      const invalid = await requestExecutionToken(ctx, exchangeRequest("invalid-token", null));
      assert.equal(invalid.status, 401);
      expect(await invalid.json()).toMatchObject({ error: "authentication_failed" });
      const auth = ctx.runtime.objects.auth.singleton().commands;
      await expect(
        auth.exchangeBackofficeExecutionToken({
          requestUrl: origin,
          oauthAccessToken: "invalid-token",
          scope: null,
          policy: "first-party-user",
        } as never),
      ).rejects.toThrow();
    });
  });

  test("OAuth proof must have the Backoffice audience, required scope, and an authentic signature", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { token } = await authorizeFirstPartyClient(ctx);
      const wrongAudience = await requestExecutionToken(ctx, {
        ...exchangeRequest(token, null),
        origin: "https://another-backoffice.example",
      });
      assert.equal(wrongAudience.status, 401);
      const tampered = await requestExecutionToken(
        ctx,
        exchangeRequest(`${token.slice(0, -3)}bad`, null),
      );
      assert.equal(tampered.status, 401);
      const config = await ctx.runtime.objects.auth
        .singleton()
        .commands.getBackofficeCliOAuthConfig({ requestUrl: origin });
      const identityOnly = await authorizeOAuthDevice(ctx, {
        clientId: config.clientId,
        scopes: "openid offline_access",
      });
      const missingScope = await requestExecutionToken(ctx, exchangeRequest(identityOnly, null));
      assert.equal(missingScope.status, 401);
      const rawTokenRequest = new Request(`${origin}/api/http`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await expect(
        requireBackofficeContext(rawTokenRequest, routerContext(ctx, rawTokenRequest), {
          kind: "system",
        }),
      ).rejects.toBeInstanceOf(Response);
    });
  });

  test("external apps receive only app-bound credentials, even when claiming first-party metadata for an administrator", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { user, organization } = await authorizeFirstPartyClient(ctx);
      const auth = ctx.runtime.objects.auth.singleton().commands;
      await auth.applyScenarioFixture({
        users: [{ id: user.id, email: user.email, role: "admin", status: "active" }],
      });
      const created = await authRequest(ctx, "/oauth2/create-client", {
        client_name: "Fragno Backoffice Codemode",
        software_id: "fragno-backoffice-codemode",
        scope: "openid offline_access backoffice",
        token_endpoint_auth_method: "none",
        application_type: "native",
        grant_types: [deviceGrant, "refresh_token"],
      });
      assert(created.ok, await created.clone().text());
      const client = z.object({ client_id: z.string() }).parse(await created.json());
      const token = await authorizeOAuthDevice(ctx, {
        clientId: client.client_id,
        scopes: "openid offline_access backoffice",
      });
      const scope = { kind: "org" as const, orgId: organization.id };
      const unregistered = await requestExecutionToken(ctx, exchangeRequest(token, scope));
      assert.equal(unregistered.status, 401);
      expect(await unregistered.json()).toMatchObject({ error: "authentication_failed" });

      const requestedPermissions = [{ namespace: "events" as const, permission: "emit" as const }];
      const registered = await ctx.runtime.objects.apps
        .singleton()
        .commands.registerApp({ oauthClientId: client.client_id, requestedPermissions });
      assert(registered.ok);
      const notInstalled = await requestExecutionToken(ctx, exchangeRequest(token, scope));
      assert.equal(notInstalled.status, 403);
      expect(await notInstalled.json()).toMatchObject({ error: "scope_unavailable" });
      const installed = await ctx.runtime.objects.appInstallations
        .forOrg(organization.id)
        .commands.installApp({
          appId: registered.value.appId,
          grantedPermissions: requestedPermissions,
          installedByUserId: user.id,
          resourceScope: wholeOrganization,
        });
      assert(installed.ok);
      for (const unavailableScope of [
        null,
        { kind: "system" },
        { kind: "user", userId: user.id },
      ]) {
        const response = await requestExecutionToken(ctx, exchangeRequest(token, unavailableScope));
        assert.equal(response.status, 403);
        expect(await response.json()).toMatchObject({ error: "scope_unavailable" });
      }

      const response = await requestExecutionToken(ctx, exchangeRequest(token, scope));
      assert.equal(response.status, 200, await response.clone().text());
      const result = backofficeExecutionTokenResultSchema.parse(await response.json());
      expect(result.scope).toEqual(scope);
      const httpAuth = ctx.runtime.objects.auth.singleton().http;
      const asUserCredential = await verifyBackofficeJwt(result.accessToken, origin, httpAuth);
      expect(asUserCredential).toEqual({ ok: false, reason: "invalid" });
      const request = new Request(`${origin}/api/backoffice/codemode/org/${organization.id}`, {
        headers: { authorization: `Bearer ${result.accessToken}` },
      });
      await expect(
        requireBackofficeContext(request, routerContext(ctx, request), scope),
      ).rejects.toBeInstanceOf(Response);
    });
  });

  test("concurrent first OAuth requests for a new origin share one resource initialization", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const freshOrigin = "https://fresh.backoffice.example";
      const auth = ctx.runtime.objects.auth.singleton();
      const config = await auth.commands.getBackofficeCliOAuthConfig({ requestUrl: origin });
      const responses = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          auth.http.fetch(
            new Request(`${freshOrigin}/api/auth/device/code`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: config.clientId,
                scope: config.scope,
                resource: freshOrigin,
              }),
            }),
          ),
        ),
      );
      for (const response of responses) {
        assert(
          response.status === "fulfilled",
          String(response.status === "rejected" && response.reason),
        );
        assert.equal(response.value.status, 200, await response.value.clone().text());
      }
    });
  });

  test("existing OAuth tokens do not preserve revoked user roles or organization membership at exchange", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { token, user, organization } = await authorizeFirstPartyClient(ctx);
      const auth = ctx.runtime.objects.auth.singleton().commands;
      const unavailable = await requestExecutionToken(
        ctx,
        exchangeRequest(token, { kind: "system" }),
      );
      assert.equal(unavailable.status, 403);
      await auth.applyScenarioFixture({
        users: [{ id: user.id, email: user.email, role: "admin", status: "active" }],
      });
      const administrator = await requestExecutionToken(
        ctx,
        exchangeRequest(token, { kind: "system" }),
      );
      assert.equal(administrator.status, 200);
      expect(backofficeExecutionTokenResultSchema.parse(await administrator.json()).scope).toEqual({
        kind: "system",
      });
      await auth.applyScenarioFixture({
        users: [{ id: user.id, email: user.email, role: "user", status: "active" }],
      });
      const demoted = await requestExecutionToken(ctx, exchangeRequest(token, { kind: "system" }));
      assert.equal(demoted.status, 403);
      await auth.applyScenarioFixture({
        removedMembers: [{ organizationId: organization.id, userId: user.id }],
      });
      for (const scope of [{ kind: "org", orgId: organization.id }, null]) {
        const response = await requestExecutionToken(ctx, exchangeRequest(token, scope));
        assert.equal(response.status, 403);
        expect(await response.json()).toMatchObject({ error: "scope_unavailable" });
      }
      await auth.applyScenarioFixture({
        users: [{ id: user.id, email: user.email, role: "user", status: "banned" }],
      });
      const banned = await requestExecutionToken(
        ctx,
        exchangeRequest(token, { kind: "user", userId: user.id }),
      );
      assert.equal(banned.status, 403);
    });
  });
});
