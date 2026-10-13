import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { dateTimeStringOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const webhookSecretRefSchema = z.string().trim().min(1);

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

/** Sanitized auth state derived from stored configuration; it never proves live provider access. */
/** Slugs are URL path segments; whitespace and dot segments would make a connection unaddressable. */
export const deleteOutputSchema = z.object({ ok: z.literal(true) });

export const endpointInputSchema = z.object({ endpointId: z.string().trim().min(1) });

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
  "api.webhooks.list": {
    description: "List API webhook endpoints configured for the current scope.",
    permissions: [BACKOFFICE_PERMISSION.connections.read],
    input: z.void(),
    output: webhookEndpointsOutputSchema,
  },
  "api.webhooks.get": {
    description: "Read an API webhook endpoint.",
    permissions: [BACKOFFICE_PERMISSION.connections.read],
    input: endpointInputSchema,
    output: webhookEndpointSchema,
  },
  "api.webhooks.create": {
    description: "Create or replace an API webhook endpoint.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: webhookEndpointCreateInputSchema,
    output: webhookEndpointSchema,
  },
  "api.webhooks.update": {
    description: "Update an API webhook endpoint.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: webhookEndpointUpdateInputSchema,
    output: webhookEndpointSchema,
  },
  "api.webhooks.delete": {
    description: "Delete an API webhook endpoint.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: endpointInputSchema,
    output: deleteOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
