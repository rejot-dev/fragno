import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { McpFragmentConfig } from "./mcp-types";

export interface StoredServerAuth {
  mode: string;
  payload?: unknown;
}

export interface McpOperationResult<T> {
  result: T;
}

export function assertAllowedEndpoint(endpointUrl: string, config: McpFragmentConfig) {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP endpoint must be an HTTP(S) URL");
  }
  if (config.allowedEndpointUrls && !config.allowedEndpointUrls(url)) {
    throw new Error("MCP endpoint is not allowed");
  }
  return url;
}

export function stringifySecretPayload(value: unknown) {
  return JSON.stringify(value);
}

export function parseSecretPayload<T>(value: string) {
  return JSON.parse(value) as T;
}

function bearerRequestInit(token: string | undefined): RequestInit | undefined {
  if (!token) {
    return undefined;
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function withMcpClient<T>(args: {
  endpointUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  operation: (client: Client) => Promise<T>;
}): Promise<McpOperationResult<T>> {
  const client = new Client(
    { name: "fragno-mcp-fragment", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(args.endpointUrl), {
    fetch: args.fetchImplementation,
    requestInit: bearerRequestInit(args.token),
  });

  try {
    await client.connect(transport, { timeout: args.timeoutMs });
    const capabilities = client.getServerCapabilities();
    if (!capabilities?.tools) {
      throw new Error("MCP server does not advertise tools capability");
    }

    const result = await args.operation(client);
    return { result };
  } finally {
    await transport.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function listMcpTools(args: {
  endpointUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}) {
  return await withMcpClient({
    ...args,
    operation: async (client) => await client.listTools(undefined, { timeout: args.timeoutMs }),
  });
}

export async function callMcpTool(args: {
  endpointUrl: string;
  token?: string;
  name: string;
  toolArguments?: Record<string, unknown>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}) {
  return await withMcpClient({
    ...args,
    operation: async (client) =>
      await client.callTool({ name: args.name, arguments: args.toolArguments ?? {} }, undefined, {
        timeout: args.timeoutMs,
      }),
  });
}
