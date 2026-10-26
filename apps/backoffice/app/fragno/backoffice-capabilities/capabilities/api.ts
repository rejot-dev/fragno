import { backofficeRoutableScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

const AUTOMATION_SOURCE = "api" as const;

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

const apiWebhookSubjectSchema = z.object({ scope: backofficeRoutableScopeSchema }).extend({
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
    actionProviders: ["integrations"],
    hookScopes: [
      {
        id: "api",
        label: "API",
        getRepository: ({ objects, scope }) =>
          createDurableHookRepositoryFromCommands(objects.api.for(scope).commands),
      },
    ],
    skillPaths: ["skills/configuring-integrations/SKILL.md", "skills/api-webhooks/SKILL.md"],
    externalEntities: [],
    automationEvents: [
      {
        source: AUTOMATION_SOURCE,
        eventType: "webhook.received",
        label: "API webhook received",
        description:
          "Fires when an API webhook endpoint receives and authenticates a delivery. Routes see the whole delivery; the stored event omits its headers, query, and body. Read them with the webhook connection's delivery.get action while the endpoint's retention keeps them.",
        payloadSchema: apiWebhookReceivedPayloadSchema,
        storedPayload: ({ endpointId, deliveryId, hookId, receivedAt, contentType }) => ({
          endpointId,
          deliveryId,
          hookId,
          receivedAt,
          contentType,
        }),
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
    ],
  },
};
