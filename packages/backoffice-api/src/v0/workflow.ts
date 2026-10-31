import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { dateTimeStringOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const workflowCreateInstanceResultSchema = z.lazy(() =>
  z.object({
    instanceId: z.string().trim().min(1),
  }),
);

export const workflowHistorySchema = z.lazy(() =>
  z.object({
    steps: z.array(z.unknown()),
    events: z.array(z.unknown()),
    emissions: z.array(z.unknown()),
  }),
);

export const workflowInstanceStatusSchema = z.lazy(() =>
  z.object({
    status: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
    error: z.object({ name: z.string(), message: z.string() }).optional(),
    output: z.unknown().optional(),
  }),
);

export const workflowInstanceDetailsSchema = z.lazy(() =>
  z.object({
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
    /** The event types the run waits for; sending one of them with sendEvent lets it continue. */
    waitingFor: z.array(z.string()),
  }),
);

export const workflowListInstancesResultSchema = z.lazy(() =>
  z.object({
    instances: z.array(
      z.object({
        id: z.string().trim().min(1),
        details: workflowInstanceStatusSchema,
        createdAt: dateTimeStringOutputSchema,
      }),
    ),
    nextCursor: z.string().optional(),
    hasNextPage: z.boolean(),
  }),
);

export const workflowRetryFailedStepResultSchema = z.lazy(() =>
  z.object({
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
  }),
);

export const workflowOperations = {
  "workflow.instances.create": {
    description: "Start a saved durable workflow from its source path.",
    permissions: [BACKOFFICE_PERMISSION.workflow.modify],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string().trim().min(1),
        instanceId: z.string().trim().min(1),
        payload: z.record(z.string(), z.unknown()).optional(),
        notifyWhenDone: z
          .boolean()
          .optional()
          .describe(
            "Only from an agent's turn: notify you, the calling agent, with a workflows instance.completed event carrying the run's status, output, and error when it ends. Works for runs in other scopes too.",
          ),
      }),
    ),
    output: workflowCreateInstanceResultSchema,
  },
  "workflow.instances.send-event": {
    description: "Send an event to a durable workflow instance.",
    permissions: [BACKOFFICE_PERMISSION.workflow.modify],
    input: z.lazy(() =>
      z.strictObject({
        instanceId: z.string().trim().min(1),
        type: z.string().trim().min(1),
        payload: z.unknown().optional(),
      }),
    ),
    output: z.lazy(() => z.strictObject({ accepted: z.literal(true) })),
  },
  "workflow.instances.retry-failed-step": {
    description: "Retry the failed top-level step of an errored durable workflow instance.",
    permissions: [BACKOFFICE_PERMISSION.workflow.modify],
    input: z.lazy(() =>
      z.strictObject({
        instanceId: z.string().trim().min(1),
        delayMs: z.number().int().nonnegative().optional(),
      }),
    ),
    output: workflowRetryFailedStepResultSchema,
  },
  "workflow.instances.terminate": {
    description: "Terminate a durable workflow instance that has not ended yet.",
    permissions: [BACKOFFICE_PERMISSION.workflow.modify],
    input: z.lazy(() =>
      z.strictObject({
        instanceId: z.string().trim().min(1),
      }),
    ),
    output: z.lazy(() => z.strictObject({ terminated: z.literal(true) })),
  },
  "workflow.instances.list": {
    description: "List durable saved-workflow instances.",
    permissions: [BACKOFFICE_PERMISSION.workflow.read],
    input: z.lazy(() =>
      z.strictObject({
        status: workflowInstanceStatusSchema._zod.innerType.shape.status.optional(),
        pageSize: z.number().int().positive().optional(),
        cursor: z.string().trim().min(1).optional(),
      }),
    ),
    output: workflowListInstancesResultSchema,
  },
  "workflow.instances.get": {
    description:
      "Get durable workflow instance details. waitingFor lists the event types it waits for, which sendEvent delivers; an event already sent and not yet taken is not listed again.",
    permissions: [BACKOFFICE_PERMISSION.workflow.read],
    input: z.lazy(() =>
      z.strictObject({
        instanceId: z.string().trim().min(1),
      }),
    ),
    output: workflowInstanceDetailsSchema,
  },
  "workflow.instances.show": {
    description: "Show a durable workflow instance to the user as a card in the conversation.",
    permissions: [BACKOFFICE_PERMISSION.workflow.read],
    input: z.lazy(() =>
      z.strictObject({
        instanceId: z.string().trim().min(1),
      }),
    ),
    output: workflowInstanceDetailsSchema,
  },
  "workflow.instances.history": {
    description: "Get durable workflow step, event, and emission history.",
    permissions: [BACKOFFICE_PERMISSION.workflow.read],
    input: z.lazy(() =>
      z.strictObject({
        instanceId: z.string().trim().min(1),
      }),
    ),
    output: workflowHistorySchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
