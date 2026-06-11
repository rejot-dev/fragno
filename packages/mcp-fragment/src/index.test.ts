import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { mcpFragmentDefinition } from "./definition";
import { createMcpFragmentClients } from "./index";
import { parseSecretPayload, stringifySecretPayload } from "./mcp-api";
import { mcpRoutesFactory } from "./routes";
import { mcpSchema } from "./schema";
import {
  startStreamableHttpTestMcpServer,
  type TestMcpServerHandle,
} from "./testing/streamable-http-mcp-server";

const bearerToken = "secret";

const buildMcpTest = async () =>
  await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "mcp",
      instantiate(mcpFragmentDefinition)
        .withConfig({ publicBaseUrl: "https://app.test" })
        .withRoutes([mcpRoutesFactory]),
    )
    .build();

type McpTestFragmentResult = Awaited<ReturnType<typeof buildMcpTest>>["fragments"]["mcp"];

async function createServer(
  fragment: McpTestFragmentResult["fragment"],
  input: {
    slug: string;
    endpointUrl: string;
    name?: string;
    auth?:
      | { type: "none" }
      | { type: "bearer"; token: string }
      | { type: "oauth" }
      | { type: "client_credentials"; clientId: string; clientSecret: string; scopes?: string[] };
  },
) {
  return await fragment.callRoute("POST", "/servers", {
    body: {
      name: "Test MCP server",
      auth: { type: "none" },
      ...input,
    },
  });
}

async function readConnectionCache(fragmentResult: McpTestFragmentResult, serverId: string) {
  return (
    await fragmentResult.db
      .createUnitOfWork("read-connection-cache")
      .forSchema(mcpSchema)
      .findFirst("server_connection_cache", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", serverId)),
      )
      .executeRetrieve()
  )[0];
}

async function readAuthSecret(fragmentResult: McpTestFragmentResult, serverId: string) {
  return (
    await fragmentResult.db
      .createUnitOfWork("read-auth-secret")
      .forSchema(mcpSchema)
      .findFirst("secret", (b) =>
        b.whereIndex("idx_secret_server_kind", (eb) =>
          eb.and(eb("serverId", "=", serverId), eb("kind", "=", "auth")),
        ),
      )
      .executeRetrieve()
  )[0];
}

async function replaceStoredOAuthTokenWithExpiredAccessToken(
  fragmentResult: McpTestFragmentResult,
  serverId: string,
) {
  const uow = fragmentResult.db.createUnitOfWork("expire-oauth-token").forSchema(mcpSchema);
  uow.update("secret", `${serverId}:auth`, (b) =>
    b.set({
      payload: stringifySecretPayload({
        type: "oauth",
        redirectUri: "https://app.test/oauth/callback",
        tokens: {
          access_token: "expired-oauth-access-token",
          refresh_token: "oauth-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools",
        },
      }),
      expiresAt: new Date(Date.now() - 1_000),
      updatedAt: b.now(),
    }),
  );
  const { success } = await uow.executeMutations();
  if (!success) {
    throw new Error("Failed to replace stored OAuth token");
  }
}

describe("mcp-fragment", () => {
  let setup: Awaited<ReturnType<typeof buildMcpTest>>;
  let fragment: Awaited<ReturnType<typeof buildMcpTest>>["fragments"]["mcp"]["fragment"];
  let sseMcpServer: TestMcpServerHandle;
  let jsonMcpServer: TestMcpServerHandle;
  let noToolsMcpServer: TestMcpServerHandle;
  let staticOAuthMcpServer: TestMcpServerHandle;
  let rotatingOAuthMcpServer: TestMcpServerHandle;
  let failingRotatingOAuthMcpServer: TestMcpServerHandle;
  let clientCredentialsMcpServer: TestMcpServerHandle;
  let failingClientCredentialsMcpServer: TestMcpServerHandle;

  beforeAll(async () => {
    sseMcpServer = await startStreamableHttpTestMcpServer({ requiredBearerToken: bearerToken });
    jsonMcpServer = await startStreamableHttpTestMcpServer({ enableJsonResponse: true });
    noToolsMcpServer = await startStreamableHttpTestMcpServer({
      enableJsonResponse: true,
      registerEchoTool: false,
    });
    staticOAuthMcpServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "static-oauth-access-token",
      disableDynamicRegistration: true,
      requiredClientId: "static-client",
      requiredClientSecret: "static-secret",
    });
    rotatingOAuthMcpServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "rotating-oauth-access-token",
      disableDynamicRegistration: true,
      requiredClientId: "rotating-client",
      requiredClientSecret: "rotating-secret",
      refreshedRefreshToken: "rotated-refresh-token",
    });
    failingRotatingOAuthMcpServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "failing-rotating-oauth-access-token",
      disableDynamicRegistration: true,
      requiredClientId: "failing-rotating-client",
      requiredClientSecret: "failing-rotating-secret",
      refreshedRefreshToken: "failing-rotated-refresh-token",
      failAuthorizedMcpRequests: true,
    });
    clientCredentialsMcpServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "client-credentials-access-token",
      requiredClientId: "machine-client",
      requiredClientSecret: "machine-secret",
    });
    failingClientCredentialsMcpServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "failing-client-credentials-access-token",
      requiredClientId: "failing-machine-client",
      requiredClientSecret: "failing-machine-secret",
      failAuthorizedMcpRequests: true,
    });
    setup = await buildMcpTest();
    fragment = setup.fragments.mcp.fragment;
  });

  beforeEach(async () => {
    await setup.test.resetDatabase();
  });

  afterAll(async () => {
    await setup.test.cleanup();
    await sseMcpServer.close();
    await jsonMcpServer.close();
    await noToolsMcpServer.close();
    await staticOAuthMcpServer.close();
    await rotatingOAuthMcpServer.close();
    await failingRotatingOAuthMcpServer.close();
    await clientCredentialsMcpServer.close();
    await failingClientCredentialsMcpServer.close();
  });

  test("exports client builders", () => {
    expect(createMcpFragmentClients).toBeTypeOf("function");
    const clients = createMcpFragmentClients();
    expect(clients.createServer).toBeDefined();
    expect(clients.useServers).toBeDefined();
    expect(clients.useServer).toBeDefined();
    expect(clients.useTools).toBeDefined();
    expect(clients.callTool).toBeDefined();
    expect(clients.setToken).toBeDefined();
  });

  test("uses non-provider auth for bearer and no-auth MCP servers", async () => {
    const tokenRequestsBefore = staticOAuthMcpServer.getTokenRequestCount();
    await createServer(fragment, {
      slug: "bearer-without-provider",
      endpointUrl: staticOAuthMcpServer.endpointUrl,
      auth: { type: "bearer", token: "static-oauth-access-token" },
    });
    await createServer(fragment, {
      slug: "no-auth-without-provider",
      endpointUrl: jsonMcpServer.endpointUrl,
    });

    const bearerTools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "bearer-without-provider" },
    });
    assert(bearerTools.type === "json");
    expect(bearerTools.data.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    expect(staticOAuthMcpServer.getTokenRequestCount()).toBe(tokenRequestsBefore);

    const noAuthTools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "no-auth-without-provider" },
    });
    assert(noAuthTools.type === "json");
    expect(noAuthTools.data.tools).toEqual([expect.objectContaining({ name: "echo" })]);
  });

  test("stores, reads, lists, and reports auth status for bearer MCP servers", async () => {
    const created = await createServer(fragment, {
      slug: "local-tools",
      name: "Local tools",
      endpointUrl: sseMcpServer.endpointUrl,
      auth: { type: "bearer", token: bearerToken },
    });

    assert(created.type === "json");

    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      slug: "local-tools",
      name: "Local tools",
      endpointUrl: sseMcpServer.endpointUrl,
      authMode: "bearer",
    });

    const read = await fragment.callRoute("GET", "/servers/:slug", {
      pathParams: { slug: "local-tools" },
    });
    assert(read.type === "json");

    expect(read.data).toMatchObject(created.data);

    const list = await fragment.callRoute("GET", "/servers");
    assert(list.type === "json");

    expect(list.data.servers).toEqual([expect.objectContaining({ slug: "local-tools" })]);

    const status = await fragment.callRoute("GET", "/servers/:slug/auth/status", {
      pathParams: { slug: "local-tools" },
    });
    assert(status.type === "json");

    expect(status.data).toEqual({ authenticated: true, mode: "bearer" });
  });

  test("rejects duplicate server slugs", async () => {
    await createServer(fragment, { slug: "duplicate", endpointUrl: jsonMcpServer.endpointUrl });

    const duplicate = await createServer(fragment, {
      slug: "duplicate",
      endpointUrl: sseMcpServer.endpointUrl,
      auth: { type: "bearer", token: bearerToken },
    });

    expect(duplicate.type).toBe("error");
    if (duplicate.type !== "error") {
      return;
    }
    expect(duplicate.status).toBe(409);
    expect(duplicate.error.code).toBe("SERVER_EXISTS");
  });

  test("sets and updates bearer tokens without duplicating auth records", async () => {
    await createServer(fragment, { slug: "token-upsert", endpointUrl: sseMcpServer.endpointUrl });

    const first = await fragment.callRoute("POST", "/servers/:slug/auth/token", {
      pathParams: { slug: "token-upsert" },
      body: { token: "wrong" },
    });
    expect(first.type).toBe("json");

    const denied = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "token-upsert" },
      body: { name: "echo", arguments: { text: "hello" } },
    });
    expect(denied.type).toBe("error");
    if (denied.type !== "error") {
      return;
    }
    expect(denied.status).toBe(502);
    expect(denied.error.code).toBe("MCP_ERROR");

    const second = await fragment.callRoute("POST", "/servers/:slug/auth/token", {
      pathParams: { slug: "token-upsert" },
      body: { token: bearerToken },
    });
    assert(second.type === "json");

    expect(second.data).toEqual({ authenticated: true, mode: "bearer" });

    const allowed = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "token-upsert" },
      body: { name: "echo", arguments: { text: "hello" } },
    });
    assert(allowed.type === "json");

    expect(allowed.data["structuredContent"]).toEqual({ echoed: "hello" });
  });

  test("lists tools and calls tools against a real SSE streamable HTTP MCP server", async () => {
    await createServer(fragment, {
      slug: "sse-tools",
      endpointUrl: sseMcpServer.endpointUrl,
      auth: { type: "bearer", token: bearerToken },
    });

    const tools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "sse-tools" },
    });

    assert(tools.type === "json");

    expect(tools.data.tools).toEqual([
      expect.objectContaining({
        name: "echo",
        title: "Echo",
      }),
    ]);

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "sse-tools" },
      body: { name: "echo", arguments: { text: "hello" } },
    });

    assert(result.type === "json");

    expect(result.data).toEqual({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { echoed: "hello" },
    });
  });

  test("caches listed tools and connection metadata", async () => {
    await createServer(fragment, { slug: "cache-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const before = jsonMcpServer.getMcpRequestCount();
    const tools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "cache-tools" },
    });
    assert(tools.type === "json");
    expect(tools.data.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    expect(jsonMcpServer.getMcpRequestCount()).toBeGreaterThan(before);

    const cache = await readConnectionCache(setup.fragments.mcp, "cache-tools");
    expect(cache).toEqual(
      expect.objectContaining({
        protocolVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );
    expect(cache?.serverInfo).toEqual(expect.objectContaining({ name: "fragno-test-mcp-server" }));
    expect(cache?.capabilities).toEqual(expect.objectContaining({ tools: expect.any(Object) }));
  });

  test("returns cached connection data from server read routes", async () => {
    await createServer(fragment, { slug: "read-cache", endpointUrl: jsonMcpServer.endpointUrl });

    const tools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "read-cache" },
    });
    assert(tools.type === "json");

    const list = await fragment.callRoute("GET", "/servers");
    assert(list.type === "json");
    expect(list.data.servers.find((item) => item.slug === "read-cache")?.cache).toEqual(
      expect.objectContaining({
        protocolVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );

    const server = await fragment.callRoute("GET", "/servers/:slug", {
      pathParams: { slug: "read-cache" },
    });
    assert(server.type === "json");

    expect(server.data.cache).toEqual(
      expect.objectContaining({
        protocolVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );
  });

  test("refreshes tools instead of serving cached tool lists", async () => {
    await createServer(fragment, { slug: "refresh-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const first = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "refresh-tools" },
    });
    assert(first.type === "json");

    const afterFirst = jsonMcpServer.getMcpRequestCount();
    const refreshed = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "refresh-tools" },
    });
    assert(refreshed.type === "json");

    expect(refreshed.data.tools).toEqual(first.data.tools);
    expect(jsonMcpServer.getMcpRequestCount()).toBeGreaterThan(afterFirst);
  });

  test("caches connection metadata when calling a tool without listing tools", async () => {
    await createServer(fragment, {
      slug: "tool-call-cache",
      endpointUrl: jsonMcpServer.endpointUrl,
    });

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "tool-call-cache" },
      body: { name: "echo", arguments: { text: "metadata" } },
    });
    assert(result.type === "json");

    const cache = await readConnectionCache(setup.fragments.mcp, "tool-call-cache");
    expect(cache).toEqual(
      expect.objectContaining({
        protocolVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        tools: null,
      }),
    );
  });

  test("does not serve stale cached tools after deleting a server", async () => {
    await createServer(fragment, { slug: "delete-cache", endpointUrl: jsonMcpServer.endpointUrl });
    const tools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "delete-cache" },
    });
    assert(tools.type === "json");
    expect(await readConnectionCache(setup.fragments.mcp, "delete-cache")).toBeTruthy();

    const deleted = await fragment.callRoute("DELETE", "/servers/:slug", {
      pathParams: { slug: "delete-cache" },
    });
    assert(deleted.type === "empty");

    expect(await readConnectionCache(setup.fragments.mcp, "delete-cache")).toBeNull();
    const cached = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "delete-cache" },
    });
    expect(cached.type).toBe("error");
    if (cached.type === "error") {
      expect(cached.status).toBe(404);
      expect(cached.error.code).toBe("SERVER_NOT_FOUND");
    }
  });

  test("calls tools against a real JSON-response streamable HTTP MCP server", async () => {
    await createServer(fragment, { slug: "json-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "json-tools" },
      body: { name: "echo", arguments: { text: "from-json" } },
    });

    assert(result.type === "json");

    expect(result.data).toMatchObject({
      content: [{ type: "text", text: "from-json" }],
      structuredContent: { echoed: "from-json" },
    });
  });

  test("surfaces remote errors when executing an unknown tool", async () => {
    await createServer(fragment, { slug: "unknown-tool", endpointUrl: jsonMcpServer.endpointUrl });

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "unknown-tool" },
      body: { name: "missing-tool", arguments: {} },
    });

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.status).toBe(502);
      expect(result.error.code).toBe("MCP_ERROR");
      expect(result.error.message).toContain("missing-tool");
    }
  });

  test("persists explicit OAuth client credentials across the auth callback", async () => {
    await createServer(fragment, {
      slug: "static-oauth-tools",
      endpointUrl: staticOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    const start = await fragment.callRoute("POST", "/servers/:slug/auth/start", {
      pathParams: { slug: "static-oauth-tools" },
      body: {
        clientId: "static-client",
        clientSecret: "static-secret",
        scope: "tools",
      },
    });
    assert(start.type === "json");

    const authorizeResponse = await fetch(start.data.authorizationUrl, { redirect: "manual" });
    const location = authorizeResponse.headers.get("location");
    assert(location);
    const callbackUrl = new URL(location);

    const callback = await fragment.callRoute("GET", "/oauth/callback", {
      query: Object.fromEntries(callbackUrl.searchParams),
    });
    assert(callback.type === "json");
    expect(callback.data).toEqual({ authenticated: true, mode: "oauth" });

    await replaceStoredOAuthTokenWithExpiredAccessToken(setup.fragments.mcp, "static-oauth-tools");

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "static-oauth-tools" },
      body: { name: "echo", arguments: { text: "from-static-oauth" } },
    });
    assert(result.type === "json");
    expect(result.data["structuredContent"]).toEqual({ echoed: "from-static-oauth" });
    expect(staticOAuthMcpServer.getTokenRequestCount()).toBe(2);
  });

  test("retains existing OAuth refresh token when the refresh response omits one", async () => {
    const oauthServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "refresh-without-new-refresh-token",
      disableDynamicRegistration: true,
      requiredClientId: "no-rotate-client",
      requiredClientSecret: "no-rotate-secret",
      omitRefreshTokenOnRefresh: true,
    });

    try {
      await createServer(fragment, {
        slug: "refresh-token-not-rotated",
        endpointUrl: oauthServer.endpointUrl,
        auth: { type: "oauth" },
      });

      const start = await fragment.callRoute("POST", "/servers/:slug/auth/start", {
        pathParams: { slug: "refresh-token-not-rotated" },
        body: {
          clientId: "no-rotate-client",
          clientSecret: "no-rotate-secret",
          scope: "tools",
        },
      });
      assert(start.type === "json");

      const authorizeResponse = await fetch(start.data.authorizationUrl, { redirect: "manual" });
      const location = authorizeResponse.headers.get("location");
      assert(location);
      const callbackUrl = new URL(location);

      const callback = await fragment.callRoute("GET", "/oauth/callback", {
        query: Object.fromEntries(callbackUrl.searchParams),
      });
      assert(callback.type === "json");

      await replaceStoredOAuthTokenWithExpiredAccessToken(
        setup.fragments.mcp,
        "refresh-token-not-rotated",
      );

      const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
        pathParams: { slug: "refresh-token-not-rotated" },
        body: { name: "echo", arguments: { text: "from-refreshed-oauth" } },
      });
      assert(result.type === "json");

      const authSecret = await readAuthSecret(setup.fragments.mcp, "refresh-token-not-rotated");
      assert(authSecret);
      expect(
        parseSecretPayload<{ tokens: { access_token?: string; refresh_token?: string } }>(
          authSecret.payload,
        ),
      ).toEqual(
        expect.objectContaining({
          tokens: expect.objectContaining({
            access_token: "refresh-without-new-refresh-token",
            refresh_token: "oauth-refresh-token",
          }),
        }),
      );
    } finally {
      await oauthServer.close();
    }
  });

  test("persists rotated OAuth tokens when the MCP tool operation fails", async () => {
    await createServer(fragment, {
      slug: "rotating-oauth-tools",
      endpointUrl: rotatingOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    const start = await fragment.callRoute("POST", "/servers/:slug/auth/start", {
      pathParams: { slug: "rotating-oauth-tools" },
      body: {
        clientId: "rotating-client",
        clientSecret: "rotating-secret",
        scope: "tools",
      },
    });
    assert(start.type === "json");

    const authorizeResponse = await fetch(start.data.authorizationUrl, { redirect: "manual" });
    const location = authorizeResponse.headers.get("location");
    assert(location);
    const callbackUrl = new URL(location);

    const callback = await fragment.callRoute("GET", "/oauth/callback", {
      query: Object.fromEntries(callbackUrl.searchParams),
    });
    assert(callback.type === "json");

    await replaceStoredOAuthTokenWithExpiredAccessToken(
      setup.fragments.mcp,
      "rotating-oauth-tools",
    );

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "rotating-oauth-tools" },
      body: { name: "missing-tool", arguments: {} },
    });

    expect(result.type).toBe("error");
    const authSecret = await readAuthSecret(setup.fragments.mcp, "rotating-oauth-tools");
    assert(authSecret);
    expect(parseSecretPayload<{ tokens: { refresh_token?: string } }>(authSecret.payload)).toEqual(
      expect.objectContaining({
        tokens: expect.objectContaining({ refresh_token: "rotated-refresh-token" }),
      }),
    );
  });

  test("persists rotated OAuth tokens when MCP tool listing fails", async () => {
    await createServer(fragment, {
      slug: "rotating-oauth-list-tools",
      endpointUrl: failingRotatingOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    const start = await fragment.callRoute("POST", "/servers/:slug/auth/start", {
      pathParams: { slug: "rotating-oauth-list-tools" },
      body: {
        clientId: "failing-rotating-client",
        clientSecret: "failing-rotating-secret",
        scope: "tools",
      },
    });
    assert(start.type === "json");

    const authorizeResponse = await fetch(start.data.authorizationUrl, { redirect: "manual" });
    const location = authorizeResponse.headers.get("location");
    assert(location);
    const callbackUrl = new URL(location);

    const callback = await fragment.callRoute("GET", "/oauth/callback", {
      query: Object.fromEntries(callbackUrl.searchParams),
    });
    assert(callback.type === "json");

    await replaceStoredOAuthTokenWithExpiredAccessToken(
      setup.fragments.mcp,
      "rotating-oauth-list-tools",
    );

    const result = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "rotating-oauth-list-tools" },
    });

    expect(result.type).toBe("error");
    const authSecret = await readAuthSecret(setup.fragments.mcp, "rotating-oauth-list-tools");
    assert(authSecret);
    expect(parseSecretPayload<{ tokens: { refresh_token?: string } }>(authSecret.payload)).toEqual(
      expect.objectContaining({
        tokens: expect.objectContaining({ refresh_token: "failing-rotated-refresh-token" }),
      }),
    );
  });

  test("persists client-credentials tokens when the MCP operation fails", async () => {
    await createServer(fragment, {
      slug: "failed-client-credentials-tools",
      endpointUrl: failingClientCredentialsMcpServer.endpointUrl,
      auth: {
        type: "client_credentials",
        clientId: "failing-machine-client",
        clientSecret: "failing-machine-secret",
        scopes: ["tools"],
      },
    });

    const result = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "failed-client-credentials-tools" },
    });

    expect(result.type).toBe("error");
    const authSecret = await readAuthSecret(setup.fragments.mcp, "failed-client-credentials-tools");
    assert(authSecret);
    expect(parseSecretPayload<{ tokens?: { access_token?: string } }>(authSecret.payload)).toEqual(
      expect.objectContaining({
        tokens: expect.objectContaining({
          access_token: "failing-client-credentials-access-token",
        }),
      }),
    );
  });

  test("acquires and reuses client-credentials tokens for MCP tool operations", async () => {
    const tokenRequestsBefore = clientCredentialsMcpServer.getTokenRequestCount();
    await createServer(fragment, {
      slug: "client-credentials-tools",
      endpointUrl: clientCredentialsMcpServer.endpointUrl,
      auth: {
        type: "client_credentials",
        clientId: "machine-client",
        clientSecret: "machine-secret",
        scopes: ["tools"],
      },
    });

    const result = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "client-credentials-tools" },
      body: { name: "echo", arguments: { text: "from-client-credentials" } },
    });
    assert(result.type === "json");
    expect(result.data["structuredContent"]).toEqual({ echoed: "from-client-credentials" });
    expect(clientCredentialsMcpServer.getTokenRequestCount()).toBe(tokenRequestsBefore + 1);

    const tools = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "client-credentials-tools" },
    });
    assert(tools.type === "json");
    expect(tools.data.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    expect(clientCredentialsMcpServer.getTokenRequestCount()).toBe(tokenRequestsBefore + 1);
  });

  test("surfaces upstream authorization failures as MCP errors", async () => {
    await createServer(fragment, {
      slug: "bad-auth",
      endpointUrl: sseMcpServer.endpointUrl,
      auth: { type: "bearer", token: "wrong" },
    });

    const result = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "bad-auth" },
    });

    expect(result.type).toBe("error");
    if (result.type !== "error") {
      return;
    }
    expect(result.status).toBe(502);
    expect(result.error).toMatchObject({ code: "MCP_ERROR" });
    expect(result.error.message).toContain("Unauthorized");
  });

  test("returns and caches an empty tool list for MCP servers that do not advertise tools", async () => {
    await createServer(fragment, { slug: "no-tools", endpointUrl: noToolsMcpServer.endpointUrl });

    const result = await fragment.callRoute("GET", "/servers/:slug/tools", {
      pathParams: { slug: "no-tools" },
    });
    assert(result.type === "json");
    expect(result.data.tools).toEqual([]);

    const cache = await readConnectionCache(setup.fragments.mcp, "no-tools");
    expect(cache).toEqual(
      expect.objectContaining({
        capabilities: expect.not.objectContaining({ tools: expect.anything() }),
        tools: [],
      }),
    );
  });

  test("returns not found errors for unknown servers", async () => {
    const read = await fragment.callRoute("GET", "/servers/:slug", {
      pathParams: { slug: "missing" },
    });
    expect(read.type).toBe("error");
    if (read.type !== "error") {
      return;
    }
    expect(read.status).toBe(404);
    expect(read.error.code).toBe("SERVER_NOT_FOUND");

    const call = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "missing" },
      body: { name: "echo", arguments: { text: "hello" } },
    });
    expect(call.type).toBe("error");
    if (call.type !== "error") {
      return;
    }
    expect(call.status).toBe(404);
    expect(call.error.code).toBe("SERVER_NOT_FOUND");
  });

  test("deletes servers and stored auth data", async () => {
    await createServer(fragment, {
      slug: "delete-me",
      endpointUrl: sseMcpServer.endpointUrl,
      auth: { type: "bearer", token: bearerToken },
    });

    const deleted = await fragment.callRoute("DELETE", "/servers/:slug", {
      pathParams: { slug: "delete-me" },
    });
    expect(deleted.type).toBe("empty");
    if (deleted.type !== "empty") {
      return;
    }
    expect(deleted.status).toBe(204);

    const read = await fragment.callRoute("GET", "/servers/:slug", {
      pathParams: { slug: "delete-me" },
    });
    expect(read.type).toBe("error");
    if (read.type !== "error") {
      return;
    }
    expect(read.status).toBe(404);
  });

  test("honors endpoint allow-list configuration", async () => {
    const restricted = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "in-memory" })
      .withFragment(
        "mcp",
        instantiate(mcpFragmentDefinition)
          .withConfig({
            publicBaseUrl: "https://app.test",
            allowedEndpointUrls: () => false,
          })
          .withRoutes([mcpRoutesFactory]),
      )
      .build();

    try {
      const result = await restricted.fragments.mcp.fragment.callRoute("POST", "/servers", {
        body: {
          slug: "blocked",
          endpointUrl: jsonMcpServer.endpointUrl,
          auth: { type: "none" },
        },
      });

      expect(result.type).toBe("error");
      if (result.type !== "error") {
        return;
      }
      expect(result.status).toBe(400);
      expect(result.error.code).toBe("ENDPOINT_NOT_ALLOWED");
    } finally {
      await restricted.test.cleanup();
    }
  });
});
