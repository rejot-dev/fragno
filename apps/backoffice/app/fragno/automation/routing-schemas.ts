import { z } from "zod";

import { automationActorsSchema } from "./actors";
import { automationScheduleCadenceSchema } from "./route-triggers";
import { isAutomationActorProvenancePath } from "./routing";
import type {
  AutomationActorMatcher,
  AutomationEventMatcher,
  AutomationEventPayloadProjection,
  AutomationRouteDefinition,
  AutomationForwardEventAction,
  AutomationReclassifyEventAction,
  AutomationRouteManagedBy,
  AutomationRouteTrigger,
  AutomationRouteAction,
  AutomationRouteScopeTemplate,
  AutomationSendWorkflowEventAction,
  AutomationStartWorkflowAction,
  AutomationWorkflowEventTarget,
} from "./routing";

const automationActorMatcherSchema: z.ZodType<AutomationActorMatcher> = z.discriminatedUnion(
  "participation",
  [
    z.discriminatedUnion("scope", [
      z.strictObject({
        participation: z.literal("initiator"),
        scope: z.literal("internal"),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
      z.strictObject({
        participation: z.literal("initiator"),
        scope: z.literal("external"),
        source: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
    ]),
    z.discriminatedUnion("scope", [
      z.strictObject({
        participation: z.literal("principal"),
        scope: z.literal("internal"),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
      z.strictObject({
        participation: z.literal("principal"),
        scope: z.literal("external"),
        source: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
    ]),
    z.discriminatedUnion("scope", [
      z.strictObject({
        participation: z.literal("delegation"),
        scope: z.literal("internal"),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
        role: z.enum(["delegate", "assistant"]).optional(),
      }),
      z.strictObject({
        participation: z.literal("delegation"),
        scope: z.literal("external"),
        source: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
        role: z.enum(["delegate", "assistant"]).optional(),
      }),
    ]),
  ],
);

const automationEventPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((path) => !isAutomationActorProvenancePath(path), {
    message: "Actor routing must use the structural actor matcher.",
  });

const automationEventMatcherSchema: z.ZodType<AutomationEventMatcher> = z
  .lazy(() =>
    z.union([
      z.strictObject({ actor: automationActorMatcherSchema }),
      z.object({ path: automationEventPathSchema, op: z.literal("exists") }),
      z.object({
        path: automationEventPathSchema,
        op: z.union([
          z.literal("eq"),
          z.literal("neq"),
          z.literal("startsWith"),
          z.literal("includes"),
        ]),
        value: z.unknown(),
      }),
      z.object({ all: z.array(automationEventMatcherSchema) }),
      z.object({ any: z.array(automationEventMatcherSchema) }),
      z.object({ not: automationEventMatcherSchema }),
    ]),
  )
  .meta({ id: "AutomationEventMatcher" });

const automationRouteScopeTemplateSchema: z.ZodType<AutomationRouteScopeTemplate> = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("system") }),
    z.object({ kind: z.literal("org"), orgIdTemplate: z.string().trim().min(1) }),
    z.object({
      kind: z.literal("project"),
      orgIdTemplate: z.string().trim().min(1),
      projectIdTemplate: z.string().trim().min(1),
    }),
    z.object({ kind: z.literal("user"), userIdTemplate: z.string().trim().min(1) }),
  ])
  .meta({ id: "AutomationRouteScopeTemplate" });

const automationAuthorityModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("delegated-user") }),
  z.strictObject({ kind: z.literal("organization-automation") }),
]);

const automationStartWorkflowActionSchema = z
  .strictObject({
    kind: z.literal("start_workflow"),
    authority: automationAuthorityModeSchema,
    workflowScriptPath: z.string().trim().min(1),
    instanceIdTemplate: z.string().trim().min(1),
  })
  .meta({
    id: "AutomationStartWorkflowAction",
    codemodeInputId: "AutomationStartWorkflowActionInput",
  }) satisfies z.ZodType<AutomationStartWorkflowAction>;

const automationWorkflowEventTargetSchema: z.ZodType<AutomationWorkflowEventTarget> = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("instance_id"), template: z.string().trim().min(1) }).meta({
      id: "AutomationWorkflowEventInstanceIdTarget",
    }),
    z
      .object({ kind: z.literal("stored_instance_id"), keyTemplate: z.string().trim().min(1) })
      .meta({
        id: "AutomationWorkflowEventStoredInstanceIdTarget",
      }),
  ])
  .meta({ id: "AutomationWorkflowEventTarget" });

const automationSendWorkflowEventActionSchema = z
  .strictObject({
    kind: z.literal("send_workflow_event"),
    target: automationWorkflowEventTargetSchema,
    eventType: z.string().trim().min(1),
    payload: z.unknown().optional(),
  })
  .meta({
    id: "AutomationSendWorkflowEventAction",
    codemodeInputId: "AutomationSendWorkflowEventActionInput",
  }) satisfies z.ZodType<AutomationSendWorkflowEventAction>;

const automationForwardEventActionSchema = z
  .object({
    kind: z.literal("forward_event"),
    targetScope: automationRouteScopeTemplateSchema,
    idTemplate: z.string().trim().min(1).optional(),
  })
  .meta({
    id: "AutomationForwardEventAction",
    codemodeInputId: "AutomationForwardEventActionInput",
  }) satisfies z.ZodType<AutomationForwardEventAction>;

const automationEventPayloadProjectionSchema = z
  .strictObject({
    kind: z.literal("projection"),
    fields: z.record(
      z.string().trim().min(1),
      z
        .string()
        .trim()
        .refine((path) => path === "$" || path.startsWith("$."), {
          message: "Projection paths must start with $.",
        }),
    ),
  })
  .meta({
    id: "AutomationEventPayloadProjection",
  }) satisfies z.ZodType<AutomationEventPayloadProjection>;

const automationReclassifyEventActionSchema = z
  .strictObject({
    kind: z.literal("reclassify_event"),
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    payload: automationEventPayloadProjectionSchema,
  })
  .meta({
    id: "AutomationReclassifyEventAction",
    codemodeInputId: "AutomationReclassifyEventActionInput",
  }) satisfies z.ZodType<AutomationReclassifyEventAction>;

export const automationRouteActionSchema = z
  .discriminatedUnion("kind", [
    automationStartWorkflowActionSchema,
    automationSendWorkflowEventActionSchema,
    automationForwardEventActionSchema,
    automationReclassifyEventActionSchema,
  ])
  .meta({
    id: "AutomationRouteAction",
    codemodeInputId: "AutomationRouteActionInput",
  }) satisfies z.ZodType<AutomationRouteAction>;

export const automationRouteManagedBySchema: z.ZodType<AutomationRouteManagedBy> = z
  .strictObject({
    kind: z.literal("marketplace"),
    listingId: z.string().trim().min(1),
    resourceKey: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .meta({ id: "AutomationRouteManagedBy" });

const automationRouteMetadataSchema = z.strictObject({
  createdByActors: automationActorsSchema,
  updatedByActors: automationActorsSchema,
  managedBy: automationRouteManagedBySchema.nullable(),
});

const automationRouteTriggerSchema: z.ZodType<AutomationRouteTrigger> = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("event"),
      source: z.string().trim().min(1),
      eventType: z.string().trim().min(1),
      matcher: automationEventMatcherSchema.nullable().default(null),
    }),
    z.object({
      kind: z.literal("schedule"),
      cadence: automationScheduleCadenceSchema,
    }),
  ])
  .meta({ id: "AutomationRouteTrigger", codemodeInputId: "AutomationRouteTriggerInput" });

export const automationRouteSchema: z.ZodType<AutomationRouteDefinition> = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    enabled: z.boolean(),
    priority: z.number().int(),
    trigger: automationRouteTriggerSchema,
    action: automationRouteActionSchema,
    description: z.string().nullable().optional(),
    metadata: automationRouteMetadataSchema.nullable(),
    nextOccurrenceAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "AutomationRoute" });

export const automationRouteCreateInputSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(1000),
  trigger: automationRouteTriggerSchema,
  action: automationRouteActionSchema,
  description: z.string().nullable().optional(),
  managedBy: automationRouteManagedBySchema.nullable().optional(),
});

const automationRouteUpdateObjectSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  trigger: automationRouteTriggerSchema.optional(),
  action: automationRouteActionSchema.optional(),
  description: z.string().nullable().optional(),
  managedBy: automationRouteManagedBySchema.nullable().optional(),
});

export const automationRouteUpdatePayloadSchema = automationRouteUpdateObjectSchema
  .omit({ id: true })
  .refine((patch) => Object.values(patch).some((value) => typeof value !== "undefined"), {
    message: "At least one route field must be provided.",
  });

export const automationRouteUpdateInputSchema = automationRouteUpdateObjectSchema.refine(
  ({ id: _id, ...patch }) => Object.values(patch).some((value) => typeof value !== "undefined"),
  { message: "At least one route field must be provided." },
);

export type AutomationRouteCreateInput = z.infer<typeof automationRouteCreateInputSchema>;
export type AutomationRouteUpdateInput = z.infer<typeof automationRouteUpdateInputSchema>;
