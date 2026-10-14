import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";

import type { McpFragmentConfig, McpToolCallResult } from "./mcp-types";

export interface StoredServerAuth {
  mode: string;
  payload?: unknown;
}

export interface McpConnectionMetadata {
  protocolVersion?: string;
  serverInfo?: unknown;
  capabilities?: unknown;
}

export type McpClientAuth<TAuthChanges = unknown> =
  | { type: "bearer"; token?: string }
  | {
      type: "provider";
      provider: OAuthClientProvider;
      readAuthChanges: () => Promise<TAuthChanges | undefined>;
    };

export type McpOperationResult<T, TAuthChanges = unknown> =
  | {
      ok: true;
      result: T;
      metadata: McpConnectionMetadata;
      authChanges?: TAuthChanges;
    }
  | { ok: false; error: unknown; authChanges?: TAuthChanges };

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

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Secret consumers select the stored payload shape at this trusted serialization boundary.
export function parseSecretPayload<T>(value: string) {
  return JSON.parse(value) as T;
}

function bearerRequestInit(token: string | undefined): RequestInit | undefined {
  if (!token) {
    return undefined;
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

const authProvider = (auth: McpClientAuth | undefined) =>
  auth?.type === "provider" ? auth.provider : undefined;

const authRequestInit = (auth: McpClientAuth | undefined) =>
  auth?.type === "bearer" ? bearerRequestInit(auth.token) : undefined;

async function readAuthChanges<TAuthChanges>(auth: McpClientAuth<TAuthChanges> | undefined) {
  return auth?.type === "provider" ? await auth.readAuthChanges() : undefined;
}

async function withMcpClient<T, TAuthChanges = unknown>(args: {
  endpointUrl: string;
  auth?: McpClientAuth<TAuthChanges>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  operation: (client: Client) => Promise<T>;
}): Promise<McpOperationResult<T, TAuthChanges>> {
  const client = new Client(
    { name: "fragno-mcp-fragment", version: "0.1.0" },
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(args.endpointUrl), {
    fetch: args.fetchImplementation,
    requestInit: authRequestInit(args.auth),
    authProvider: authProvider(args.auth),
  });

  try {
    await client.connect(transport, { timeout: args.timeoutMs });
    const capabilities = client.getServerCapabilities();

    const metadata: McpConnectionMetadata = {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverInfo: client.getServerVersion(),
      capabilities,
    };
    const result = await args.operation(client);
    return { ok: true, result, metadata, authChanges: await readAuthChanges(args.auth) };
  } catch (error) {
    return { ok: false, error, authChanges: await readAuthChanges(args.auth) };
  } finally {
    await transport.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function listMcpTools<TAuthChanges = unknown>(args: {
  endpointUrl: string;
  auth?: McpClientAuth<TAuthChanges>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}) {
  return await withMcpClient({
    ...args,
    operation: (client) => client.listTools(undefined, { timeout: args.timeoutMs }),
  });
}

export async function callMcpTool<TAuthChanges = unknown>(args: {
  endpointUrl: string;
  auth?: McpClientAuth<TAuthChanges>;
  name: string;
  toolArguments?: Record<string, unknown>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}) {
  return await withMcpClient({
    ...args,
    operation: async (client) => {
      const result = await client.callTool(
        { name: args.name, arguments: args.toolArguments ?? {} },
        { timeout: args.timeoutMs },
      );
      // Tool errors are results for the caller, not protocol failures (MCP spec, tools/call).
      return {
        isError: result.isError === true,
        content: Array.isArray(result.content) ? result.content : [],
        structuredContent: result.structuredContent ?? null,
      } satisfies McpToolCallResult;
    },
  });
}
