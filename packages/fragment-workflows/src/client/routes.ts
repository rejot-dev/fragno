import { defineRoutes } from "@fragno-dev/core";
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);

const instanceStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
]);

const createInstanceSchema = z.object({
  id: identifierSchema.optional(),
  params: z.unknown().optional(),
});

const createBatchSchema = z.object({
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

const runnerTickSchema = z
  .object({
    maxInstances: z.coerce.number().int().positive().optional(),
    maxSteps: z.coerce.number().int().positive().optional(),
  })
  .default({});

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
  runNumber: z.number(),
  params: z.unknown(),
  pauseRequested: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  currentStep: currentStepOutputSchema.optional(),
});

const historyStepSchema = z.object({
  id: z.string(),
  runNumber: z.number(),
  stepKey: z.string(),
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
  runNumber: z.number(),
  type: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.date(),
  deliveredAt: z.date().nullable(),
  consumedByStepKey: z.string().nullable(),
});

const historyLogSchema = z.object({
  id: z.string(),
  runNumber: z.number(),
  stepKey: z.string().nullable(),
  attempt: z.number().nullable(),
  level: z.enum(["debug", "info", "warn", "error"]),
  category: z.string(),
  message: z.string(),
  data: z.unknown().nullable(),
  createdAt: z.date(),
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
    queryParameters: ["status", "pageSize", "cursor"],
    outputSchema: z.object({
      instances: z.array(
        z.object({
          id: z.string(),
          details: instanceStatusOutputSchema,
          createdAt: z.date(),
        }),
      ),
      cursor: z.string().optional(),
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
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "WORKFLOW_PARAMS_INVALID"],
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
    path: "/:workflowName/instances/:instanceId/history",
    queryParameters: [
      "runNumber",
      "pageSize",
      "stepsCursor",
      "eventsCursor",
      "logsCursor",
      "includeLogs",
      "logLevel",
      "logCategory",
      "order",
    ],
    outputSchema: z.object({
      runNumber: z.number(),
      steps: z.array(historyStepSchema),
      events: z.array(historyEventSchema),
      stepsCursor: z.string().optional(),
      stepsHasNextPage: z.boolean(),
      eventsCursor: z.string().optional(),
      eventsHasNextPage: z.boolean(),
      logs: z.array(historyLogSchema).optional(),
      logsCursor: z.string().optional(),
      logsHasNextPage: z.boolean().optional(),
    }),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/pause",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/resume",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/terminate",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/restart",
    outputSchema: z.object({ ok: z.literal(true) }),
    errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/:workflowName/instances/:instanceId/events",
    inputSchema: sendEventSchema,
    outputSchema: z.object({
      status: instanceStatusOutputSchema,
    }),
    errorCodes: [
      "WORKFLOW_NOT_FOUND",
      "INVALID_INSTANCE_ID",
      "INVALID_EVENT_TYPE",
      "INSTANCE_NOT_FOUND",
      "INSTANCE_TERMINAL",
    ],
    handler: stubHandler,
  }),
  defineRoute({
    method: "POST",
    path: "/_runner/tick",
    inputSchema: runnerTickSchema,
    outputSchema: z.object({
      processed: z.number(),
    }),
    handler: stubHandler,
  }),
]);
