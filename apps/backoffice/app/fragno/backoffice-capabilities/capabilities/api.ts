import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const AUTOMATION_SOURCE = "api" as const;
const AUTOMATION_EVENT_CONNECTION_CHANGED = "connection.changed" as const;
const AUTOMATION_EVENT_CONNECTION_DELETED = "connection.deleted" as const;
const AUTOMATION_EVENT_CONNECTION_AVAILABLE = "connection.available" as const;
const AUTOMATION_EVENT_WEBHOOK_RECEIVED = "webhook.received" as const;
const apiConnectionSnapshotSchema = z.object({
  slug: z.string().min(1),
  name: z.string().nullable(),
  baseUrl: z.url(),
  authMode: z.string().min(1),
  status: z.string().min(1),
});

const apiConnectionChangedPayloadSchema = z.object({
  connectionId: z.string().min(1),
  connection: apiConnectionSnapshotSchema,
});

const apiConnectionDeletedPayloadSchema = z.object({
  connectionId: z.string().min(1),
  previous: apiConnectionSnapshotSchema,
});

const apiConnectionAvailablePayloadSchema = z.object({
  connectionId: z.string().min(1),
  connection: apiConnectionSnapshotSchema,
  authMode: z.string().min(1),
});

const apiScopeSubjectSchema = z.object({
  scope: z.looseObject({ kind: z.string().min(1) }),
  orgId: z.string().min(1).optional(),
});

const apiConnectionSubjectSchema = apiScopeSubjectSchema.extend({
  connectionId: z.string().min(1),
});

const apiWebhookReceivedPayloadSchema = z.object({
  endpointId: z.string().min(1),
  deliveryId: z.string().min(1),
  hookId: z.string().min(1),
  receivedAt: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  body: z.record(z.string(), z.unknown()),
  contentType: z.string().nullable(),
});

const apiWebhookSubjectSchema = apiScopeSubjectSchema.extend({
  endpointId: z.string().min(1),
  deliveryId: z.string().min(1),
});

export const apiCapability: BackofficeCapability = {
  id: "api",
  label: "API",
  objectBinding: "API",
  contributions: {
    connection: null,
    eventSources: [],
    actionProviders: ["api"],
    hookScopes: [
      {
        id: "api",
        label: "API",
        getRepository: ({ objects, scope }) => objects.api.for(scope).getDurableHookRepository(),
      },
    ],
    skillPaths: ["skills/api-connection/SKILL.md", "skills/api-webhooks/SKILL.md"],
    externalEntities: [],
    automationEvents: [
      {
        source: AUTOMATION_SOURCE,
        eventType: AUTOMATION_EVENT_CONNECTION_CHANGED,
        label: "API connection changed",
        description: "Fires when an API connection is created or its configuration changes.",
        payloadSchema: apiConnectionChangedPayloadSchema,
        subjectSchema: apiConnectionSubjectSchema,
        example: {
          connectionId: "stripe-api",
          connection: {
            slug: "stripe-api",
            name: "Stripe API",
            baseUrl: "https://api.stripe.com",
            authMode: "bearer",
            status: "active",
          },
        },
      },
      {
        source: AUTOMATION_SOURCE,
        eventType: AUTOMATION_EVENT_CONNECTION_DELETED,
        label: "API connection deleted",
        description: "Fires when an API connection is deleted.",
        payloadSchema: apiConnectionDeletedPayloadSchema,
        subjectSchema: apiConnectionSubjectSchema,
        example: {
          connectionId: "stripe-api",
          previous: {
            slug: "stripe-api",
            name: "Stripe API",
            baseUrl: "https://api.stripe.com",
            authMode: "bearer",
            status: "active",
          },
        },
      },
      {
        source: AUTOMATION_SOURCE,
        eventType: AUTOMATION_EVENT_WEBHOOK_RECEIVED,
        label: "API webhook received",
        description: "Fires when an API webhook endpoint receives and authenticates a delivery.",
        payloadSchema: apiWebhookReceivedPayloadSchema,
        subjectSchema: apiWebhookSubjectSchema,
        example: {
          endpointId: "stripe",
          deliveryId: "evt_123",
          hookId: "webhook_abc123",
          receivedAt: "2026-06-23T12:00:00.000Z",
          headers: { "content-type": "application/json" },
          query: {},
          body: { type: "payment_intent.succeeded" },
          contentType: "application/json",
        },
      },
      {
        source: AUTOMATION_SOURCE,
        eventType: AUTOMATION_EVENT_CONNECTION_AVAILABLE,
        label: "API connection available",
        description: "Fires when configured API authentication becomes usable.",
        payloadSchema: apiConnectionAvailablePayloadSchema,
        subjectSchema: apiConnectionSubjectSchema,
        example: {
          connectionId: "stripe-api",
          authMode: "bearer",
          connection: {
            slug: "stripe-api",
            name: "Stripe API",
            baseUrl: "https://api.stripe.com",
            authMode: "bearer",
            status: "active",
          },
        },
      },
    ],
  },
};
