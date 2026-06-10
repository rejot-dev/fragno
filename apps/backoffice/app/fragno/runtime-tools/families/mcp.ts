import { z } from "zod";

import {
  defineCliArgsParser,
  defineEmptyArgsParser,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { McpRuntime } from "./mcp-runtime";

const nonEmptyString = z.string().trim().min(1);
const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: nonEmptyString }),
  z.object({
    type: z.literal("oauth"),
    clientId: nonEmptyString.optional(),
    clientSecret: nonEmptyString.optional(),
    scopes: z.array(nonEmptyString).optional(),
  }),
  z.object({
    type: z.literal("client_credentials"),
    clientId: nonEmptyString,
    clientSecret: nonEmptyString,
    scopes: z.array(nonEmptyString).optional(),
  }),
]);

const serverSchema = z.object({
  slug: nonEmptyString,
  name: z.string().nullable().optional(),
  endpointUrl: nonEmptyString,
  authMode: nonEmptyString,
});
const serversOutputSchema = z.object({ servers: z.array(serverSchema) });
const createServerInputSchema = z.object({
  slug: nonEmptyString.regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().optional(),
  endpointUrl: z.string().url(),
  auth: authSchema.default({ type: "none" }),
});
const deleteServerInputSchema = z.object({ slug: nonEmptyString });
const deleteServerOutputSchema = z.object({ ok: z.literal(true) });
const authStatusSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
const oauthStartInputSchema = z.object({
  slug: nonEmptyString,
  scope: z.string().trim().optional(),
  clientId: z.string().trim().optional(),
  clientSecret: z.string().trim().optional(),
});
const oauthStartOutputSchema = z.object({ authorizationUrl: z.string().url(), state: z.string() });
const setTokenInputSchema = z.object({ slug: nonEmptyString, token: nonEmptyString });
const mcpToolSchema = z.object({
  name: nonEmptyString,
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const listToolsInputSchema = z.object({ slug: nonEmptyString });
const listToolsOutputSchema = z.object({ tools: z.array(mcpToolSchema) });
const callToolInputSchema = z.object({
  slug: nonEmptyString,
  name: nonEmptyString,
  arguments: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});
const callToolOutputSchema = z.record(z.string(), z.unknown());

export type McpListServersOutput = z.infer<typeof serversOutputSchema>;
export type McpCreateServerOutput = z.infer<typeof serverSchema>;
export type McpAuthStatus = z.infer<typeof authStatusSchema>;
export type McpOAuthStartInput = Omit<z.infer<typeof oauthStartInputSchema>, "slug">;
export type McpOAuthStartOutput = z.infer<typeof oauthStartOutputSchema>;
export type McpSetTokenInput = Omit<z.infer<typeof setTokenInputSchema>, "slug">;
export type McpListToolsOutput = z.infer<typeof listToolsOutputSchema>;
export type McpToolCallOutput = z.infer<typeof callToolOutputSchema>;
export type { McpRuntime } from "./mcp-runtime";

type McpToolContext = BackofficeToolContext<{ mcp?: McpRuntime }>;

const getMcpRuntime = (runtime: McpToolContext["runtimes"]["mcp"]): McpRuntime => {
  if (!runtime) {
    throw new Error("MCP runtime is not available in this execution context");
  }
  return runtime;
};

const defaultStructuredOutput = (_args: string[], parsed: ParsedCliTokens) => {
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};
const dataFormat = <T>(result: T) => ({ data: result });

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
const parseOAuthStart = defineCliArgsParser<z.input<typeof oauthStartInputSchema>>(
  "mcp.oauth.start",
  {
    slug: { required: true, option: "server" },
    scope: {},
    clientId: { option: "client-id" },
    clientSecret: { option: "client-secret" },
  },
);
const parseSetToken = defineCliArgsParser<z.input<typeof setTokenInputSchema>>("mcp.auth.token", {
  slug: { required: true, option: "server" },
  token: { required: true },
});
const parseToolCall = defineCliArgsParser<z.input<typeof callToolInputSchema>>("mcp.tools.call", {
  slug: { required: true, option: "server" },
  name: { required: true },
  arguments: { option: "arguments-json", kind: "json" },
  timeoutMs: { option: "timeout-ms", kind: "integer" },
});

export const mcpRuntimeTools = [
  defineBackofficeRuntimeTool({
    id: "mcp.servers.list",
    namespace: "mcp",
    name: "listServers",
    capabilityId: "mcp",
    description: "List MCP servers configured for the current organisation.",
    inputSchema: z.object({}).optional().default({}),
    outputSchema: serversOutputSchema,
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
        parse: defineEmptyArgsParser("mcp.servers.list"),
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "mcp.servers.add",
    namespace: "mcp",
    name: "createServer",
    capabilityId: "mcp",
    description: "Register a remote streamable HTTP MCP server.",
    inputSchema: createServerInputSchema,
    outputSchema: serverSchema,
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
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "mcp.servers.delete",
    namespace: "mcp",
    name: "deleteServer",
    capabilityId: "mcp",
    description: "Delete an MCP server and its stored auth state.",
    inputSchema: deleteServerInputSchema,
    outputSchema: deleteServerOutputSchema,
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
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "mcp.tools.list",
    namespace: "mcp",
    name: "listTools",
    capabilityId: "mcp",
    description: "List tools advertised by a configured MCP server.",
    inputSchema: listToolsInputSchema,
    outputSchema: listToolsOutputSchema,
    execute: async (input, context: McpToolContext) =>
      await getMcpRuntime(context.runtimes.mcp).listTools(input),
    adapters: {
      bash: {
        command: "mcp.tools.list",
        help: {
          summary: "mcp.tools.list lists tools from a configured MCP server.",
          options: [
            {
              name: "server",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "MCP server slug",
            },
          ],
          examples: ["mcp.tools.list --server docs", "mcp.tools.list --server docs --print tools"],
        },
        parse: parseServerSlug,
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "mcp.tools.call",
    namespace: "mcp",
    name: "callTool",
    capabilityId: "mcp",
    description: "Call a tool exposed by a configured MCP server.",
    inputSchema: callToolInputSchema,
    outputSchema: callToolOutputSchema,
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
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "mcp.oauth.start",
    namespace: "mcp",
    name: "startOAuth",
    capabilityId: "mcp",
    description: "Start OAuth login for a configured MCP server and return the authorization URL.",
    inputSchema: oauthStartInputSchema,
    outputSchema: oauthStartOutputSchema,
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
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "mcp.auth.token",
    namespace: "mcp",
    name: "setToken",
    capabilityId: "mcp",
    description: "Store a bearer token for a configured MCP server.",
    inputSchema: setTokenInputSchema,
    outputSchema: authStatusSchema,
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
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
] as const;

export const mcpToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "mcp",
  tools: mcpRuntimeTools,
  isAvailable: (context: McpToolContext) => !!context.runtimes.mcp,
});
