import {
  type McpAuthStatus,
  type McpCreateServerOutput,
  type McpListServersOutput,
  type McpOAuthStartOutput,
  type McpServerRefreshOutput,
  type McpToolCallOutput,
  callToolInputSchema,
  createServerInputSchema,
  mcpOAuthStartInputSchema,
  serverSchema,
  mcpSetTokenInputSchema,
} from "@fragno-dev/backoffice-api/v0/mcp";
import { z } from "zod";

import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { McpRuntime } from "./mcp-runtime";

export type McpOAuthStartInput = Omit<z.infer<typeof mcpOAuthStartInputSchema>, "slug">;
export type McpSetTokenInput = Omit<z.infer<typeof mcpSetTokenInputSchema>, "slug">;
export type { McpRuntime } from "./mcp-runtime";

type McpToolContext = BackofficeToolContext<{ mcp?: McpRuntime }>;

const getMcpRuntime = (runtime: McpToolContext["runtimes"]["mcp"]): McpRuntime => {
  if (!runtime) {
    throw new Error("MCP runtime is not available in this execution context");
  }
  return runtime;
};

const defaultOutput = (_args: string[], parsed: ParsedCliTokens) => readOutputOptions(parsed);

const textOrDataFormat =
  <T>(renderText: (result: T) => string) =>
  (result: T, output: { format?: "text" | "json"; print?: string }) => {
    if (output.format === "json" || output.print) {
      return { data: result };
    }
    const stdout = renderText(result);
    return { data: result, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
  };

const stringifyMcpValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const cell = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "-";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

const renderTable = (headers: readonly string[], rows: readonly (readonly unknown[])[]) => {
  const normalizedRows = rows.map((row) => row.map(cell));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...normalizedRows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  return [
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...normalizedRows.map(renderRow),
  ].join("\n");
};

const readToolName = (tool: unknown) =>
  tool && typeof tool === "object" && "name" in tool
    ? String((tool as { name?: unknown }).name ?? "")
    : "";

const renderServerRows = (servers: readonly z.infer<typeof serverSchema>[]) =>
  renderTable(
    ["server", "name", "auth", "endpoint", "tools"],
    servers.map((server) => [
      server.slug,
      server.name,
      server.authMode,
      server.endpointUrl,
      Array.isArray(server.cache?.tools)
        ? server.cache.tools.map(readToolName).filter(Boolean)
        : [],
    ]),
  );

const renderServers = (result: McpListServersOutput) =>
  result.servers.length ? renderServerRows(result.servers) : "No MCP servers configured.";

const renderTools = (result: McpServerRefreshOutput) => {
  if (!result.ok) {
    return `MCP refresh failed: ${result.error?.message ?? "unknown error"}`;
  }
  return result.tools.length
    ? renderTable(
        ["tool", "title", "description"],
        result.tools.map((tool) => [tool.name, tool.title, tool.description]),
      )
    : "No tools advertised.";
};

const renderToolCall = (result: McpToolCallOutput) => {
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) =>
        item && typeof item === "object" && "text" in item
          ? String((item as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return stringifyMcpValue(result);
};

const parseScopes = (value: string | undefined) =>
  value
    ?.split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const readCliString = (parsed: ParsedCliTokens, name: string) => {
  const value = parsed.options.get(name);
  const lastValue = Array.isArray(value) ? value.at(-1) : value;
  if (typeof lastValue === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  return lastValue?.trim() || undefined;
};

const parseServersAdd = defineCliArgsParser<z.input<typeof createServerInputSchema>>(
  "mcp.servers.add",
  {
    slug: { required: true },
    endpointUrl: { option: "endpoint-url", required: true },
    name: {},
    auth: {
      read: (parsed) => {
        const mode = readCliString(parsed, "auth") ?? "none";
        const scopes = parseScopes(readCliString(parsed, "scope"));
        if (mode === "none") {
          return { type: "none" };
        }
        if (mode === "bearer") {
          return { type: "bearer", token: readCliString(parsed, "token") ?? "" };
        }
        if (mode === "oauth") {
          return {
            type: "oauth",
            clientId: readCliString(parsed, "client-id"),
            clientSecret: readCliString(parsed, "client-secret"),
            ...(scopes?.length ? { scopes } : {}),
          };
        }
        if (mode === "client_credentials") {
          return {
            type: "client_credentials",
            clientId: readCliString(parsed, "client-id") ?? "",
            clientSecret: readCliString(parsed, "client-secret") ?? "",
            ...(scopes?.length ? { scopes } : {}),
          };
        }
        throw new Error("--auth must be one of: none, bearer, oauth, client_credentials");
      },
    },
  },
);
const parseServerSlug = defineCliArgsParser<{ slug: string }>("mcp.server", {
  slug: { required: true, option: "server" },
});
const parseOAuthStart = defineCliArgsParser<z.input<typeof mcpOAuthStartInputSchema>>(
  "mcp.oauth.start",
  {
    slug: { required: true, option: "server" },
    scope: {},
    clientId: { option: "client-id" },
    clientSecret: { option: "client-secret" },
  },
);
const parseSetToken = defineCliArgsParser<z.input<typeof mcpSetTokenInputSchema>>(
  "mcp.auth.token",
  {
    slug: { required: true, option: "server" },
    token: { required: true },
  },
);
const parseToolCall = defineCliArgsParser<z.input<typeof callToolInputSchema>>("mcp.tools.call", {
  slug: { required: true, option: "server" },
  name: { required: true },
  arguments: { option: "arguments-json", kind: "json" },
  timeoutMs: { option: "timeout-ms", kind: "integer" },
});

const mcpPermissions = {
  "servers.read": "Read MCP server configuration and cached tool metadata.",
  "servers.create": "Create MCP server configuration and auth state.",
  "servers.delete": "Delete MCP server configuration and auth state.",
  "tools.call": "Call tools exposed by configured MCP servers.",
} as const;

export const mcpRuntimeTools = [
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.servers.list"),
    namespace: "mcp",
    name: "listServers",
    capabilityId: "mcp",
    requiredPermissions: ["servers.read"],
    execute: async (_input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).listServers(),
    adapters: {
      bash: {
        command: "mcp.servers.list",
        help: {
          summary: "mcp.servers.list lists configured MCP servers.",
          options: [],
          examples: ["mcp.servers.list"],
        },
        parse: defineNoInputArgsParser("mcp.servers.list"),
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderServers),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.servers.add"),
    namespace: "mcp",
    name: "createServer",
    capabilityId: "mcp",
    requiredPermissions: ["servers.create"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).createServer(input),
    adapters: {
      bash: {
        command: "mcp.servers.add",
        help: {
          summary: "mcp.servers.add registers a remote MCP server.",
          options: [
            {
              name: "slug",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "Stable server slug",
            },
            {
              name: "endpoint-url",
              required: true,
              valueRequired: true,
              valueName: "url",
              description: "Streamable HTTP MCP endpoint URL",
            },
            { name: "name", valueRequired: true, valueName: "name", description: "Display name" },
            {
              name: "auth",
              valueRequired: true,
              valueName: "mode",
              description: "none|bearer|oauth|client_credentials",
            },
            {
              name: "token",
              valueRequired: true,
              valueName: "token",
              description: "Bearer token for --auth bearer",
            },
            {
              name: "scope",
              valueRequired: true,
              valueName: "scopes",
              description: "Space/comma separated OAuth scopes",
            },
            {
              name: "client-id",
              valueRequired: true,
              valueName: "id",
              description: "OAuth client id",
            },
            {
              name: "client-secret",
              valueRequired: true,
              valueName: "secret",
              description: "OAuth client secret",
            },
          ],
          examples: [
            "mcp.servers.add --slug docs --endpoint-url https://mcp.example.com/mcp --auth oauth",
            "mcp.servers.add --slug internal --endpoint-url https://mcp.example.com/mcp --auth bearer --token $TOKEN",
          ],
        },
        parse: parseServersAdd,
        outputOptions: defaultOutput,
        format: textOrDataFormat(
          (server: McpCreateServerOutput) => `Created MCP server\n\n${renderServerRows([server])}`,
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.servers.delete"),
    namespace: "mcp",
    name: "deleteServer",
    capabilityId: "mcp",
    requiredPermissions: ["servers.delete"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).deleteServer(input),
    adapters: {
      bash: {
        command: "mcp.servers.delete",
        help: {
          summary: "mcp.servers.delete removes a configured MCP server and its auth state.",
          options: [
            {
              name: "server",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "MCP server slug",
            },
          ],
          examples: ["mcp.servers.delete --server docs"],
        },
        parse: parseServerSlug,
        outputOptions: defaultOutput,
        format: textOrDataFormat(() => "Deleted MCP server."),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.servers.refresh"),
    namespace: "mcp",
    name: "refreshServer",
    capabilityId: "mcp",
    requiredPermissions: ["servers.read"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).refreshServer(input),
    adapters: {
      bash: {
        command: "mcp.servers.refresh",
        help: {
          summary: "mcp.servers.refresh refreshes a configured MCP server's cached tool list.",
          options: [
            {
              name: "server",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "MCP server slug",
            },
          ],
          examples: [
            "mcp.servers.refresh --server docs",
            "mcp.servers.refresh --server docs --print tools",
          ],
        },
        parse: parseServerSlug,
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderTools),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.tools.call"),
    namespace: "mcp",
    name: "callTool",
    capabilityId: "mcp",
    requiredPermissions: ["tools.call"],
    getResource: (input) => ({ slug: input.slug, toolName: input.name }),
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).callTool(input),
    adapters: {
      bash: {
        command: "mcp.tools.call",
        help: {
          summary: "mcp.tools.call invokes a tool on a configured MCP server.",
          options: [
            {
              name: "server",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "MCP server slug",
            },
            {
              name: "name",
              required: true,
              valueRequired: true,
              valueName: "tool",
              description: "Tool name",
            },
            {
              name: "arguments-json",
              valueRequired: true,
              valueName: "json",
              description: "Tool arguments as a JSON object",
            },
            {
              name: "timeout-ms",
              valueRequired: true,
              valueName: "ms",
              description: "Request timeout in milliseconds",
            },
          ],
          examples: [
            'mcp.tools.call --server docs --name search --arguments-json \'{"query":"fragno"}\'',
          ],
        },
        parse: parseToolCall,
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderToolCall),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.oauth.start"),
    namespace: "mcp",
    name: "startOAuth",
    capabilityId: "mcp",
    requiredPermissions: ["servers.create"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).startOAuth(input),
    adapters: {
      bash: {
        command: "mcp.oauth.start",
        help: {
          summary: "mcp.oauth.start starts OAuth login for an MCP server.",
          options: [
            {
              name: "server",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "MCP server slug",
            },
            { name: "scope", valueRequired: true, valueName: "scope", description: "OAuth scopes" },
            {
              name: "client-id",
              valueRequired: true,
              valueName: "id",
              description: "OAuth client id",
            },
            {
              name: "client-secret",
              valueRequired: true,
              valueName: "secret",
              description: "OAuth client secret",
            },
          ],
          examples: ["mcp.oauth.start --server docs --scope tools"],
        },
        parse: parseOAuthStart,
        outputOptions: defaultOutput,
        format: textOrDataFormat(
          (result: McpOAuthStartOutput) =>
            `Open this URL to authorize MCP server access:\n${result.authorizationUrl}\nstate=${result.state}`,
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("mcp.auth.token"),
    namespace: "mcp",
    name: "setToken",
    capabilityId: "mcp",
    requiredPermissions: ["servers.create"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).setToken(input),
    adapters: {
      bash: {
        command: "mcp.auth.token",
        help: {
          summary: "mcp.auth.token stores a bearer token for an MCP server.",
          options: [
            {
              name: "server",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "MCP server slug",
            },
            {
              name: "token",
              required: true,
              valueRequired: true,
              valueName: "token",
              description: "Bearer token",
            },
          ],
          examples: ["mcp.auth.token --server docs --token $TOKEN"],
        },
        parse: parseSetToken,
        outputOptions: defaultOutput,
        format: textOrDataFormat((result: McpAuthStatus) =>
          renderTable(["authenticated", "mode"], [[result.authenticated, result.mode]]),
        ),
      },
    },
  }),
] as const;

export const mcpToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "mcp",
  permissions: mcpPermissions,
  tools: mcpRuntimeTools,
  isAvailable: (context: McpToolContext) => !!context.runtimes.mcp,
});
