import { z } from "zod";

import { webhookAuthConfigSchema } from "./webhooks/auth";
import { webhookVerificationConfigSchema } from "./webhooks/verification";

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
    type: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("client_credentials"),
    tokenEndpoint: z.url(),
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
    authorizationEndpoint: z.url(),
    tokenEndpoint: z.url(),
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
  baseUrl: z.url(),
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

export const apiRequestBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty") }),
  z.object({ type: z.literal("json"), value: z.unknown() }),
  z.object({ type: z.literal("text"), value: z.string() }),
]);

export const apiRequestInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: apiRequestBodySchema,
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

export const apiResponseBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json"), value: z.unknown() }),
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("empty"), value: z.null() }),
]);

export const apiHttpResponseSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  body: apiResponseBodySchema,
});

export const apiRequestOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    response: apiHttpResponseSchema,
    error: z.null(),
  }),
  z.object({
    ok: z.literal(false),
    response: apiHttpResponseSchema.nullable(),
    error: z.object({
      code: z.enum([
        "HTTP_ERROR",
        "REQUEST_ERROR",
        "RESPONSE_DECODING_ERROR",
        "CONNECTION_NOT_FOUND",
        "CONNECTION_DISABLED",
      ]),
      message: z.string(),
    }),
  }),
]);

const webhookSecretRefSchema = z.string().trim().min(1);
const webhookRequestValueNameSchema = z.string().trim().min(1);

export const webhookDeliveryIdentitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), name: webhookRequestValueNameSchema }),
  z.object({ type: z.literal("query"), name: webhookRequestValueNameSchema }),
  z.object({
    type: z.literal("jsonBodyPath"),
    path: z.array(z.string().trim().min(1)).min(1),
  }),
]);

export const webhookEndpointAuthInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: webhookSecretRefSchema }),
  z.object({
    type: z.literal("apiKey"),
    location: z.enum(["header", "query"]),
    name: webhookRequestValueNameSchema,
    secret: webhookSecretRefSchema,
  }),
  z.object({
    type: z.literal("basic"),
    username: webhookSecretRefSchema,
    password: webhookSecretRefSchema,
  }),
  z.object({
    type: z.literal("hmac"),
    secret: webhookSecretRefSchema,
    algorithm: z.enum(["sha1", "sha256", "sha512"]),
    signature: z.object({
      location: z.enum(["header", "query"]),
      name: webhookRequestValueNameSchema,
      encoding: z.enum(["hex", "base64", "base64url"]),
      prefix: z.string().optional(),
    }),
    signedPayload: z.discriminatedUnion("type", [
      z.object({ type: z.literal("rawBody") }),
      z.object({
        type: z.literal("timestampedBody"),
        prefix: z.string(),
        timestampHeader: webhookRequestValueNameSchema,
        delimiter: z.string(),
        toleranceSeconds: z.number().int().positive(),
      }),
    ]),
  }),
]);

export const webhookEndpointStatusSchema = z.enum(["draft", "active", "disabled"]);

export const webhookEndpointOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: webhookEndpointStatusSchema,
  authConfig: webhookAuthConfigSchema,
  verification: webhookVerificationConfigSchema,
  deliveryIdentity: webhookDeliveryIdentitySchema,
  secretRefs: z.array(z.string()),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export const createWebhookEndpointInputSchema = z.object({
  name: z.string().min(1),
  status: webhookEndpointStatusSchema.default("active"),
  verification: webhookVerificationConfigSchema,
  deliveryIdentity: webhookDeliveryIdentitySchema,
  auth: webhookEndpointAuthInputSchema,
});

export const updateWebhookEndpointInputSchema = z.object({
  name: z.string().min(1).optional(),
  status: webhookEndpointStatusSchema.optional(),
  verification: webhookVerificationConfigSchema.optional(),
  deliveryIdentity: webhookDeliveryIdentitySchema.optional(),
  auth: webhookEndpointAuthInputSchema.optional(),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type ApiConnectionInput = z.infer<typeof createApiConnectionInputSchema>;
export type ApiConnection = z.infer<typeof apiConnectionOutputSchema>;
export type ApiRequestBody = z.infer<typeof apiRequestBodySchema>;
export type ApiRequestInput = z.infer<typeof apiRequestInputSchema>;
export type ApiResponseBody = z.infer<typeof apiResponseBodySchema>;
export type ApiHttpResponse = z.infer<typeof apiHttpResponseSchema>;
export type ApiRequestOutput = z.infer<typeof apiRequestOutputSchema>;
export type WebhookDeliveryIdentity = z.infer<typeof webhookDeliveryIdentitySchema>;
export type WebhookEndpointAuthInput = z.infer<typeof webhookEndpointAuthInputSchema>;
export type WebhookEndpointInput = z.infer<typeof createWebhookEndpointInputSchema>;
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointInputSchema>;
export type WebhookEndpoint = z.infer<typeof webhookEndpointOutputSchema>;
