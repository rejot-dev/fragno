/// <reference types="node" />

import { createServer, type IncomingMessage, type Server } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

export interface TestMcpServerHandle {
  endpointUrl: string;
  getMcpRequestCount: () => number;
  getTokenRequestCount: () => number;
  close: () => Promise<void>;
}

export interface StartTestMcpServerOptions {
  requiredBearerToken?: string;
  enableJsonResponse?: boolean;
  registerEchoTool?: boolean;
  oauth?: boolean;
  disableDynamicRegistration?: boolean;
  requiredClientId?: string;
  requiredClientSecret?: string;
  refreshedRefreshToken?: string;
  omitRefreshTokenOnRefresh?: boolean;
  failAuthorizedMcpRequests?: boolean;
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function rejectUnauthorized(request: IncomingMessage, requiredBearerToken: string | undefined) {
  if (!requiredBearerToken) {
    return false;
  }
  return request.headers.authorization !== `Bearer ${requiredBearerToken}`;
}

function hasExpectedClientAuth(
  request: IncomingMessage,
  form: URLSearchParams,
  options: StartTestMcpServerOptions,
) {
  if (!options.requiredClientId) {
    return true;
  }
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    return decoded === `${options.requiredClientId}:${options.requiredClientSecret ?? ""}`;
  }
  return (
    form.get("client_id") === options.requiredClientId &&
    form.get("client_secret") === (options.requiredClientSecret ?? "")
  );
}

function createConfiguredMcpServer(options: StartTestMcpServerOptions) {
  const mcpServer = new McpServer({ name: "fragno-test-mcp-server", version: "1.0.0" });

  if (options.registerEchoTool ?? true) {
    mcpServer.registerTool(
      "echo",
      {
        title: "Echo",
        description: "Echo a message",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
      },
      async ({ text }) => {
        const output = { echoed: text };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: output,
        };
      },
    );
  }

  return mcpServer;
}

export async function startStreamableHttpTestMcpServer(
  options: StartTestMcpServerOptions = {},
): Promise<TestMcpServerHandle> {
  const sessions = new Map<string, McpSession>();
  let mcpRequestCount = 0;
  let tokenRequestCount = 0;

  async function createSession() {
    const server = createConfiguredMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
      enableJsonResponse: options.enableJsonResponse ?? false,
    });
    await server.connect(transport);
    return { server, transport };
  }

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number } | null)?.port ?? 0}`;

    if (options.oauth && url.pathname.includes("/.well-known/oauth-protected-resource")) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ["tools"],
        }),
      );
      return;
    }
    if (options.oauth && url.pathname === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
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
        }),
      );
      return;
    }
    if (
      options.oauth &&
      !options.disableDynamicRegistration &&
      url.pathname === "/register" &&
      request.method === "POST"
    ) {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        const metadata = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            ...metadata,
            client_id: "test-client",
            client_secret: "test-secret",
          }),
        );
      });
      return;
    }
    if (options.oauth && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri) {
        response.writeHead(400).end("Missing redirect_uri");
        return;
      }
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", "valid-code");
      if (state) {
        redirect.searchParams.set("state", state);
      }
      response.writeHead(302, { Location: redirect.toString() }).end();
      return;
    }
    if (options.oauth && url.pathname === "/token" && request.method === "POST") {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        tokenRequestCount += 1;
        const form = new URLSearchParams(rawBody);
        if (!hasExpectedClientAuth(request, form, options)) {
          response
            .writeHead(401, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        if (form.get("grant_type") === "client_credentials") {
          response.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              access_token: options.requiredBearerToken ?? "client-credentials-access-token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: form.get("scope") ?? "tools",
            }),
          );
          return;
        }
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== "oauth-refresh-token") {
            response
              .writeHead(400, { "Content-Type": "application/json" })
              .end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          response.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              access_token: options.requiredBearerToken ?? "oauth-access-token",
              ...(options.omitRefreshTokenOnRefresh
                ? {}
                : { refresh_token: options.refreshedRefreshToken ?? "oauth-refresh-token" }),
              token_type: "Bearer",
              expires_in: 3600,
              scope: "tools",
            }),
          );
          return;
        }
        if (form.get("grant_type") !== "authorization_code" || form.get("code") !== "valid-code") {
          response
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        if (!form.get("code_verifier")) {
          response
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "invalid_request" }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            access_token: options.requiredBearerToken ?? "oauth-access-token",
            refresh_token: "oauth-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "tools",
          }),
        );
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      response.writeHead(404).end("Not found");
      return;
    }
    mcpRequestCount += 1;
    if (rejectUnauthorized(request, options.requiredBearerToken)) {
      if (options.oauth) {
        response
          .writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end("Unauthorized");
      } else {
        response.writeHead(401).end("Unauthorized");
      }
      return;
    }
    if (options.failAuthorizedMcpRequests) {
      response.writeHead(500).end("MCP operation failed");
      return;
    }

    void (async () => {
      const sessionId = request.headers["mcp-session-id"];
      const existingSession = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      const session = existingSession ?? (await createSession());
      await session.transport.handleRequest(request, response);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500).end(error instanceof Error ? error.message : "MCP transport error");
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  return {
    endpointUrl: endpointUrl(httpServer),
    getMcpRequestCount: () => mcpRequestCount,
    getTokenRequestCount: () => tokenRequestCount,
    close: async () => {
      for (const session of sessions.values()) {
        await session.server.close();
        await session.transport.close();
      }
      await closeHttpServer(httpServer);
    },
  };
}

function endpointUrl(httpServer: Server) {
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test MCP server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function closeHttpServer(httpServer: Server) {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
