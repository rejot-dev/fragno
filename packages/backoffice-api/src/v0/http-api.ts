import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { dateTimeStringOutputSchema } from "./shared/datetime";

export const webhookSecretRefSchema = z.string().trim().min(1);

export const apiResponseBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json"), value: z.unknown() }),
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("empty"), value: z.null() }),
]);

export type ApiResponseBody = z.infer<typeof apiResponseBodySchema>;

const webhookRequestValueNameSchema = z.string().trim().min(1);

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

export type WebhookEndpointAuthInput = z.infer<typeof webhookEndpointAuthInputSchema>;

export const apiRequestBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty") }),
  z.object({ type: z.literal("json"), value: z.unknown() }),
  z.object({ type: z.literal("text"), value: z.string() }),
]);

export type ApiRequestBody = z.infer<typeof apiRequestBodySchema>;

export const apiHttpResponseSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  body: apiResponseBodySchema,
});

export type ApiHttpResponse = z.infer<typeof apiHttpResponseSchema>;

export const webhookRequestValueSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), name: webhookRequestValueNameSchema }),
  z.object({ type: z.literal("query"), name: webhookRequestValueNameSchema }),
  z.object({
    type: z.literal("jsonBodyPath"),
    path: z.array(z.string().trim().min(1)).min(1),
  }),
]);

export const webhookVerificationPredicateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("present"),
    source: webhookRequestValueSourceSchema,
  }),
  z.object({
    type: z.literal("equals"),
    source: webhookRequestValueSourceSchema,
    value: z.string().min(1),
  }),
]);

export const webhookVerificationConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("challenge"),
    method: z.enum(["GET", "POST"]),
    when: webhookVerificationPredicateSchema,
    response: z.object({
      type: z.literal("echoText"),
      source: webhookRequestValueSourceSchema,
    }),
  }),
]);

export const webhookEndpointStatusSchema = z.enum(["draft", "active", "disabled"]);

export const webhookDeliveryIdentitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), name: webhookRequestValueNameSchema }),
  z.object({ type: z.literal("query"), name: webhookRequestValueNameSchema }),
  z.object({
    type: z.literal("jsonBodyPath"),
    path: z.array(z.string().trim().min(1)).min(1),
  }),
]);

export const updateWebhookEndpointInputSchema = z.object({
  name: z.string().min(1).optional(),
  status: webhookEndpointStatusSchema.optional(),
  verification: webhookVerificationConfigSchema.optional(),
  deliveryIdentity: webhookDeliveryIdentitySchema.optional(),
  auth: webhookEndpointAuthInputSchema.optional(),
});

export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointInputSchema>;

export const createWebhookEndpointInputSchema = z.object({
  name: z.string().min(1),
  status: webhookEndpointStatusSchema.default("active"),
  verification: webhookVerificationConfigSchema,
  deliveryIdentity: webhookDeliveryIdentitySchema,
  auth: webhookEndpointAuthInputSchema,
});

export type WebhookEndpointInput = z.infer<typeof createWebhookEndpointInputSchema>;

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

export const requestOutputSchema = apiRequestOutputSchema;

export type ApiRequestOutput = z.infer<typeof requestOutputSchema>;

export const apiRequestInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: apiRequestBodySchema,
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

export type ApiRequestInput = z.infer<typeof apiRequestInputSchema>;

export type WebhookRequestValueSource = z.infer<typeof webhookRequestValueSourceSchema>;

export const secretRefSchema = z.string().trim().min(1);

export const requestValueNameSchema = z.string().trim().min(1);

export type WebhookVerificationConfig = z.infer<typeof webhookVerificationConfigSchema>;

export type WebhookDeliveryIdentity = z.infer<typeof webhookDeliveryIdentitySchema>;

export const webhookAuthConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), tokenRef: secretRefSchema }),
  z.object({
    type: z.literal("apiKey"),
    location: z.enum(["header", "query"]),
    name: requestValueNameSchema,
    secretRef: secretRefSchema,
  }),
  z.object({
    type: z.literal("basic"),
    usernameRef: secretRefSchema,
    passwordRef: secretRefSchema,
  }),
  z.object({
    type: z.literal("hmac"),
    secretRef: secretRefSchema,
    algorithm: z.enum(["sha1", "sha256", "sha512"]),
    signature: z.object({
      location: z.enum(["header", "query"]),
      name: requestValueNameSchema,
      encoding: z.enum(["hex", "base64", "base64url"]),
      prefix: z.string().optional(),
    }),
    signedPayload: z.discriminatedUnion("type", [
      z.object({ type: z.literal("rawBody") }),
      z.object({
        type: z.literal("timestampedBody"),
        prefix: z.string(),
        timestampHeader: requestValueNameSchema,
        delimiter: z.string(),
        toleranceSeconds: z.number().int().positive(),
      }),
    ]),
  }),
]);

export type WebhookAuthConfig = z.infer<typeof webhookAuthConfigSchema>;

export const webhookEndpointOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: webhookEndpointStatusSchema,
  authConfig: webhookAuthConfigSchema,
  verification: webhookVerificationConfigSchema,
  deliveryIdentity: webhookDeliveryIdentitySchema,
  secretRefs: z.array(z.string()),
  createdAt: dateTimeStringOutputSchema.optional(),
  updatedAt: dateTimeStringOutputSchema.optional(),
});

export type WebhookEndpoint = z.infer<typeof webhookEndpointOutputSchema>;

export const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().trim().min(1) }),
  z.object({
    type: z.literal("basic"),
    username: z.string().trim().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("oauth"),
    authorizationEndpoint: z.url(),
    tokenEndpoint: z.url(),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1).optional(),
    scopes: z.array(z.string().trim().min(1)).optional(),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post", "none"]),
  }),
  z.object({
    type: z.literal("client_credentials"),
    tokenEndpoint: z.url(),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    scopes: z.array(z.string().trim().min(1)).optional(),
    audience: z.string().trim().min(1).optional(),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]),
  }),
]);

export const apiAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  mode: z.string(),
  expiresAt: dateTimeStringOutputSchema.nullable().optional(),
});

export type ApiAuthStatus = z.infer<typeof apiAuthStatusSchema>;

export const connectionSchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().nullable().optional(),
  baseUrl: z.url(),
  authMode: z.string().trim().min(1),
  status: z.string().trim().min(1),
  createdAt: dateTimeStringOutputSchema.optional(),
  updatedAt: dateTimeStringOutputSchema.optional(),
});

export type ApiConnection = z.infer<typeof connectionSchema>;

export const connectionsOutputSchema = z.object({ connections: z.array(connectionSchema) });

export type ApiListConnectionsOutput = z.infer<typeof connectionsOutputSchema>;

export const createConnectionInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().optional(),
  baseUrl: z.url(),
  auth: authSchema.default({ type: "none" }),
});

export const deleteOutputSchema = z.object({ ok: z.literal(true) });

export const endpointInputSchema = z.object({ endpointId: z.string().trim().min(1) });

export const apiOAuthStartInputSchema = z.object({
  slug: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)).optional(),
  extraAuthorizationParams: z.record(z.string(), z.string()).optional(),
});

export const apiOAuthStartOutputSchema = z.object({ authorizationUrl: z.url(), state: z.string() });

export type ApiOAuthStartOutput = z.infer<typeof apiOAuthStartOutputSchema>;

export const requestInputSchema = apiRequestInputSchema.extend({
  slug: z.string().trim().min(1),
});

export const apiSetTokenInputSchema = z.object({
  slug: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

export const slugInputSchema = z.object({ slug: z.string().trim().min(1) });

export const webhookEndpointCreateInputSchema = createWebhookEndpointInputSchema.extend({
  endpointId: z.string().trim().min(1),
});

export const webhookEndpointSchema = webhookEndpointOutputSchema.extend({
  publicUrl: z.url().nullable(),
});

export type ApiWebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

export const webhookEndpointUpdateInputSchema = updateWebhookEndpointInputSchema.extend({
  endpointId: z.string().trim().min(1),
});

export const webhookEndpointsOutputSchema = z.object({ endpoints: z.array(webhookEndpointSchema) });

export type ApiWebhookEndpointsOutput = z.infer<typeof webhookEndpointsOutputSchema>;

export const httpApiOperations = {
  "api.connections.list": {
    description: "List API connections configured for the current scope.",
    input: z.void(),
    output: connectionsOutputSchema,
  },
  "api.connections.create": {
    description: "Create an outbound HTTP API connection.",
    input: createConnectionInputSchema,
    output: connectionSchema,
  },
  "api.connections.delete": {
    description: "Delete an API connection and its stored auth state.",
    input: slugInputSchema,
    output: deleteOutputSchema,
  },
  "api.auth.status": {
    description: "Read auth status for an API connection.",
    input: slugInputSchema,
    output: apiAuthStatusSchema,
  },
  "api.auth.token": {
    description: "Store a bearer token for a configured API connection.",
    input: apiSetTokenInputSchema,
    output: apiAuthStatusSchema,
  },
  "api.oauth.start": {
    description:
      "Start OAuth login for a configured API connection and return the authorization URL.",
    input: apiOAuthStartInputSchema,
    output: apiOAuthStartOutputSchema,
  },
  "api.auth.delete": {
    description: "Delete stored auth for an API connection.",
    input: slugInputSchema,
    output: deleteOutputSchema,
  },
  "api.webhooks.list": {
    description: "List API webhook endpoints configured for the current scope.",
    input: z.void(),
    output: webhookEndpointsOutputSchema,
  },
  "api.webhooks.get": {
    description: "Read an API webhook endpoint.",
    input: endpointInputSchema,
    output: webhookEndpointSchema,
  },
  "api.webhooks.create": {
    description: "Create or replace an API webhook endpoint.",
    input: webhookEndpointCreateInputSchema,
    output: webhookEndpointSchema,
  },
  "api.webhooks.update": {
    description: "Update an API webhook endpoint.",
    input: webhookEndpointUpdateInputSchema,
    output: webhookEndpointSchema,
  },
  "api.webhooks.delete": {
    description: "Delete an API webhook endpoint.",
    input: endpointInputSchema,
    output: deleteOutputSchema,
  },
  "api.request": {
    description: "Execute an HTTP request through a configured API connection.",
    input: requestInputSchema,
    output: requestOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
