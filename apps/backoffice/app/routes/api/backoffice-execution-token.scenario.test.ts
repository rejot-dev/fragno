import { assert, describe, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { backofficeApiRouter } from "@/backoffice-api/backoffice-api-router";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import { LEYWAY_MCP_PATH } from "@/fragno/auth/mcp-oauth";
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

import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { OtpObject } from "../../../workers/otp-object";
import { UploadObject } from "../../../workers/upload-object";
import { action } from "./backoffice-execution-token";

const scenarioObjects = {
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const wholeOrganization = { kind: "owner" } as const;

const origin = "https://backoffice.example";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

/** The signed-up user's session, captured by the scenario's sign-up step. */
function sessionCookie({ vars }: BackofficeScenarioContext): string {
  assert(typeof vars.session === "string");
  return vars.session;
}

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

function mcpGatewayFetch(ctx: BackofficeScenarioContext, request: Request) {
  const runtime = ctx.runtime.services;
  return backofficeApiRouter.fetch(request, { runtime, kernel: new BackofficeKernel(runtime) });
}

async function runExecutionTokenScenario(check: (ctx: BackofficeScenarioContext) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-execution-token-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "shared OAuth execution token exchange",
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "execution-user@example.test",
            captureSessionCookieAs: "session",
          }),
          when.auth.createOrganization({ cookie: sessionCookie, name: "Acme", slug: "acme" }),
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
  const config = await auth.getLeywayCliOAuthConfig({ requestUrl: origin });
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
      const scope = { kind: "org" as const, orgId: organization.id, jurisdiction: null };
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
        requireBackofficeContext(request, context, {
          kind: "org",
          orgId: "another-org",
          jurisdiction: null,
        }),
      ).rejects.toThrow("Credential scope");
      const defaults = await requestExecutionToken(ctx, exchangeRequest(token, null));
      assert.equal(defaults.status, 200);
      expect(backofficeExecutionTokenResultSchema.parse(await defaults.json()).scope).toEqual(
        scope,
      );
    });
  });

  test("a remote MCP client discovers OAuth, gets browser approval, and starts in the personal workspace", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { token, user, organization } = await authorizeFirstPartyClient(ctx);
      const endpoint = new URL(LEYWAY_MCP_PATH, origin);
      const wrongAudience = await mcpGatewayFetch(
        ctx,
        new Request(endpoint, { headers: { authorization: `Bearer ${token}` } }),
      );
      assert.equal(wrongAudience.status, 401);
      assert.match(wrongAudience.headers.get("www-authenticate") ?? "", /resource_metadata=/u);

      const redirectUri = "http://127.0.0.1:48526/callback";
      const disallowedRegistration = await ctx.runtime.objects.auth.singleton().http.fetch(
        new Request(new URL("/api/auth/oauth2/register", origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
            scope: "backoffice",
          }),
        }),
      );
      assert.equal(disallowedRegistration.status, 400);
      expect(await disallowedRegistration.json()).toMatchObject({ error: "invalid_scope" });
      const flow: { authorization: URL | null } = { authorization: null };
      let clientInformation: StoredOAuthClientInformation | undefined;
      let tokens: StoredOAuthTokens | undefined;
      let codeVerifier = "";
      const authProvider: OAuthClientProvider = {
        redirectUrl: redirectUri,
        clientMetadata: {
          client_name: "Scenario MCP client",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        clientInformation: () => clientInformation,
        saveClientInformation: (value) => {
          clientInformation = value;
        },
        tokens: () => tokens,
        saveTokens: (value) => {
          tokens = value;
        },
        redirectToAuthorization: (url) => {
          flow.authorization = url;
        },
        state: () => "scenario-mcp-state",
        codeVerifier: () => codeVerifier,
        saveCodeVerifier: (value) => {
          codeVerifier = value;
        },
      };
      const client = new Client(
        { name: "leyway-mcp-test", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      function createTransport() {
        return new StreamableHTTPClientTransport(endpoint, {
          authProvider,
          fetch: async (url, init) => {
            const request = new Request(url, init);
            return new URL(request.url).pathname.startsWith("/api/auth/")
              ? await ctx.runtime.objects.auth.singleton().http.fetch(request)
              : await mcpGatewayFetch(ctx, request);
          },
        });
      }
      const transport = createTransport();

      try {
        await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
        const authorization = flow.authorization;
        assert(authorization);
        assert.equal(authorization.searchParams.get("resource"), endpoint.href);
        assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
        const authorize = await ctx.runtime.objects.auth
          .singleton()
          .http.fetch(new Request(authorization, { headers: { cookie: sessionCookie(ctx) } }));
        assert.equal(authorize.status, 302, await authorize.clone().text());
        const consentLocation = authorize.headers.get("location");
        assert(consentLocation);
        assert.equal(new URL(consentLocation, origin).pathname, "/backoffice/oauth/consent");
        const approved = await authRequest(ctx, "/oauth2/consent", {
          accept: true,
          oauth_query: new URL(consentLocation, origin).search.slice(1),
        });
        assert(approved.ok, await approved.clone().text());
        const callback = new URL(z.object({ url: z.url() }).parse(await approved.json()).url);
        assert.equal(callback.searchParams.get("state"), "scenario-mcp-state");
        await transport.finishAuth(callback.searchParams);
        assert(tokens?.refresh_token);
        await transport.close();
        await client.connect(createTransport());

        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map(({ name }) => name),
          ["codemode"],
        );
        const { resources } = await client.listResources();
        assert.deepEqual(
          resources.map(({ uri }) => uri),
          ["leyway://codemode/SYSTEM.md"],
        );
        expect(await client.readResource({ uri: resources[0].uri })).toMatchObject({
          contents: [{ mimeType: "text/markdown", text: expect.stringContaining("Codemode") }],
        });
        const code = `async () => ({
          current: await context.getCurrentScope(),
          organization: (await context.org(${JSON.stringify(organization.id)}).org.get()).organization,
        })`;
        const input = { name: "codemode", arguments: { code } };
        const result = z
          .object({ content: z.array(z.object({ text: z.string() })) })
          .parse(await client.callTool(input));
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          ok: true,
          result: {
            current: { kind: "user", userId: user.id },
            organization: { organizationId: organization.id },
          },
        });
        expect(
          await client.callTool({ ...input, arguments: { code, scope: organization.id } }),
        ).toMatchObject({ isError: true });

        await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
          removedMembers: [{ organizationId: organization.id, userId: user.id }],
        });
        expect(await client.callTool(input)).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("Permission denied") }],
        });

        const clientId = clientInformation?.client_id;
        assert(clientId);
        const revoked = await authRequest(ctx, "/backoffice/oauth/revoke-consent", { clientId });
        assert(revoked.ok, await revoked.clone().text());
        const revokedToken = await mcpGatewayFetch(
          ctx,
          new Request(endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
        );
        assert.equal(revokedToken.status, 401);
      } finally {
        await client.close();
      }
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
        .commands.getLeywayCliOAuthConfig({ requestUrl: origin });
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
        client_name: "Leyway CLI",
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
      const scope = { kind: "org" as const, orgId: organization.id, jurisdiction: null };
      const unregistered = await requestExecutionToken(ctx, exchangeRequest(token, scope));
      assert.equal(unregistered.status, 401);
      expect(await unregistered.json()).toMatchObject({ error: "authentication_failed" });

      const requestedPermissions = [{ namespace: "events" as const, permission: "emit" as const }];
      const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
        actions: { kind: "none" },
        trust: { kind: "third-party" },
        slug: "accounting",
        oauthClientId: client.client_id,
        requestedPermissions,
      });
      assert(registered.ok);
      const notInstalled = await requestExecutionToken(ctx, exchangeRequest(token, scope));
      assert.equal(notInstalled.status, 403);
      expect(await notInstalled.json()).toMatchObject({ error: "scope_unavailable" });
      const installed = await ctx.runtime.objects.appInstallations
        .for({ kind: "org", orgId: organization.id, jurisdiction: null })
        .commands.installApp({
          actionsRevision: 1,
          appId: registered.value.appId,
          grantedPermissions: requestedPermissions,
          installedByUserId: user.id,
          resourceScope: wholeOrganization,
        });
      assert(installed.ok);
      for (const unavailableScope of [
        null,
        { kind: "system" },
        { kind: "user", userId: user.id, jurisdiction: null },
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
      const config = await auth.commands.getLeywayCliOAuthConfig({ requestUrl: origin });
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
      const removed = await requestExecutionToken(
        ctx,
        exchangeRequest(token, { kind: "org", orgId: organization.id, jurisdiction: null }),
      );
      assert.equal(removed.status, 403);
      expect(await removed.json()).toMatchObject({ error: "scope_unavailable" });
      const withoutOrganization = await requestExecutionToken(ctx, exchangeRequest(token, null));
      assert.equal(withoutOrganization.status, 200);
      expect(
        backofficeExecutionTokenResultSchema.parse(await withoutOrganization.json()).scope,
      ).toEqual({ kind: "user", userId: user.id, jurisdiction: null });
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
