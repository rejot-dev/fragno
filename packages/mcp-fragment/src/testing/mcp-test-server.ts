import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

/** Tools declare raw JSON Schemas so tests can publish any dialect a real server might. */
export interface TestMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

export interface TestMcpServerOptions {
  requiredBearerToken?: string;
  enableJsonResponse?: boolean;
  tools?: readonly TestMcpTool[];
  oauth?: boolean;
  disableDynamicRegistration?: boolean;
  requiredClientId?: string;
  requiredClientSecret?: string;
  refreshedRefreshToken?: string;
  omitRefreshTokenOnRefresh?: boolean;
  failAuthorizedMcpRequests?: boolean;
}

/** An in-process streamable HTTP MCP server, with optional OAuth, served from one origin. */
export interface TestMcpServer {
  fetch: (request: Request) => Promise<Response>;
  getMcpRequestCount: () => number;
  getTokenRequestCount: () => number;
  close: () => Promise<void>;
}

// The SDK's McpServer emits draft-07 schemas; this echo tool publishes the same dialect.
const echoTool: TestMcpTool = {
  name: "echo",
  title: "Echo",
  description: "Echo a message",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  call: ({ text }) => ({
    content: [{ type: "text", text: String(text) }],
    structuredContent: { echoed: String(text) },
  }),
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function hasExpectedClientAuth(
  request: Request,
  form: URLSearchParams,
  options: TestMcpServerOptions,
) {
  if (!options.requiredClientId) {
    return true;
  }
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    return (
      atob(authorization.slice("Basic ".length)) ===
      `${options.requiredClientId}:${options.requiredClientSecret ?? ""}`
    );
  }
  return (
    form.get("client_id") === options.requiredClientId &&
    form.get("client_secret") === (options.requiredClientSecret ?? "")
  );
}

function createMcpProtocolServer(tools: readonly TestMcpTool[]) {
  // oxlint-disable-next-line typescript/no-deprecated -- Raw JSON Schemas need the low-level server.
  const server = new Server(
    { name: "fragno-test-mcp-server", version: "1.0.0" },
    { capabilities: tools.length > 0 ? { tools: {} } : {} },
  );
  if (tools.length > 0) {
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map(({ call: _call, ...tool }) => tool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools.find((candidate) => candidate.name === params.name);
      if (!tool) {
        // Mirrors McpServer: an unknown tool is a tool error, not a protocol failure.
        return {
          isError: true,
          content: [{ type: "text", text: `Tool ${params.name} not found` }],
        };
      }
      return await tool.call(params.arguments ?? {});
    });
  }
  return server;
}

async function handleToken(request: Request, options: TestMcpServerOptions) {
  const form = new URLSearchParams(await request.text());
  if (!hasExpectedClientAuth(request, form, options)) {
    return json({ error: "invalid_client" }, 401);
  }
  const grantType = form.get("grant_type");
  if (grantType === "client_credentials") {
    return json({
      access_token: options.requiredBearerToken ?? "client-credentials-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: form.get("scope") ?? "tools",
    });
  }
  if (grantType === "refresh_token") {
    if (form.get("refresh_token") !== "oauth-refresh-token") {
      return json({ error: "invalid_grant" }, 400);
    }
    return json({
      access_token: options.requiredBearerToken ?? "oauth-access-token",
      ...(options.omitRefreshTokenOnRefresh
        ? {}
        : { refresh_token: options.refreshedRefreshToken ?? "oauth-refresh-token" }),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "tools",
    });
  }
  if (grantType !== "authorization_code" || form.get("code") !== "valid-code") {
    return json({ error: "invalid_grant" }, 400);
  }
  if (!form.get("code_verifier")) {
    return json({ error: "invalid_request" }, 400);
  }
  return json({
    access_token: options.requiredBearerToken ?? "oauth-access-token",
    refresh_token: "oauth-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "tools",
  });
}

/** Serves MCP at `<origin>/mcp`; metadata URLs derive from each request's origin. */
export function createTestMcpServer(options: TestMcpServerOptions = {}): TestMcpServer {
  const tools = options.tools ?? [echoTool];
  const sessions = new Map<
    string,
    {
      // oxlint-disable-next-line typescript/no-deprecated -- See createMcpProtocolServer.
      server: Server;
      transport: WebStandardStreamableHTTPServerTransport;
    }
  >();
  let mcpRequestCount = 0;
  let tokenRequestCount = 0;

  async function createSession() {
    const server = createMcpProtocolServer(tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
      enableJsonResponse: options.enableJsonResponse ?? false,
    });
    await server.connect(transport);
    return { server, transport };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = url.origin;

    if (options.oauth && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["tools"],
      });
    }
    if (options.oauth && url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        ...(options.disableDynamicRegistration
          ? {}
          : { registration_endpoint: `${baseUrl}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (
      options.oauth &&
      !options.disableDynamicRegistration &&
      url.pathname === "/register" &&
      request.method === "POST"
    ) {
      const rawBody = await request.text();
      const metadata = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      return json({ ...metadata, client_id: "test-client", client_secret: "test-secret" });
    }
    if (options.oauth && url.pathname === "/authorize") {
      // Consent is immediate: the redirect carries a fixed code and the caller's state.
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) {
        return new Response("Missing redirect_uri", { status: 400 });
      }
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", "valid-code");
      const state = url.searchParams.get("state");
      if (state) {
        redirect.searchParams.set("state", state);
      }
      return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
    }
    if (options.oauth && url.pathname === "/token" && request.method === "POST") {
      tokenRequestCount += 1;
      return await handleToken(request, options);
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    mcpRequestCount += 1;
    if (
      options.requiredBearerToken &&
      request.headers.get("authorization") !== `Bearer ${options.requiredBearerToken}`
    ) {
      return new Response("Unauthorized", {
        status: 401,
        headers: options.oauth
          ? {
              "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
            }
          : {},
      });
    }
    if (options.failAuthorizedMcpRequests) {
      return new Response("MCP operation failed", { status: 500 });
    }
    const sessionId = request.headers.get("mcp-session-id");
    const session = (sessionId ? sessions.get(sessionId) : undefined) ?? (await createSession());
    return await session.transport.handleRequest(request);
  }

  return {
    fetch: async (request) => {
      try {
        return await handle(request);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "MCP transport error", {
          status: 500,
        });
      }
    },
    getMcpRequestCount: () => mcpRequestCount,
    getTokenRequestCount: () => tokenRequestCount,
    close: async () => {
      for (const session of sessions.values()) {
        await session.server.close();
        await session.transport.close();
      }
      sessions.clear();
    },
  };
}
