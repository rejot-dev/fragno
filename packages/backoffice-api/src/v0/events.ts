import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { type AutomationActors, automationActorsSchema } from "./automation";
import { type BackofficeContextScope, backofficeContextScopeSchema } from "./shared/scope";

export type AutomationEventPayload = Record<string, unknown>;

export type AutomationEventSubject = {
  orgId?: string;
  userId?: string;
  [key: string]: unknown;
};

export type AutomationEvent = {
  id: string;
  scope: BackofficeContextScope;
  scopeRestriction: BackofficeContextScope | null;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: AutomationEventPayload;
  actors: AutomationActors;
  subject?: AutomationEventSubject | null;
};

export const idSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "valueOf" in value) {
    const primitive = value.valueOf();
    if (typeof primitive === "string" || typeof primitive === "number") {
      return String(primitive);
    }
  }
  return value;
}, z.string());

const automationEventSubjectSchema: z.ZodType<AutomationEventSubject> = z
  .object({
    orgId: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
  })
  .catchall(z.unknown());

export const automationEventSchema = z.object({
  id: idSchema,
  scope: backofficeContextScopeSchema,
  scopeRestriction: backofficeContextScopeSchema.nullable(),
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  occurredAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
  actors: automationActorsSchema,
  subject: z.preprocess((value) => value ?? null, automationEventSubjectSchema.nullable()),
}) satisfies z.ZodType<AutomationEvent>;

export const automationEventRecordSchema = automationEventSchema.extend({
  createdAt: z.iso.datetime().optional(),
});

export type AutomationEventRecord = z.infer<typeof automationEventRecordSchema>;

export const automationEventListInputSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
});

export const automationEventListResultSchema = z.object({
  events: z.array(automationEventRecordSchema),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

const jsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

export const automationEventDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  payloadSchema: jsonSchemaDocumentSchema.nullable().optional(),
  actorSchema: jsonSchemaDocumentSchema.nullable().optional(),
  subjectSchema: jsonSchemaDocumentSchema.nullable().optional(),
  example: z.unknown().nullable().optional(),
  enabled: z.boolean(),
  capabilityId: z.string(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
});

export type AutomationEventDefinition = z.infer<typeof automationEventDefinitionSchema>;

export const automationEventDefinitionCreateInputSchema = z.object({
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  payloadSchema: jsonSchemaDocumentSchema.nullable().optional(),
  actorSchema: jsonSchemaDocumentSchema.nullable().optional(),
  subjectSchema: jsonSchemaDocumentSchema.nullable().optional(),
  example: z.unknown().nullable().optional(),
  enabled: z.boolean().default(true),
});

export type AutomationEventDefinitionCreateInput = z.input<
  typeof automationEventDefinitionCreateInputSchema
>;

export const automationEventDefinitionUpdatePayloadSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
    payloadSchema: jsonSchemaDocumentSchema.nullable().optional(),
    actorSchema: jsonSchemaDocumentSchema.nullable().optional(),
    subjectSchema: jsonSchemaDocumentSchema.nullable().optional(),
    example: z.unknown().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => typeof value !== "undefined"), {
    message: "At least one event definition field must be provided.",
  });

export const automationEventDefinitionUpdateInputSchema = z.object({
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  patch: automationEventDefinitionUpdatePayloadSchema,
});

export type AutomationEventDefinitionUpdateInput = z.input<
  typeof automationEventDefinitionUpdateInputSchema
>;

const eventListInputSchema = automationEventListInputSchema.extend({
  cursor: z.string().trim().min(1).optional(),
});

export type EventListInput = z.infer<typeof eventListInputSchema>;

const eventEmitInputSchema = z.strictObject({
  eventType: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
  subjectUserId: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  targetScope: backofficeContextScopeSchema.optional(),
});

const eventEmitOutputSchema = z.object({
  accepted: z.boolean(),
  eventId: z.string().trim().min(1),
  scope: backofficeContextScopeSchema,
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
});

const automationEventDescriptorSchema = z.object({
  source: z.string(),
  eventType: z.string(),
  label: z.string(),
  description: z.string().optional(),
  capabilityId: z.string(),
  payloadSchema: z.record(z.string(), z.unknown()).optional(),
  actorSchema: z.record(z.string(), z.unknown()).optional(),
  subjectSchema: z.record(z.string(), z.unknown()).optional(),
  example: z.unknown().optional(),
});

const automationEventsCatalogListOutputSchema = z.array(
  automationEventDescriptorSchema.omit({
    payloadSchema: true,
    actorSchema: true,
    subjectSchema: true,
  }),
);

const automationEventCatalogGetInputSchema = z.object({
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
});

export const eventsOperations = {
  "events.fire": {
    description: "Fire an automation event for the current context or a selected target scope.",
    input: eventEmitInputSchema,
    output: eventEmitOutputSchema,
  },
  "events.list": {
    description: "List stored automation events in the current scope, newest first.",
    input: eventListInputSchema,
    output: automationEventListResultSchema,
  },
  "events.get": {
    description: "Get one stored automation event by id in the current scope.",
    input: z.object({ id: z.string().trim().min(1) }),
    output: automationEventListResultSchema.shape.events.element.nullable(),
  },
  "events.catalog.list": {
    description:
      "List known automation event source/type pairs from the Backoffice capability registry.",
    input: z.void(),
    output: automationEventsCatalogListOutputSchema,
  },
  "events.catalog.get": {
    description: "Get one automation event descriptor and its JSON schemas.",
    input: automationEventCatalogGetInputSchema,
    output: automationEventDescriptorSchema.nullable(),
  },
  "events.catalog.create": {
    description: "Create a scoped dynamic automation event definition with optional JSON schemas.",
    input: automationEventDefinitionCreateInputSchema,
    output: automationEventDefinitionSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;

export type AutomationEventCatalogEntry = z.infer<typeof automationEventDescriptorSchema>;

export type AutomationEventsCatalogListOutput = z.infer<
  typeof automationEventsCatalogListOutputSchema
>;

export type AutomationEventCatalogGetInput = z.infer<typeof automationEventCatalogGetInputSchema>;
