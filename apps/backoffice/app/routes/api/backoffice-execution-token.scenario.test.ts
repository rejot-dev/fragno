import { assert, describe, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  Client,
  DpopSession,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";

import { backofficeApiRouter } from "@/backoffice-api/backoffice-api-router";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import { LEYWAY_MCP_PATH, LEYWAY_MCP_RESOURCE_METADATA_PATH } from "@/fragno/auth/mcp-oauth";
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
const mcpClientRedirectUri = "http://127.0.0.1:48526/callback";
const mcpClientMetadata = {
  client_id: "https://mcp-client.test/oauth/client.json",
  client_name: "Scenario MCP client",
  redirect_uris: [mcpClientRedirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
// Shaped like pi's document: a native client whose loopback callback takes any port.
const piClientMetadata = {
  client_id: "https://pi-client.test/oauth/client.json",
  client_name: "pi",
  application_type: "native",
  redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
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

/**
 * Signs an MCP client in the way MCP clients do: discovery from its first rejected request, browser
 * approval on the consent page, and the callback; then connects it.
 */
async function connectMcpClient(
  ctx: BackofficeScenarioContext,
  input: {
    metadata: OAuthClientMetadata & { client_id: string };
    redirectUri: string;
    dpop: DpopSession | null;
    versionNegotiation: VersionNegotiationOptions;
  },
) {
  const endpoint = new URL(LEYWAY_MCP_PATH, origin);
  const flow: {
    authorization: URL | null;
    tokens: StoredOAuthTokens | undefined;
    clientInformation: StoredOAuthClientInformation | undefined;
    codeVerifier: string;
  } = { authorization: null, tokens: undefined, clientInformation: undefined, codeVerifier: "" };
  const authProvider: OAuthClientProvider = {
    redirectUrl: input.redirectUri,
    clientMetadataUrl: input.metadata.client_id,
    clientMetadata: input.metadata,
    clientInformation: () => flow.clientInformation,
    saveClientInformation: (value) => {
      flow.clientInformation = value;
    },
    tokens: () => flow.tokens,
    saveTokens: (value) => {
      flow.tokens = value;
    },
    redirectToAuthorization: (url) => {
      flow.authorization = url;
    },
    state: () => "scenario-mcp-state",
    codeVerifier: () => flow.codeVerifier,
    saveCodeVerifier: (value) => {
      flow.codeVerifier = value;
    },
    dpop: () => input.dpop ?? undefined,
  };
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
  const client = new Client(
    { name: "leyway-mcp-test", version: "1.0.0" },
    { versionNegotiation: input.versionNegotiation },
  );
  const transport = createTransport();
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  const authorization = flow.authorization;
  assert(authorization);
  assert.equal(authorization.searchParams.get("client_id"), input.metadata.client_id);
  assert.equal(authorization.searchParams.get("resource"), endpoint.href);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const authorize = await ctx.runtime.objects.auth
    .singleton()
    .http.fetch(new Request(authorization, { headers: { cookie: sessionCookie(ctx) } }));
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const consentLocation = authorize.headers.get("location");
  assert(consentLocation);
  assert.equal(new URL(consentLocation, origin).pathname, "/backoffice/oauth/consent");
  const oauthQuery = new URL(consentLocation, origin).search.slice(1);
  // What the consent page shows the person before they approve.
  const review = await authRequest(ctx, "/backoffice/oauth/consent-details", {
    oauth_query: oauthQuery,
  });
  assert(review.ok, await review.clone().text());
  expect(await review.json()).toMatchObject({
    clientId: input.metadata.client_id,
    redirectUri: input.redirectUri,
  });
  const approved = await authRequest(ctx, "/oauth2/consent", {
    accept: true,
    oauth_query: oauthQuery,
  });
  assert(approved.ok, await approved.clone().text());
  const callback = new URL(z.object({ url: z.url() }).parse(await approved.json()).url);
  assert.equal(callback.origin + callback.pathname, input.redirectUri);
  assert.equal(callback.searchParams.get("state"), "scenario-mcp-state");
  await transport.finishAuth(callback.searchParams);
  await transport.close();
  await client.connect(createTransport());
  assert(flow.tokens?.refresh_token);
  return { client, tokens: flow.tokens };
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
        // The MCP client's Client ID Metadata Document, which Auth fetches from the public web.
        fakes: ({ fake }) => ({
          web: fake.web({
            responses: {
              [mcpClientMetadata.client_id]: () => Response.json(mcpClientMetadata),
              [piClientMetadata.client_id]: () => Response.json(piClientMetadata),
            },
          }),
        }),
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

  test("a remote MCP client identifies itself by metadata document, gets browser approval for DPoP-bound tokens, and starts in the personal workspace", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { token, user, organization } = await authorizeFirstPartyClient(ctx);
      const endpoint = new URL(LEYWAY_MCP_PATH, origin);
      const wrongAudience = await mcpGatewayFetch(
        ctx,
        new Request(endpoint, { headers: { authorization: `Bearer ${token}` } }),
      );
      assert.equal(wrongAudience.status, 401);
      assert.match(wrongAudience.headers.get("www-authenticate") ?? "", /resource_metadata=/u);

      const discovery = await mcpGatewayFetch(
        ctx,
        new Request(new URL("/.well-known/oauth-authorization-server", origin)),
      );
      const metadata = z.record(z.string(), z.unknown()).parse(await discovery.json());
      assert.equal(metadata.client_id_metadata_document_supported, true);
      // Clients without a challenge scope request what the resource advertises, so it lists only
      // what metadata-document clients may receive.
      const resourceDiscovery = await mcpGatewayFetch(
        ctx,
        new Request(new URL(LEYWAY_MCP_RESOURCE_METADATA_PATH, origin)),
      );
      expect(await resourceDiscovery.json()).toMatchObject({ scopes_supported: ["mcp"] });
      assert.equal(metadata.registration_endpoint, undefined);
      const registration = await ctx.runtime.objects.auth.singleton().http.fetch(
        new Request(new URL("/api/auth/oauth2/register", origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: [mcpClientRedirectUri],
            token_endpoint_auth_method: "none",
          }),
        }),
      );
      assert.equal(registration.status, 403);
      const { client, tokens } = await connectMcpClient(ctx, {
        metadata: mcpClientMetadata,
        redirectUri: mcpClientRedirectUri,
        dpop: await DpopSession.create(),
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      });
      assert.equal(tokens.token_type, "DPoP");

      try {
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
        const guide = z
          .object({ contents: z.tuple([z.object({ mimeType: z.string(), text: z.string() })]) })
          .parse(await client.readResource({ uri: resources[0].uri })).contents[0];
        assert.equal(guide.mimeType, "text/markdown");
        // The MCP guide leaves out what only Leyway's own conversations have.
        assert.include(guide.text, "through its MCP server");
        assert.notInclude(guide.text, "<backoffice-attachments>");
        assert.notInclude(guide.text, "<!--");
        const code = `async () => ({
          current: await context.getCurrentScope(),
          organization: (await context.org(${JSON.stringify(organization.id)}).org.get()).organization,
        })`;
        const input = { name: "codemode", arguments: { code } };
        expect(await client.callTool(input)).toMatchObject({
          structuredContent: {
            ok: true,
            result: {
              current: { kind: "user", userId: user.id },
              organization: { organizationId: organization.id },
            },
          },
        });
        expect(
          await client.callTool({ ...input, arguments: { code, scope: organization.id } }),
        ).toMatchObject({ isError: true });
        // A program run for its side effects returns nothing, which the client still accepts.
        expect(
          await client.callTool({
            name: "codemode",
            arguments: {
              code: `async () => { await state.writeFile({ path: "/workspace/done.md", content: "done" }); }`,
            },
          }),
        ).toMatchObject({ isError: false, structuredContent: { ok: true, result: null } });

        await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
          removedMembers: [{ organizationId: organization.id, userId: user.id }],
        });
        expect(await client.callTool(input)).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("Permission denied") }],
        });

        const revoked = await authRequest(ctx, "/backoffice/oauth/revoke-consent", {
          clientId: mcpClientMetadata.client_id,
        });
        assert(revoked.ok, await revoked.clone().text());
        // The access token has not expired, but Auth rejects it, and revocation removed the refresh.
        await expect(client.callTool(input)).rejects.toMatchObject({ code: "invalid_grant" });
      } finally {
        await client.close();
      }
    });
  });

  test("a 2025-11-25 MCP client like pi signs in with its metadata document and Bearer tokens, then runs Codemode", async () => {
    await runExecutionTokenScenario(async (ctx) => {
      const { user } = await authorizeFirstPartyClient(ctx);
      const { client, tokens } = await connectMcpClient(ctx, {
        metadata: piClientMetadata,
        // Pi listens on a free port; its document registers the loopback callback without one.
        redirectUri: "http://127.0.0.1:48527/callback",
        dpop: null,
        versionNegotiation: { mode: "legacy" },
      });
      try {
        assert.equal(tokens.token_type, "Bearer");
        assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
        const result = await client.callTool({
          name: "codemode",
          arguments: {
            code: `async () => {
              await state.writeFile({ path: "/workspace/notes.md", content: "From pi" });
              console.log("saved");
              return { scope: await context.getCurrentScope(), stateTools: Object.keys(state) };
            }`,
          },
        });
        expect(result).toMatchObject({
          isError: false,
          structuredContent: {
            ok: true,
            result: {
              scope: { kind: "user", userId: user.id },
              stateTools: expect.arrayContaining(["readFile", "writeFile", "rm"]),
            },
            error: null,
            logs: [{ channel: "log", text: "saved" }],
            calls: {
              items: [
                {
                  subject: {
                    kind: "tool",
                    name: "state.writeFile",
                    target: "/workspace/notes.md",
                  },
                  status: "succeeded",
                },
              ],
              omitted: 0,
            },
          },
        });
        // A model reads the calls' summaries; the content they wrote stays in the run's history.
        assert.notInclude(JSON.stringify(result), "From pi");

        // Nothing would start an inline workflow for an MCP client, so the run says so.
        expect(
          await client.callTool({
            name: "codemode",
            arguments: {
              code: `defineWorkflow({ name: "later" }, async (_event, step) => await step.do("now", async () => 1))`,
            },
          }),
        ).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            error: expect.stringContaining("workflow.createInstance"),
          },
        });

        // Rotation is strict for every client: a refresh token works once, even moments later.
        const refreshToken = tokens.refresh_token;
        assert(refreshToken);
        const refresh = async () =>
          await ctx.runtime.objects.auth.singleton().http.fetch(
            new Request(new URL("/api/auth/oauth2/token", origin), {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: piClientMetadata.client_id,
                resource: new URL(LEYWAY_MCP_PATH, origin).href,
              }),
            }),
          );
        const rotated = await refresh();
        assert(rotated.ok, await rotated.clone().text());
        const replayed = await refresh();
        assert.equal(replayed.status, 400);
        expect(await replayed.json()).toMatchObject({ error: "invalid_grant" });
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
        requestedMemberReach: { kind: "none" },
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
          memberReach: { kind: "none" },
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
