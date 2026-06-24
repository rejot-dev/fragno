import { afterAll, assert, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

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
const onServerConfigurationChanged = vi.fn();
const onServerConfigurationDeleted = vi.fn();

const buildMcpTest = async () =>
  await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "mcp",
      instantiate(mcpFragmentDefinition)
        .withConfig({
          publicBaseUrl: "https://app.test",
          onServerConfigurationChanged,
          onServerConfigurationDeleted,
        })
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

async function completeOAuthFlow(
  fragment: McpTestFragmentResult["fragment"],
  input: {
    slug: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
  },
) {
  const start = await fragment.callRoute("POST", "/servers/:slug/auth/start", {
    pathParams: { slug: input.slug },
    body: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      scope: input.scope,
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

  return callback;
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
    vi.clearAllMocks();
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
    expect(clients.refreshServer).toBeDefined();
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

    const bearerTools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "bearer-without-provider" },
    });
    assert(bearerTools.type === "json");
    expect(bearerTools.data.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    expect(staticOAuthMcpServer.getTokenRequestCount()).toBe(tokenRequestsBefore);

    const noAuthTools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
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

    assert(created.status === 201);
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

    assert(duplicate.type === "error");
    if (duplicate.type !== "error") {
      return;
    }
    assert(duplicate.status === 409);
    assert(duplicate.error.code === "SERVER_EXISTS");
  });

  test("sets and updates bearer tokens without duplicating auth records", async () => {
    await createServer(fragment, { slug: "token-upsert", endpointUrl: sseMcpServer.endpointUrl });

    const first = await fragment.callRoute("POST", "/servers/:slug/auth/token", {
      pathParams: { slug: "token-upsert" },
      body: { token: "wrong" },
    });
    assert(first.type === "json");

    const denied = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "token-upsert" },
      body: { name: "echo", arguments: { text: "hello" } },
    });
    assert(denied.type === "error");
    if (denied.type !== "error") {
      return;
    }
    assert(denied.status === 502);
    assert(denied.error.code === "MCP_ERROR");

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

    const tools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
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
    const tools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
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

    const tools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
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

  test("checks live diagnostics and refreshes the server connection cache", async () => {
    await createServer(fragment, {
      slug: "diagnostics-refresh-cache",
      endpointUrl: jsonMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    const diagnostics = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "diagnostics-refresh-cache" },
    });
    assert(diagnostics.type === "json");

    expect(diagnostics.data).toMatchObject({
      ok: true,
      stage: null,
      server: {
        slug: "diagnostics-refresh-cache",
        endpointUrl: jsonMcpServer.endpointUrl,
        authMode: "oauth",
      },
      auth: {
        authenticated: false,
        mode: "oauth",
        tokenPresent: false,
      },
      live: {
        reachable: true,
        listToolsOk: true,
        toolCount: 1,
      },
      cache: {
        presentBeforeCheck: false,
        previousToolCount: null,
        updatedToolCount: 1,
      },
      error: null,
    });

    const cache = await readConnectionCache(setup.fragments.mcp, "diagnostics-refresh-cache");
    expect(cache).toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );

    await drainDurableHooks(fragment);
    expect(onServerConfigurationChanged).toHaveBeenCalledWith(
      {
        serverId: "diagnostics-refresh-cache",
        current: { tools: [expect.objectContaining({ name: "echo" })] },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );
  });

  test("returns diagnostics for live MCP failures", async () => {
    await createServer(fragment, {
      slug: "diagnostics-live-failure",
      endpointUrl: staticOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    const diagnostics = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "diagnostics-live-failure" },
    });
    assert(diagnostics.type === "json");

    expect(diagnostics.data).toMatchObject({
      ok: false,
      stage: "list_tools",
      server: {
        slug: "diagnostics-live-failure",
        endpointUrl: staticOAuthMcpServer.endpointUrl,
        authMode: "oauth",
      },
      auth: {
        authenticated: false,
        mode: "oauth",
        tokenPresent: false,
      },
      live: {
        reachable: false,
        listToolsOk: false,
        toolCount: null,
      },
      cache: {
        presentBeforeCheck: false,
        previousToolCount: null,
        updatedToolCount: null,
      },
      error: { code: "MCP_ERROR" },
    });
    expect(await readConnectionCache(setup.fragments.mcp, "diagnostics-live-failure")).toBeNull();
  });

  test("refreshes tools instead of serving cached tool lists", async () => {
    await createServer(fragment, { slug: "refresh-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const first = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "refresh-tools" },
    });
    assert(first.type === "json");

    const afterFirst = jsonMcpServer.getMcpRequestCount();
    const refreshed = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "refresh-tools" },
    });
    assert(refreshed.type === "json");

    expect(refreshed.data.tools).toEqual(first.data.tools);
    expect(jsonMcpServer.getMcpRequestCount()).toBeGreaterThan(afterFirst);
  });

  test("refreshes server configuration from durable hook after creating a server", async () => {
    await createServer(fragment, {
      slug: "auto-refresh-tools",
      endpointUrl: jsonMcpServer.endpointUrl,
    });

    await drainDurableHooks(fragment);

    const cache = await readConnectionCache(setup.fragments.mcp, "auto-refresh-tools");
    expect(cache).toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );
    expect(onServerConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(onServerConfigurationChanged).toHaveBeenCalledWith(
      {
        serverId: "auto-refresh-tools",
        current: { tools: [expect.objectContaining({ name: "echo" })] },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );
  });

  test("does not refresh OAuth server configuration before OAuth completes", async () => {
    await createServer(fragment, {
      slug: "oauth-waits-for-callback",
      endpointUrl: staticOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    await drainDurableHooks(fragment);

    expect(await readConnectionCache(setup.fragments.mcp, "oauth-waits-for-callback")).toBeNull();
    expect(onServerConfigurationChanged).not.toHaveBeenCalled();
  });

  test("refreshes OAuth server configuration from durable hook after OAuth callback", async () => {
    await createServer(fragment, {
      slug: "oauth-refresh-after-callback",
      endpointUrl: staticOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    const start = await fragment.callRoute("POST", "/servers/:slug/auth/start", {
      pathParams: { slug: "oauth-refresh-after-callback" },
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

    await drainDurableHooks(fragment);

    const cache = await readConnectionCache(setup.fragments.mcp, "oauth-refresh-after-callback");
    expect(cache).toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );
    expect(onServerConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(onServerConfigurationChanged).toHaveBeenCalledWith(
      {
        serverId: "oauth-refresh-after-callback",
        current: { tools: [expect.objectContaining({ name: "echo" })] },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );
  });

  test("refreshes OAuth server configuration again after re-authenticating a cached server", async () => {
    const slug = "oauth-refresh-after-reauth";
    await createServer(fragment, {
      slug,
      endpointUrl: staticOAuthMcpServer.endpointUrl,
      auth: { type: "oauth" },
    });

    await completeOAuthFlow(fragment, {
      slug,
      clientId: "static-client",
      clientSecret: "static-secret",
      scope: "tools",
    });
    await drainDurableHooks(fragment);

    expect(await readConnectionCache(setup.fragments.mcp, slug)).toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );

    vi.clearAllMocks();

    await completeOAuthFlow(fragment, {
      slug,
      clientId: "static-client",
      clientSecret: "static-secret",
      scope: "tools",
    });

    expect(await readConnectionCache(setup.fragments.mcp, slug)).toBeNull();

    await drainDurableHooks(fragment);

    const refreshedCache = await readConnectionCache(setup.fragments.mcp, slug);
    expect(refreshedCache).toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "echo" })],
      }),
    );
    expect(onServerConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(onServerConfigurationChanged).toHaveBeenCalledWith(
      {
        serverId: slug,
        current: { tools: [expect.objectContaining({ name: "echo" })] },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );
  });

  test("triggers durable hook when tools are first cached", async () => {
    await createServer(fragment, { slug: "new-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const refreshed = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "new-tools" },
    });
    assert(refreshed.type === "json");

    await drainDurableHooks(fragment);

    expect(onServerConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(onServerConfigurationChanged).toHaveBeenCalledWith(
      {
        serverId: "new-tools",
        current: { tools: refreshed.data.tools },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );
  });

  test("triggers durable hook when refreshed tools differ from cached tools", async () => {
    await createServer(fragment, { slug: "changed-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const uow = setup.fragments.mcp.db
      .createUnitOfWork("seed-stale-tools-cache")
      .forSchema(mcpSchema);
    uow.create("server_connection_cache", {
      id: "changed-tools",
      serverId: "changed-tools",
      protocolVersion: null,
      serverInfo: null,
      capabilities: null,
      tools: [{ name: "stale" }],
    });
    const { success } = await uow.executeMutations();
    if (!success) {
      throw new Error("Failed to seed stale tools cache");
    }

    const refreshed = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "changed-tools" },
    });
    assert(refreshed.type === "json");

    await drainDurableHooks(fragment);

    expect(onServerConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(onServerConfigurationChanged).toHaveBeenCalledWith(
      {
        serverId: "changed-tools",
        current: { tools: refreshed.data.tools },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );
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
    const tools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "delete-cache" },
    });
    assert(tools.type === "json");
    expect(await readConnectionCache(setup.fragments.mcp, "delete-cache")).toBeTruthy();

    const deleted = await fragment.callRoute("DELETE", "/servers/:slug", {
      pathParams: { slug: "delete-cache" },
    });
    assert(deleted.type === "empty");

    expect(await readConnectionCache(setup.fragments.mcp, "delete-cache")).toBeNull();
    const cached = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "delete-cache" },
    });
    assert(cached.type === "error");
    if (cached.type === "error") {
      assert(cached.status === 404);
      assert(cached.error.code === "SERVER_NOT_FOUND");
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

    assert(result.type === "error");
    if (result.type === "error") {
      assert(result.status === 502);
      assert(result.error.code === "MCP_ERROR");
      expect(result.error.message).toContain("missing-tool");
    }
  });

  test("persists explicit OAuth client credentials across the auth callback", async () => {
    const tokenRequestsBefore = staticOAuthMcpServer.getTokenRequestCount();

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
    assert(staticOAuthMcpServer.getTokenRequestCount() === tokenRequestsBefore + 2);
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

    assert(result.type === "error");
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

    const result = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "rotating-oauth-list-tools" },
    });

    assert(result.type === "json");
    expect(result.data).toMatchObject({ ok: false, error: { code: "MCP_ERROR" }, tools: [] });
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

    const result = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "failed-client-credentials-tools" },
    });

    assert(result.type === "json");
    expect(result.data).toMatchObject({ ok: false, error: { code: "MCP_ERROR" }, tools: [] });
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

    const tools = await fragment.callRoute("POST", "/servers/:slug/refresh", {
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

    const result = await fragment.callRoute("POST", "/servers/:slug/refresh", {
      pathParams: { slug: "bad-auth" },
    });

    assert(result.type === "json");
    expect(result.data).toMatchObject({ ok: false, error: { code: "MCP_ERROR" }, tools: [] });
    expect(result.data.error?.message).toContain("Unauthorized");
  });

  test("returns and caches an empty tool list for MCP servers that do not advertise tools", async () => {
    await createServer(fragment, { slug: "no-tools", endpointUrl: noToolsMcpServer.endpointUrl });

    const result = await fragment.callRoute("POST", "/servers/:slug/refresh", {
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
    assert(read.type === "error");
    if (read.type !== "error") {
      return;
    }
    assert(read.status === 404);
    assert(read.error.code === "SERVER_NOT_FOUND");

    const call = await fragment.callRoute("POST", "/servers/:slug/tools/execute", {
      pathParams: { slug: "missing" },
      body: { name: "echo", arguments: { text: "hello" } },
    });
    assert(call.type === "error");
    if (call.type !== "error") {
      return;
    }
    assert(call.status === 404);
    assert(call.error.code === "SERVER_NOT_FOUND");
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
    assert(deleted.type === "empty");
    if (deleted.type !== "empty") {
      return;
    }
    assert(deleted.status === 204);

    await drainDurableHooks(fragment);

    expect(onServerConfigurationDeleted).toHaveBeenCalledTimes(1);
    expect(onServerConfigurationDeleted).toHaveBeenCalledWith(
      { serverId: "delete-me" },
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );

    const read = await fragment.callRoute("GET", "/servers/:slug", {
      pathParams: { slug: "delete-me" },
    });
    assert(read.type === "error");
    if (read.type !== "error") {
      return;
    }
    assert(read.status === 404);
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

      assert(result.type === "error");
      if (result.type !== "error") {
        return;
      }
      assert(result.status === 400);
      assert(result.error.code === "ENDPOINT_NOT_ALLOWED");
    } finally {
      await restricted.test.cleanup();
    }
  });
});
