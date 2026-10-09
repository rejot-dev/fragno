import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { dateTimeStringOutputSchema } from "./shared/datetime";

export const workflowCreateInstanceResultSchema = z.object({
  instanceId: z.string().trim().min(1),
});

export const workflowHistorySchema = z.object({
  steps: z.array(z.unknown()),
  events: z.array(z.unknown()),
  emissions: z.array(z.unknown()),
});

export const workflowInstanceStatusSchema = z.object({
  status: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  output: z.unknown().optional(),
});

export const workflowInstanceDetailsSchema = z.object({
  id: z.string().trim().min(1),
  details: workflowInstanceStatusSchema,
  meta: z.object({
    name: z.string().trim().min(1),
    path: z.string().trim().min(1),
    createdAt: dateTimeStringOutputSchema,
    updatedAt: dateTimeStringOutputSchema,
    startedAt: dateTimeStringOutputSchema.nullable(),
    completedAt: dateTimeStringOutputSchema.nullable(),
  }),
});

export const workflowListInstancesResultSchema = z.object({
  instances: z.array(
    z.object({
      id: z.string().trim().min(1),
      details: workflowInstanceStatusSchema,
      createdAt: dateTimeStringOutputSchema,
    }),
  ),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export const workflowRetryFailedStepResultSchema = z.object({
  accepted: z.literal(true),
  instance: z.object({
    id: z.string().trim().min(1),
    details: workflowInstanceStatusSchema,
  }),
  retry: z.object({
    stepKey: z.string().trim().min(1),
    attempts: z.number(),
    maxAttempts: z.number(),
    scheduledAt: dateTimeStringOutputSchema,
  }),
});

export const workflowOperations = {
  "workflow.instances.create": {
    description: "Start a saved durable workflow from its source path.",
    input: z.strictObject({
      path: z.string().trim().min(1),
      instanceId: z.string().trim().min(1),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
    output: workflowCreateInstanceResultSchema,
  },
  "workflow.instances.send-event": {
    description: "Send an event to a durable workflow instance.",
    input: z.strictObject({
      instanceId: z.string().trim().min(1),
      type: z.string().trim().min(1),
      payload: z.unknown().optional(),
    }),
    output: z.strictObject({ accepted: z.literal(true) }),
  },
  "workflow.instances.retry-failed-step": {
    description: "Retry the failed top-level step of an errored durable workflow instance.",
    input: z.strictObject({
      instanceId: z.string().trim().min(1),
      delayMs: z.number().int().nonnegative().optional(),
    }),
    output: workflowRetryFailedStepResultSchema,
  },
  "workflow.instances.list": {
    description: "List durable saved-workflow instances.",
    input: z.strictObject({
      status: workflowInstanceStatusSchema.shape.status.optional(),
      pageSize: z.number().int().positive().optional(),
      cursor: z.string().trim().min(1).optional(),
    }),
    output: workflowListInstancesResultSchema,
  },
  "workflow.instances.get": {
    description: "Get durable workflow instance details.",
    input: z.strictObject({
      instanceId: z.string().trim().min(1),
    }),
    output: workflowInstanceDetailsSchema,
  },
  "workflow.instances.history": {
    description: "Get durable workflow step, event, and emission history.",
    input: z.strictObject({
      instanceId: z.string().trim().min(1),
    }),
    output: workflowHistorySchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
