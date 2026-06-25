import { z } from "zod";

import type {
  AutomationEventMatcher,
  AutomationRouteDefinition,
  AutomationRouteAction,
  AutomationSendWorkflowEventAction,
  AutomationStartWorkflowAction,
  AutomationWorkflowEventTarget,
} from "./routing";

const DEFAULT_AUTOMATION_WORKFLOW_NAME = "automation-codemode-script";

export const automationEventMatcherSchema: z.ZodType<AutomationEventMatcher> = z
  .lazy(() =>
    z.union([
      z.object({ path: z.string().trim().min(1), op: z.literal("exists") }),
      z.object({
        path: z.string().trim().min(1),
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

const automationStartWorkflowActionSchema: z.ZodType<AutomationStartWorkflowAction> = z
  .object({
    kind: z.literal("start_workflow"),
    workflowName: z.string().trim().min(1).default(DEFAULT_AUTOMATION_WORKFLOW_NAME),
    remoteWorkflowName: z.string().trim().min(1).optional(),
    workflowScriptPath: z.string().trim().min(1),
    instanceIdTemplate: z.string().trim().min(1),
  })
  .meta({
    id: "AutomationStartWorkflowAction",
    codemodeInputId: "AutomationStartWorkflowActionInput",
  });

const automationWorkflowEventTargetSchema: z.ZodType<AutomationWorkflowEventTarget> = z
  .union([
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

const automationSendWorkflowEventActionSchema: z.ZodType<AutomationSendWorkflowEventAction> = z
  .object({
    kind: z.literal("send_workflow_event"),
    workflowName: z.string().trim().min(1).default(DEFAULT_AUTOMATION_WORKFLOW_NAME),
    target: automationWorkflowEventTargetSchema,
    eventType: z.string().trim().min(1),
    payload: z.unknown().optional(),
  })
  .meta({
    id: "AutomationSendWorkflowEventAction",
    codemodeInputId: "AutomationSendWorkflowEventActionInput",
  });

export const automationRouteActionSchema: z.ZodType<AutomationRouteAction> = z
  .union([automationStartWorkflowActionSchema, automationSendWorkflowEventActionSchema])
  .meta({ id: "AutomationRouteAction", codemodeInputId: "AutomationRouteActionInput" });

const automationRouteDefinitionShape = {
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  matcher: automationEventMatcherSchema.nullable(),
  action: automationRouteActionSchema,
  priority: z.number().int(),
  description: z.string().nullable().optional(),
};

export const automationRouteSchema: z.ZodType<AutomationRouteDefinition> = z
  .object(automationRouteDefinitionShape)
  .meta({ id: "AutomationRoute" });

export const automationRouteCreateInputSchema = z.object({
  ...automationRouteDefinitionShape,
  enabled: automationRouteDefinitionShape.enabled.default(true),
  matcher: automationRouteDefinitionShape.matcher.default(null),
  priority: automationRouteDefinitionShape.priority.default(1000),
});

const automationRouteUpdateObjectSchema = z.object({
  id: automationRouteDefinitionShape.id,
  name: automationRouteDefinitionShape.name.optional(),
  enabled: automationRouteDefinitionShape.enabled.optional(),
  source: automationRouteDefinitionShape.source.optional(),
  eventType: automationRouteDefinitionShape.eventType.optional(),
  matcher: automationRouteDefinitionShape.matcher.optional(),
  action: automationRouteDefinitionShape.action.optional(),
  priority: automationRouteDefinitionShape.priority.optional(),
  description: automationRouteDefinitionShape.description,
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
