import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { mcpFragmentDefinition } from "./definition";
import { createMcpFragmentClients } from "./index";
import { stringifySecretPayload } from "./mcp-api";
import { mcpRoutesFactory } from "./routes";
import { mcpSchema } from "./schema";
import {
  startStreamableHttpTestMcpServer,
  type TestMcpServerHandle,
} from "./testing/streamable-http-mcp-server";

const bearerToken = "secret";

const buildMcpTest = async () =>
  await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "in-memory" })
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
  let clientCredentialsMcpServer: TestMcpServerHandle;

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
    clientCredentialsMcpServer = await startStreamableHttpTestMcpServer({
      oauth: true,
      enableJsonResponse: true,
      requiredBearerToken: "client-credentials-access-token",
      requiredClientId: "machine-client",
      requiredClientSecret: "machine-secret",
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
    await clientCredentialsMcpServer.close();
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

    const denied = await fragment.callRoute("POST", "/servers/:slug/tool", {
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

    const allowed = await fragment.callRoute("POST", "/servers/:slug/tool", {
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

    const result = await fragment.callRoute("POST", "/servers/:slug/tool", {
      pathParams: { slug: "sse-tools" },
      body: { name: "echo", arguments: { text: "hello" } },
    });

    assert(result.type === "json");

    expect(result.data).toEqual({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { echoed: "hello" },
    });
  });

  test("calls tools against a real JSON-response streamable HTTP MCP server", async () => {
    await createServer(fragment, { slug: "json-tools", endpointUrl: jsonMcpServer.endpointUrl });

    const result = await fragment.callRoute("POST", "/servers/:slug/tool", {
      pathParams: { slug: "json-tools" },
      body: { name: "echo", arguments: { text: "from-json" } },
    });

    assert(result.type === "json");

    expect(result.data).toMatchObject({
      content: [{ type: "text", text: "from-json" }],
      structuredContent: { echoed: "from-json" },
    });
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

    const result = await fragment.callRoute("POST", "/servers/:slug/tool", {
      pathParams: { slug: "static-oauth-tools" },
      body: { name: "echo", arguments: { text: "from-static-oauth" } },
    });
    assert(result.type === "json");
    expect(result.data["structuredContent"]).toEqual({ echoed: "from-static-oauth" });
    expect(staticOAuthMcpServer.getTokenRequestCount()).toBe(2);
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

    const result = await fragment.callRoute("POST", "/servers/:slug/tool", {
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

  test("rejects MCP servers that do not advertise tools", async () => {
    await createServer(fragment, { slug: "no-tools", endpointUrl: noToolsMcpServer.endpointUrl });

    const result = await fragment.callRoute("POST", "/servers/:slug/tool", {
      pathParams: { slug: "no-tools" },
      body: { name: "echo", arguments: { text: "hello" } },
    });

    expect(result.type).toBe("error");
    if (result.type !== "error") {
      return;
    }
    expect(result.status).toBe(502);
    expect(result.error).toMatchObject({
      code: "MCP_ERROR",
      message: "MCP server does not advertise tools capability",
    });
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

    const call = await fragment.callRoute("POST", "/servers/:slug/tool", {
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
