import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);

const instanceStatusSchema = z.enum([
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
]);

const createInstanceSchema = z.object({
  id: identifierSchema.optional(),
  params: z.unknown().optional(),
  remoteWorkflowName: identifierSchema.optional(),
});

const createBatchSchema = z.object({
  remoteWorkflowName: identifierSchema.optional(),
  instances: z
    .array(
      z.object({
        id: identifierSchema,
        params: z.unknown().optional(),
      }),
    )
    .max(100),
});

const sendEventSchema = z.object({
  type: identifierSchema,
  payload: z.unknown().optional(),
});

const retryInstanceSchema = z.object({
  stepKey: z.string().min(1).max(512).optional(),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1000)
    .optional(),
  reason: z.string().min(1).max(512).optional(),
});

const instanceStatusOutputSchema = z.object({
  status: instanceStatusSchema,
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  output: z.unknown().optional(),
});

const currentStepOutputSchema = z.object({
  stepKey: z.string(),
  parentStepKey: z.string().nullable(),
  depth: z.number(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  timeoutMs: z.number().nullable(),
  nextRetryAt: z.date().nullable(),
  wakeAt: z.date().nullable(),
  waitEventType: z.string().nullable(),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
});

const instanceMetaOutputSchema = z.object({
  workflowName: z.string(),
  remoteWorkflowName: z.string().optional(),
  params: z.unknown(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  currentStep: currentStepOutputSchema.optional(),
});

const historyStepSchema = z.object({
  id: z.string(),
  stepKey: z.string(),
  parentStepKey: z.string().nullable(),
  depth: z.number(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  timeoutMs: z.number().nullable(),
  nextRetryAt: z.date().nullable(),
  wakeAt: z.date().nullable(),
  waitEventType: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const historyEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.date(),
  deliveredAt: z.date().nullable(),
  consumedByStepKey: z.string().nullable(),
});

const historyEmissionSchema = z.object({
  id: z.string(),
  stepKey: z.string(),
  epoch: z.string(),
  sequence: z.number(),
  actor: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.date(),
});

const historyOutputSchema = z.object({
  steps: z.array(historyStepSchema),
  events: z.array(historyEventSchema),
  emissions: z.array(historyEmissionSchema),
});

const retryInstanceOutputSchema = z.object({
  accepted: z.literal(true),
  instance: z.object({
    id: z.string(),
    details: instanceStatusOutputSchema,
  }),
  retry: z.object({
    stepKey: z.string(),
    attempts: z.number(),
    maxAttempts: z.number(),
    scheduledAt: z.date(),
  }),
});

const stubHandler = async () => new Response();

export const workflowsRoutesFactoryClient = defineRoutes().create(({ defineRoute }) => [
  defineRoute({
    method: "GET",
    path: "/",
    outputSchema: z.object({
      workflows: z.array(z.object({ name: z.string() })),
    }),
    handler: stubHandler,
  }),
  defineRoute({
    method: "GET",
    path: "/:workflowName/instances",
    queryParameters: ["status", "remoteWorkflowName", "pageSize", "cursor"],
    outputSchema: z.object({
      instances: z.array(
        z.object({
          id: z.string(),
          details: instanceStatusOutputSchema,
          createdAt: z.date(),
        }),
      ),
      nextCursor: z.string().optional(),
      hasNextPage: z.boolean(),
    }),
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances",
    inputSchema: createInstanceSchema,
    outputSchema: z.object({
      id: z.string(),
      details: instanceStatusOutputSchema,
    }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INSTANCE_ID_ALREADY_EXISTS",
      "WORKFLOW_PARAMS_INVALID",
      "WORKFLOW_REMOTE_HOST_INVALID",
      "WORKFLOW_REMOTE_NAME_REQUIRED",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/batch",
    inputSchema: createBatchSchema,
    outputSchema: z.object({
      instances: z.array(
        z.object({
          id: z.string(),
          details: instanceStatusOutputSchema,
        }),
      ),
    }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "WORKFLOW_PARAMS_INVALID",
      "WORKFLOW_REMOTE_HOST_INVALID",
      "WORKFLOW_REMOTE_NAME_REQUIRED",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "GET",
    path: "/:workflowName/instances/:instanceId",
    outputSchema: z.object({
      id: z.string(),
      details: instanceStatusOutputSchema,
      meta: instanceMetaOutputSchema,
    }),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "GET",
    path: "/:workflowName/instances/:instanceId/current-step/emissions",
    queryParameters: ["once"],
    outputSchema: z.array(historyEmissionSchema),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "GET",
    path: "/:workflowName/instances/:instanceId/history",
    outputSchema: historyOutputSchema,
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/retry",
    inputSchema: retryInstanceSchema,
    outputSchema: retryInstanceOutputSchema,
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INSTANCE_NOT_FOUND",
      "STEP_NOT_FOUND",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/pause",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INSTANCE_NOT_FOUND",
      "INSTANCE_TERMINAL",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/resume",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INSTANCE_NOT_FOUND",
      "INSTANCE_TERMINAL",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/terminate",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INSTANCE_NOT_FOUND",
      "INSTANCE_TERMINAL",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/events",
    inputSchema: sendEventSchema,
    outputSchema: z.object({ accepted: z.literal(true) }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INVALID_EVENT_TYPE",
      "INSTANCE_NOT_FOUND",
      "INSTANCE_TERMINAL",
      "EVENT_ID_CONFLICT",
    ],
    handler: stubHandler,
  }),
]);
