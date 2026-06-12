import { z } from "zod";

export interface McpFragmentConfig {
  /** Public URL where this fragment is mounted; used to build OAuth redirects. */
  publicBaseUrl: string;
  /** Optional URL allow-list. If omitted, only http(s) URL syntax is checked. */
  allowedEndpointUrls?: (url: URL) => boolean;
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

export const createServerInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().optional(),
  endpointUrl: z.string().url(),
  auth: authConfigSchema.default({ type: "none" }),
});

export const toolCallInputSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

export const tokenAuthInputSchema = z.object({
  token: z.string().min(1),
});

export const oauthStartInputSchema = z.object({
  scope: z.string().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type CreateServerInput = z.infer<typeof createServerInputSchema>;
export type ToolCallInput = z.infer<typeof toolCallInputSchema>;

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
