import {
  createMcpHandler,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";

/** Tools declare raw JSON Schemas so tests can publish any dialect a real server might. */
export interface TestMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  call: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

export interface TestMcpServerOptions {
  /** 2026-07-28 serves stateless requests only; 2025-11-25 serves sessions only. */
  protocolVersion: "2025-11-25" | "2026-07-28";
  requiredBearerToken?: string;
  enableJsonResponse?: boolean;
  tools?: readonly TestMcpTool[];
  oauth?: boolean;
  disableDynamicRegistration?: boolean;
  requiredClientId?: string;
  requiredClientSecret?: string;
  refreshedRefreshToken?: string;
  omitRefreshTokenOnRefresh?: boolean;
  /** Consent grants only an access token, which stops working when it expires. */
  omitRefreshTokenOnConsent?: boolean;
  failAuthorizedMcpRequests?: boolean;
}

/** An in-process streamable HTTP MCP server, with optional OAuth, served from one origin. */
export interface TestMcpServer {
  fetch: (request: Request) => Promise<Response>;
  getMcpRequestCount: () => number;
  getTokenRequestCount: () => number;
  /** Rejects every client registered so far, as a server that lost its registrations would. */
  forgetRegisteredClients: () => void;
  /** Sets how long access tokens issued from now on last; one hour until changed. */
  setTokenLifetimeSeconds: (seconds: number) => void;
  close: () => Promise<void>;
}

// Servers built on the v1 SDK emit draft-07 schemas; this echo tool publishes the same dialect.
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

function requestClientId(request: Request, form: URLSearchParams) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    return atob(authorization.slice("Basic ".length)).split(":")[0];
  }
  return form.get("client_id");
}

function hasExpectedClientAuth(
  request: Request,
  form: URLSearchParams,
  options: TestMcpServerOptions,
  registeredClients: ReadonlySet<string>,
) {
  if (!options.requiredClientId) {
    // Registered clients authenticate only while the server still knows them.
    return (
      options.disableDynamicRegistration === true ||
      registeredClients.has(requestClientId(request, form) ?? "")
    );
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
    server.setRequestHandler("tools/list", () => ({
      tools: tools.map(({ call: _call, ...tool }) => tool),
    }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      const tool = tools.find((candidate) => candidate.name === params.name);
      if (!tool) {
        // Mirrors McpServer: an unknown tool is a tool error, not a protocol failure.
        return {
          isError: true,
          content: [{ type: "text", text: `Tool ${params.name} not found` }],
        };
      }
      // Low-level handlers project results themselves to match the negotiated protocol's wire shape.
      return server.projectCallToolResult(
        await tool.call(params.arguments ?? {}),
        tool.outputSchema,
      );
    });
  }
  return server;
}

async function handleToken(
  request: Request,
  options: TestMcpServerOptions,
  registeredClients: ReadonlySet<string>,
  tokenLifetimeSeconds: number,
) {
  const form = new URLSearchParams(await request.text());
  if (!hasExpectedClientAuth(request, form, options, registeredClients)) {
    return json({ error: "invalid_client" }, 401);
  }
  const grantType = form.get("grant_type");
  if (grantType === "client_credentials") {
    return json({
      access_token: options.requiredBearerToken ?? "client-credentials-access-token",
      token_type: "Bearer",
      expires_in: tokenLifetimeSeconds,
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
      expires_in: tokenLifetimeSeconds,
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
    ...(options.omitRefreshTokenOnConsent ? {} : { refresh_token: "oauth-refresh-token" }),
    token_type: "Bearer",
    expires_in: tokenLifetimeSeconds,
    scope: "tools",
  });
}

/** Serves MCP at `<origin>/mcp`; metadata URLs derive from each request's origin. */
export function createTestMcpServer(
  options: TestMcpServerOptions = { protocolVersion: "2026-07-28" },
): TestMcpServer {
  const tools = options.tools ?? [echoTool];
  const modernHandler = createMcpHandler(() => createMcpProtocolServer(tools), {
    legacy: "reject",
    responseMode: options.enableJsonResponse ? "auto" : "sse",
  });
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
  let registrationCount = 0;
  let tokenLifetimeSeconds = 3600;
  const registeredClients = new Set<string>();

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
        authorization_response_iss_parameter_supported: true,
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
      registrationCount += 1;
      const clientId = `test-client-${registrationCount}`;
      registeredClients.add(clientId);
      return json({ ...metadata, client_id: clientId, client_secret: "test-secret" });
    }
    if (options.oauth && url.pathname === "/authorize") {
      // Consent is immediate: the redirect carries a fixed code and the caller's state.
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) {
        return new Response("Missing redirect_uri", { status: 400 });
      }
      if (
        !options.disableDynamicRegistration &&
        !options.requiredClientId &&
        !registeredClients.has(url.searchParams.get("client_id") ?? "")
      ) {
        return new Response("Unknown client", { status: 400 });
      }
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", "valid-code");
      redirect.searchParams.set("iss", baseUrl);
      const state = url.searchParams.get("state");
      if (state) {
        redirect.searchParams.set("state", state);
      }
      return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
    }
    if (options.oauth && url.pathname === "/token" && request.method === "POST") {
      tokenRequestCount += 1;
      return await handleToken(request, options, registeredClients, tokenLifetimeSeconds);
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
    if (options.protocolVersion === "2026-07-28") {
      return await modernHandler.fetch(request);
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
    forgetRegisteredClients: () => {
      registeredClients.clear();
    },
    setTokenLifetimeSeconds: (seconds) => {
      tokenLifetimeSeconds = seconds;
    },
    close: async () => {
      await modernHandler.close();
      for (const session of sessions.values()) {
        await session.server.close();
        await session.transport.close();
      }
      sessions.clear();
    },
  };
}
