import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeConfigurableConnectionCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createApiCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/api-files";
import { createApiWebhooksCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/api-webhooks-files";

import type { ApiAdminConfigResponse } from "../../../../workers/api.do";

export const apiConfigureInputSchema = z.object({});

const AUTOMATION_SOURCE = "api" as const;
const AUTOMATION_EVENT_CONNECTION_CHANGED = "connection.changed" as const;
const AUTOMATION_EVENT_CONNECTION_DELETED = "connection.deleted" as const;
const AUTOMATION_EVENT_CONNECTION_AVAILABLE = "connection.available" as const;
const AUTOMATION_EVENT_WEBHOOK_RECEIVED = "webhook.received" as const;
const AUTOMATION_EVENT_CAPABILITY_CONFIGURED = "capability.configured" as const;

const apiCapabilityConfiguredPayloadSchema = z.object({
  capabilityId: z.literal("api"),
  capabilityLabel: z.literal("API"),
});

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

const apiCapabilityConfiguredSubjectSchema = apiScopeSubjectSchema.extend({
  capabilityId: z.literal("api"),
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

const capability = { id: "api", label: "API", kind: "connection" } as const;
const getApiDo = ({
  objects,
  scope,
}: {
  objects: BackofficeObjectRegistry;
  scope: BackofficeContextScope;
}) => objects.api.for(scope);

const toApiStatus = (response: ApiAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["initialization"],
      nextSteps: ["Initialize API integrations for this organisation."],
    };
  }

  return {
    ...capability,
    configured: true,
    config: response.config,
  };
};

export const apiCapability: BackofficeConfigurableConnectionCapability = {
  ...capability,
  runtimeToolNamespaces: ["api"],
  get files() {
    return {
      ...createApiCapabilityFiles(),
      ...createApiWebhooksCapabilityFiles(),
    };
  },
  connection: {
    configurable: true,
    configureInputSchema: apiConfigureInputSchema,
    configureFields: [],
    getStatus: async ({ objects, scope }) =>
      toApiStatus(await getApiDo({ objects, scope }).getAdminConfig()),
    verify: async ({ objects, scope }) =>
      toApiStatus(await getApiDo({ objects, scope }).getAdminConfig()),
    reset: async ({ objects, scope }) =>
      toApiStatus(await getApiDo({ objects, scope }).resetAdminConfig()),
    configure: async ({ objects, scope, payload }) =>
      toApiStatus(
        await getApiDo({ objects, scope }).setAdminConfig({
          ...apiConfigureInputSchema.parse(payload),
          scope,
        }),
      ),
  },
  hooks: [
    {
      id: "api",
      label: "API",
      getRepository: ({ objects, scope }) =>
        getApiDo({ objects, scope }).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_CAPABILITY_CONFIGURED,
      label: "API configured",
      description: "Fires after the API capability is configured for a scope for the first time.",
      payloadSchema: apiCapabilityConfiguredPayloadSchema,
      subjectSchema: apiCapabilityConfiguredSubjectSchema,
      example: {
        capabilityId: "api",
        capabilityLabel: "API",
      },
    },
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
};
