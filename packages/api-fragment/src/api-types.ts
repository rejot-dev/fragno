import { z } from "zod";

export interface ApiFragmentConfig {
  /** Public URL where this fragment is mounted; used to build OAuth redirects. */
  publicBaseUrl: string;
  /** Optional URL allow-list. If omitted, only http(s) URL syntax is checked. */
  allowedBaseUrls?: (url: URL) => boolean;
  /** Optional fetch implementation for tests/custom runtimes. */
  fetch?: typeof fetch;
}

const tokenEndpointAuthMethodSchema = z.enum(["client_secret_basic", "client_secret_post", "none"]);

export const authConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    type: z.literal("client_credentials"),
    tokenEndpoint: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    audience: z.string().min(1).optional(),
    tokenEndpointAuthMethod: z
      .enum(["client_secret_basic", "client_secret_post"])
      .default("client_secret_basic"),
  }),
  z.object({
    type: z.literal("oauth"),
    authorizationEndpoint: z.string().url(),
    tokenEndpoint: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema.default("client_secret_basic"),
    extraAuthorizationParams: z.record(z.string(), z.string()).optional(),
    extraTokenParams: z.record(z.string(), z.string()).optional(),
  }),
]);

export const createApiConnectionInputSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  auth: authConfigSchema.default({ type: "none" }),
});

export const apiConnectionOutputSchema = z.object({
  slug: z.string(),
  name: z.string().nullable().optional(),
  baseUrl: z.string(),
  authMode: z.string(),
  status: z.string(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export const tokenAuthInputSchema = z.object({ token: z.string().min(1) });

export const oauthStartInputSchema = z.object({
  scopes: z.array(z.string()).optional(),
  extraAuthorizationParams: z.record(z.string(), z.string()).optional(),
});

export const apiRequestInputSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    json: z.unknown().optional(),
    body: z.string().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .refine((value) => value.json === undefined || value.body === undefined, {
    message: "Use either json or body, not both",
    path: ["body"],
  });

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type ApiConnectionInput = z.infer<typeof createApiConnectionInputSchema>;
export type ApiConnection = z.infer<typeof apiConnectionOutputSchema>;
export type ApiRequestInput = z.infer<typeof apiRequestInputSchema>;
