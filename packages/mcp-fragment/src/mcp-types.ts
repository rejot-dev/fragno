import { z } from "zod";

export interface McpFragmentConfig {
  /** Optional URL allow-list. If omitted, only http(s) URL syntax is checked. */
  allowedEndpointUrls?: (url: URL) => boolean;
  /** Allows OAuth callback URLs. OAuth start is rejected when this policy is omitted. */
  allowedOAuthRedirectUris?: (url: URL) => boolean;
  /** Optional fetch implementation for tests/custom runtimes. */
  fetch?: typeof fetch;
}

export const authConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    type: z.literal("client_credentials"),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scopes: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("oauth"),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  }),
]);

/** Slugs are URL path segments and OAuth state prefixes, so they exclude ':' and dot segments. */
export const mcpServerSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const createServerInputSchema = z.object({
  slug: mcpServerSlugSchema,
  name: z.string().optional(),
  endpointUrl: z.url(),
  auth: authConfigSchema.default({ type: "none" }),
});

/** Replacement keeps the slug and creation time; everything else is supplied again. */
export const replaceServerConfigurationInputSchema = createServerInputSchema.omit({ slug: true });

export const toolCallInputSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

export const tokenAuthInputSchema = z.object({
  token: z.string().min(1),
});

const mcpCredentialsPresenceSchema = z
  .enum(["present", "missing"])
  .describe("Whether credentials are stored, not whether the server accepts them.");

/** Sanitized auth state derived from stored configuration; it never proves live server access. */
export const mcpAuthStatusSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("bearer"), credentials: mcpCredentialsPresenceSchema }),
  z.object({ mode: z.literal("client_credentials"), credentials: mcpCredentialsPresenceSchema }),
  z.object({
    mode: z.literal("oauth"),
    state: z
      .enum(["consent-required", "consent-pending", "authorized", "expired"])
      .describe(
        "Expired means the access token expired and no refresh token is stored; pending means an unexpired authorization link exists.",
      ),
  }),
]);

/** The pending link embeds the callback state, so reading it needs server-create authority. */
export const mcpOAuthPendingSchema = z.object({
  pending: z
    .object({ authorizationUrl: z.url(), expiresAt: z.union([z.string(), z.date()]) })
    .nullable()
    .describe(
      "The newest unexpired, unconsumed authorization link; any pending link completes it.",
    ),
});

/** Mirrors the MCP protocol's tool definition, whose optional members are defined by the spec. */
export const mcpToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/** Tool errors are results the model should see; transport and auth failures are route errors. */
export const mcpToolCallResultSchema = z.object({
  isError: z.boolean(),
  content: z.array(z.record(z.string(), z.unknown())),
  structuredContent: z.record(z.string(), z.unknown()).nullable(),
});

/** Query parameter carrying the OAuth callback URI for an MCP OAuth start request. */
export const MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER = "redirectUri";

export const mcpOAuthRedirectUriSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "MCP OAuth redirect URI must use HTTP or HTTPS");

export const oauthStartInputSchema = z.object({
  scope: z.string().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  discardTokens: z
    .boolean()
    .default(false)
    .describe(
      "Drop stored tokens so status reports pending consent until this new consent completes.",
    ),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type CreateServerInput = z.infer<typeof createServerInputSchema>;
export type ToolCallInput = z.infer<typeof toolCallInputSchema>;
export type McpAuthStatus = z.infer<typeof mcpAuthStatusSchema>;
export type McpOAuthPending = z.infer<typeof mcpOAuthPendingSchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;
export type McpToolCallResult = z.infer<typeof mcpToolCallResultSchema>;
