import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { createApiFragmentClients } from "./client/client";
import { apiFragmentDefinition } from "./definition";
import { apiRoutesFactory } from "./routes";
import { apiSchema } from "./schema";

const oauthRedirectUri = "https://app.test/oauth/callback";
const onConnectionChanged = vi.fn();
const onConnectionDeleted = vi.fn();
const onConnectionAvailable = vi.fn();

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init?.headers)),
    },
  });
}

function buildFetchRecorder() {
  const calls: FetchCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });

    if (url === "https://auth.test/token") {
      const body = new URLSearchParams(init?.body?.toString());
      if (body.get("grant_type") === "client_credentials") {
        return jsonResponse({
          access_token: "client-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (body.get("grant_type") === "authorization_code") {
        return jsonResponse({
          access_token: "oauth-token",
          refresh_token: "oauth-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (body.get("grant_type") === "refresh_token") {
        return jsonResponse({
          access_token: "refreshed-oauth-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
    }

    if (url === "https://api.test/invalid-json") {
      return new Response("{not valid json", { headers: { "content-type": "application/json" } });
    }

    if (url === "https://api.test/large-error") {
      return new Response("x".repeat(2_000), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.startsWith("https://api.test/")) {
      return jsonResponse({
        ok: true,
        authorization: new Headers(init?.headers).get("authorization"),
        url,
      });
    }

    return jsonResponse({ error: "not found" }, { status: 404 });
  };
  return { calls, fetcher };
}

const buildApiTest = async (
  options: {
    allowedBaseUrls?: (url: URL) => boolean;
    allowedOAuthRedirectUris?: (url: URL) => boolean;
  } = {},
) => {
  const fetchRecorder = buildFetchRecorder();
  const allowedOAuthRedirectUris =
    "allowedOAuthRedirectUris" in options
      ? options.allowedOAuthRedirectUris
      : (url: URL) => url.toString() === oauthRedirectUri;
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "api",
      instantiate(apiFragmentDefinition)
        .withConfig({
          allowedBaseUrls: options.allowedBaseUrls,
          ...(allowedOAuthRedirectUris ? { allowedOAuthRedirectUris } : {}),
          fetch: fetchRecorder.fetcher,
          onConnectionChanged,
          onConnectionDeleted,
          onConnectionAvailable,
        })
        .withRoutes([apiRoutesFactory]),
    )
    .build();
  return { ...setup, fetchRecorder };
};

type ApiTest = Awaited<ReturnType<typeof buildApiTest>>;

async function readAuthSecrets(test: ApiTest, connectionId: string) {
  return await test.fragments.api.db
    .createUnitOfWork("read-auth-secrets")
    .forSchema(apiSchema)
    .find("secret", (b) =>
      b.whereIndex("idx_secret_connection_kind", (eb) =>
        eb.and(eb("connectionId", "=", connectionId), eb("kind", "=", "auth")),
      ),
    )
    .executeRetrieve();
}

describe("api-fragment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("exports fragment client builders", () => {
    expect(createApiFragmentClients).toBeTypeOf("function");

    const clients = createApiFragmentClients();
    expect(clients.useConnections).toBeDefined();
    expect(clients.useConnection).toBeDefined();
    expect(clients.useAuthStatus).toBeDefined();
    expect(clients.createConnection).toBeDefined();
    expect(clients.deleteConnection).toBeDefined();
    expect(clients.setBearerToken).toBeDefined();
    expect(clients.startOAuth).toBeDefined();
    expect(clients.deleteAuth).toBeDefined();
    expect(clients.request).toBeDefined();
  });

  test("creates, lists, reads, and deletes connections", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const created = await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "example" },
      body: { name: "Example", baseUrl: "https://api.test", auth: { type: "none" } },
    });
    assert(created.type === "json");
    assert(created.status === 201);
    expect(created.data).toMatchObject({ slug: "example", name: "Example", authMode: "none" });

    const list = await fragment.callRoute("GET", "/connections");
    assert(list.type === "json");
    expect(list.data.connections).toEqual([expect.objectContaining({ slug: "example" })]);

    const read = await fragment.callRoute("GET", "/connections/:slug", {
      pathParams: { slug: "example" },
    });
    assert(read.type === "json");
    expect(read.data).toMatchObject({ slug: "example", baseUrl: "https://api.test" });

    const deleted = await fragment.callRoute("DELETE", "/connections/:slug", {
      pathParams: { slug: "example" },
    });
    assert(deleted.type === "empty");

    await drainDurableHooks(fragment);
    expect(onConnectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "example",
        connection: expect.objectContaining({ slug: "example" }),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );
    expect(onConnectionDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "example",
        previous: expect.objectContaining({ slug: "example" }),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("rejects duplicate and disallowed connections", async () => {
    const setup = await buildApiTest({ allowedBaseUrls: (url) => url.hostname === "api.test" });
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "duplicate" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });

    const duplicate = await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "duplicate" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });
    assert(duplicate.type === "error");
    assert(duplicate.error.code === "CONNECTION_EXISTS");

    const disallowed = await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "blocked" },
      body: { baseUrl: "https://evil.test", auth: { type: "none" } },
    });
    assert(disallowed.type === "error");
    assert(disallowed.error.code === "BASE_URL_NOT_ALLOWED");

    await setup.test.cleanup();
  });

  test("sets bearer auth and executes requests with stored authorization", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "bearer" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });

    const token = await fragment.callRoute("POST", "/connections/:slug/auth/token", {
      pathParams: { slug: "bearer" },
      body: { token: "secret-token" },
    });
    assert(token.type === "json");
    expect(token.data).toMatchObject({ authenticated: true, mode: "bearer" });

    const secrets = await readAuthSecrets(setup, "bearer");
    expect(secrets).toHaveLength(1);

    const result = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "bearer" },
      body: {
        method: "GET",
        path: "/resource",
        headers: { authorization: "Bearer caller" },
        body: { type: "empty" },
      },
    });
    assert(result.type === "json");
    assert(result.data.ok);
    expect(result.data.response.body).toEqual({
      type: "json",
      value: expect.objectContaining({ authorization: "Bearer secret-token" }),
    });

    await drainDurableHooks(fragment);
    expect(onConnectionAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "bearer", authMode: "bearer" }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("stores and applies basic authentication", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const created = await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "jira" },
      body: {
        baseUrl: "https://api.test",
        auth: {
          type: "basic",
          username: "user@example.com",
          password: "api-token",
        },
      },
    });
    assert(created.type === "json");
    expect(created.data).toMatchObject({ authMode: "basic" });

    const status = await fragment.callRoute("GET", "/connections/:slug/auth/status", {
      pathParams: { slug: "jira" },
    });
    assert(status.type === "json");
    expect(status.data).toMatchObject({ authenticated: true, mode: "basic", tokenPresent: true });

    const result = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "jira" },
      body: {
        method: "GET",
        path: "/myself",
        headers: { authorization: "Bearer caller-token" },
        body: { type: "empty" },
      },
    });
    assert(result.type === "json");
    assert(result.data.ok);
    expect(result.data.response.body).toEqual({
      type: "json",
      value: expect.objectContaining({
        authorization: `Basic ${btoa("user@example.com:api-token")}`,
      }),
    });

    const [secrets] = await readAuthSecrets(setup, "jira");
    expect(secrets[0]?.payload).toContain('"type":"basic"');
    expect(created.data).not.toHaveProperty("password");

    await setup.test.cleanup();
  });

  test("sends discriminated JSON and text request bodies", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "request-bodies" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });

    await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "request-bodies" },
      body: {
        method: "POST",
        path: "/json",
        body: { type: "json", value: { issue: "FRAG-1" } },
      },
    });
    await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "request-bodies" },
      body: {
        method: "POST",
        path: "/xml",
        headers: { "content-type": "application/xml" },
        body: { type: "text", value: "<issue>FRAG-1</issue>" },
      },
    });

    const [jsonCall, textCall] = setup.fetchRecorder.calls;
    assert(new Headers(jsonCall?.init?.headers).get("content-type") === "application/json");
    assert(jsonCall?.init?.body === '{"issue":"FRAG-1"}');
    assert(new Headers(textCall?.init?.headers).get("content-type") === "application/xml");
    assert(textCall?.init?.body === "<issue>FRAG-1</issue>");

    await setup.test.cleanup();
  });

  test("rejects absolute request paths", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "absolute" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });

    const result = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "absolute" },
      body: {
        method: "GET",
        path: "https://evil.test/steal",
        body: { type: "empty" },
      },
    });
    assert(result.type === "json");
    assert(!result.data.ok);
    expect(result.data).toEqual({
      ok: false,
      response: null,
      error: {
        code: "REQUEST_ERROR",
        message: "API request path must be relative",
      },
    });

    await setup.test.cleanup();
  });

  test("reports invalid upstream JSON as a decoding error", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "invalid-json" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });

    const result = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "invalid-json" },
      body: { method: "GET", path: "/invalid-json", body: { type: "empty" } },
    });
    assert(result.type === "json");
    assert(!result.data.ok);
    expect(result.data).toMatchObject({
      error: {
        code: "RESPONSE_DECODING_ERROR",
        message: "Upstream response declared JSON but could not be decoded",
      },
      response: { body: { type: "text", value: "{not valid json" } },
    });

    await setup.test.cleanup();
  });

  test("bounds HTTP error messages while preserving the response body", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "large-error" },
      body: { baseUrl: "https://api.test", auth: { type: "none" } },
    });

    const result = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "large-error" },
      body: { method: "GET", path: "/large-error", body: { type: "empty" } },
    });
    assert(result.type === "json");
    assert(!result.data.ok);
    assert(result.data.error.code === "HTTP_ERROR");
    expect(result.data.error.message).toHaveLength(501);
    expect(result.data.response?.body).toEqual({ type: "text", value: "x".repeat(2_000) });

    await setup.test.cleanup();
  });

  test("client credentials tokens are acquired, reused, and refreshed", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "machine" },
      body: {
        baseUrl: "https://api.test",
        auth: {
          type: "client_credentials",
          tokenEndpoint: "https://auth.test/token",
          clientId: "client",
          clientSecret: "secret",
          tokenEndpointAuthMethod: "client_secret_basic",
        },
      },
    });

    const first = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "machine" },
      body: { method: "GET", path: "/one", body: { type: "empty" } },
    });
    assert(first.type === "json");
    assert(first.data.ok);
    expect(first.data.response.body).toEqual({
      type: "json",
      value: expect.objectContaining({ authorization: "Bearer client-token" }),
    });

    const second = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "machine" },
      body: { method: "GET", path: "/two", body: { type: "empty" } },
    });
    assert(second.type === "json");

    const tokenRequests = setup.fetchRecorder.calls.filter(
      (call) => call.url === "https://auth.test/token",
    );
    expect(tokenRequests).toHaveLength(1);

    const expireToken = setup.fragments.api.db
      .createUnitOfWork("expire-client-token")
      .forSchema(apiSchema);
    expireToken.update("secret", "machine:auth", (b) =>
      b.set({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expireToken.executeMutations();

    const third = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug: "machine" },
      body: { method: "GET", path: "/three", body: { type: "empty" } },
    });
    assert(third.type === "json");
    expect(
      setup.fetchRecorder.calls.filter((call) => call.url === "https://auth.test/token"),
    ).toHaveLength(2);

    await setup.test.cleanup();
  });

  test("client credentials refresh returns the public service result", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug: "machine-refresh" },
      body: {
        baseUrl: "https://api.test",
        auth: {
          type: "client_credentials",
          tokenEndpoint: "https://auth.test/token",
          clientId: "client",
          clientSecret: "secret",
          tokenEndpointAuthMethod: "client_secret_basic",
        },
      },
    });

    const result = await fragment.callServices(() =>
      setup.fragments.api.services.refreshClientCredentialsToken({
        connectionId: "machine-refresh",
      }),
    );

    expect(result).toEqual({ found: true, tokenPresent: true });

    await setup.test.cleanup();
  });

  test("OAuth start rejects a non-HTTP redirect URI", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const start = await fragment.callRoute("POST", "/connections/:slug/auth/oauth/start", {
      pathParams: { slug: "oauth-api" },
      query: { redirectUri: "javascript:alert(1)" },
      body: {},
    });

    assert(start.type === "error");
    assert.equal(start.status, 400);
    assert.equal(start.error.code, "INVALID_OAUTH_REDIRECT_URI");

    await setup.test.cleanup();
  });

  test("OAuth start rejects a redirect URI outside the configured allow-list", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const start = await fragment.callRoute("POST", "/connections/:slug/auth/oauth/start", {
      pathParams: { slug: "oauth-api" },
      query: { redirectUri: "https://attacker.example/oauth/callback" },
      body: {},
    });

    assert(start.type === "error");
    assert.equal(start.status, 400);
    assert.equal(start.error.code, "OAUTH_REDIRECT_URI_NOT_ALLOWED");

    await setup.test.cleanup();
  });

  test("OAuth start is denied when no redirect URI policy is configured", async () => {
    const setup = await buildApiTest({ allowedOAuthRedirectUris: undefined });
    const fragment = setup.fragments.api.fragment;

    const start = await fragment.callRoute("POST", "/connections/:slug/auth/oauth/start", {
      pathParams: { slug: "oauth-api" },
      query: { redirectUri: oauthRedirectUri },
      body: {},
    });

    assert(start.type === "error");
    assert.equal(start.status, 400);
    assert.equal(start.error.code, "OAUTH_REDIRECT_URI_NOT_ALLOWED");

    await setup.test.cleanup();
  });

  test("OAuth start and callback store tokens and make the connection available", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    const slug = "oauth:colon";

    await fragment.callRoute("PUT", "/connections/:slug", {
      pathParams: { slug },
      body: {
        baseUrl: "https://api.test",
        auth: {
          type: "oauth",
          authorizationEndpoint: "https://auth.test/authorize",
          tokenEndpoint: "https://auth.test/token",
          clientId: "client",
          clientSecret: "secret",
          scopes: ["read"],
          tokenEndpointAuthMethod: "client_secret_basic",
        },
      },
    });

    const start = await fragment.callRoute("POST", "/connections/:slug/auth/oauth/start", {
      pathParams: { slug },
      query: { redirectUri: oauthRedirectUri },
      body: {},
    });
    assert(start.type === "json");
    const authorizationUrl = new URL(start.data.authorizationUrl);
    assert(authorizationUrl.searchParams.get("code_challenge_method") === "S256");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), oauthRedirectUri);
    expect(authorizationUrl.searchParams.get("state")).toBe(start.data.state);

    const callback = await fragment.callRoute("GET", "/oauth/callback", {
      query: { code: "auth-code", state: start.data.state },
    });
    assert(callback.type === "json");
    expect(callback.data).toEqual({ authenticated: true, mode: "oauth" });

    const request = await fragment.callRoute("POST", "/connections/:slug/request", {
      pathParams: { slug },
      body: { method: "GET", path: "/profile", body: { type: "empty" } },
    });
    assert(request.type === "json");
    assert(request.data.ok);
    expect(request.data.response.body).toEqual({
      type: "json",
      value: expect.objectContaining({ authorization: "Bearer oauth-token" }),
    });

    await drainDurableHooks(fragment);
    expect(onConnectionAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: slug, authMode: "oauth" }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("invalid OAuth callback state fails", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const callback = await fragment.callRoute("GET", "/oauth/callback", {
      query: { code: "auth-code", state: "missing:state" },
    });
    assert(callback.type === "error");
    assert(callback.error.code === "INVALID_OAUTH_STATE");

    await setup.test.cleanup();
  });
});
