import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { dateTimeStringOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().trim().min(1) }),
  z.object({
    type: z.literal("oauth"),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional(),
    scopes: z.array(z.string().trim().min(1)).optional(),
  }),
  z.object({
    type: z.literal("client_credentials"),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    scopes: z.array(z.string().trim().min(1)).optional(),
  }),
]);

const mcpToolSchema = z.object({
  name: z.string().trim().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export type McpTool = z.infer<typeof mcpToolSchema>;

const serverConnectionCacheSchema = z.object({
  protocolVersion: z.string().nullable().optional(),
  serverInfo: z.unknown().nullable().optional(),
  capabilities: z.unknown().nullable().optional(),
  tools: z.array(mcpToolSchema).nullable().optional(),
  updatedAt: dateTimeStringOutputSchema.optional(),
});

export const mcpAuthStatusSchema = z.object({ authenticated: z.boolean(), mode: z.string() });

export type McpAuthStatus = z.infer<typeof mcpAuthStatusSchema>;

export const callToolInputSchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

const callToolOutputSchema = z.record(z.string(), z.unknown());

export type McpToolCallOutput = z.infer<typeof callToolOutputSchema>;

export const createServerInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().optional(),
  endpointUrl: z.url(),
  auth: authSchema.default({ type: "none" }),
});

const deleteServerInputSchema = z.object({ slug: z.string().trim().min(1) });

const deleteServerOutputSchema = z.object({ ok: z.literal(true) });

export const mcpOAuthStartInputSchema = z.object({
  slug: z.string().trim().min(1),
  scope: z.string().trim().optional(),
  clientId: z.string().trim().optional(),
  clientSecret: z.string().trim().optional(),
});

export const mcpOAuthStartOutputSchema = z.object({ authorizationUrl: z.url(), state: z.string() });

export type McpOAuthStartOutput = z.infer<typeof mcpOAuthStartOutputSchema>;

const refreshServerInputSchema = z.object({ slug: z.string().trim().min(1) });

export const serverSchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().nullable().optional(),
  endpointUrl: z.string().trim().min(1),
  authMode: z.string().trim().min(1),
  cache: serverConnectionCacheSchema.nullable().optional(),
});

const serverRefreshOutputSchema = z.object({
  ok: z.boolean(),
  tools: z.array(mcpToolSchema),
  stage: z.enum(["auth", "list_tools"]).nullable(),
  checkedAt: z.string(),
  server: serverSchema.omit({ cache: true }),
  auth: z.object({
    authenticated: z.boolean(),
    mode: z.string(),
    tokenPresent: z.boolean(),
    expiresAt: dateTimeStringOutputSchema.nullable(),
    expired: z.boolean().nullable(),
    scopes: z.object({
      requested: z.array(z.string()).nullable(),
      granted: z.array(z.string()).nullable(),
      missing: z.array(z.string()).nullable(),
      raw: z.string().nullable(),
    }),
  }),
  live: z.object({
    reachable: z.boolean(),
    listToolsOk: z.boolean(),
    toolCount: z.number().nullable(),
    protocolVersion: z.string().nullable(),
    serverInfo: z.unknown().nullable(),
    capabilities: z.unknown().nullable(),
  }),
  cache: z.object({
    presentBeforeCheck: z.boolean(),
    previousToolCount: z.number().nullable(),
    updatedToolCount: z.number().nullable(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export type McpServerRefreshOutput = z.infer<typeof serverRefreshOutputSchema>;

export type McpCreateServerOutput = z.infer<typeof serverSchema>;

const serversOutputSchema = z.object({ servers: z.array(serverSchema) });

export type McpListServersOutput = z.infer<typeof serversOutputSchema>;

export const mcpSetTokenInputSchema = z.object({
  slug: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

export const mcpOperations = {
  "mcp.servers.list": {
    description: "List MCP servers configured for the current organization.",
    permissions: [BACKOFFICE_PERMISSION.mcp.serversRead],
    input: z.void(),
    output: serversOutputSchema,
  },
  "mcp.servers.add": {
    description: "Register a remote streamable HTTP MCP server.",
    permissions: [BACKOFFICE_PERMISSION.mcp.serversCreate],
    input: createServerInputSchema,
    output: serverSchema,
  },
  "mcp.servers.delete": {
    description: "Delete an MCP server and its stored auth state.",
    permissions: [BACKOFFICE_PERMISSION.mcp.serversDelete],
    input: deleteServerInputSchema,
    output: deleteServerOutputSchema,
  },
  "mcp.servers.refresh": {
    description: "Refresh a configured MCP server and update its cached tool list.",
    permissions: [BACKOFFICE_PERMISSION.mcp.serversRead],
    input: refreshServerInputSchema,
    output: serverRefreshOutputSchema,
  },
  "mcp.tools.call": {
    description: "Call a tool exposed by a configured MCP server.",
    permissions: [BACKOFFICE_PERMISSION.mcp.toolsCall],
    input: callToolInputSchema,
    output: callToolOutputSchema,
  },
  "mcp.oauth.start": {
    description: "Start OAuth login for a configured MCP server and return the authorization URL.",
    permissions: [BACKOFFICE_PERMISSION.mcp.serversCreate],
    input: mcpOAuthStartInputSchema,
    output: mcpOAuthStartOutputSchema,
  },
  "mcp.auth.token": {
    description: "Store a bearer token for a configured MCP server.",
    permissions: [BACKOFFICE_PERMISSION.mcp.serversCreate],
    input: mcpSetTokenInputSchema,
    output: mcpAuthStatusSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
