import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";
import { z } from "zod";
import { workflowsFragmentDefinition } from "./definition";
import type { InstanceStatus, WorkflowsRegistry } from "./workflow";

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

const listInstancesQuerySchema = z.object({
  status: instanceStatusSchema.optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  cursor: z.string().optional(),
});

const runNumberSchema = z.coerce.number().int().min(0);

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

type ErrorResponder<Code extends string = string> = (
  details: { message: string; code: Code },
  initOrStatus?: unknown,
  headers?: HeadersInit,
) => Response;

const getWorkflowNames = (registry: WorkflowsRegistry | undefined) =>
  Object.values(registry ?? {}).map((entry) => entry.name);

const parseCursor = (cursorParam: string | undefined) => {
  if (!cursorParam) {
    return undefined;
  }
  try {
    return decodeCursor(cursorParam);
  } catch {
    return undefined;
  }
};

export const workflowsRoutesFactory = defineRoutes(workflowsFragmentDefinition).create(
  ({ services, config, defineRoute }) => {
    const assertIdentifier = <Code extends string>(
      value: string,
      code: Code,
      error: ErrorResponder<Code>,
    ) => {
      if (!identifierSchema.safeParse(value).success) {
        return error({ message: "Invalid identifier", code }, 400);
      }
      return undefined;
    };

    const handleServiceError = <Code extends string>(err: unknown, error: ErrorResponder<Code>) => {
      if (!(err instanceof Error)) {
        throw err;
      }

      if (err.message === "WORKFLOW_NOT_FOUND") {
        return error({ message: "Workflow not found", code: "WORKFLOW_NOT_FOUND" as Code }, 404);
      }

      if (err.message === "INSTANCE_NOT_FOUND") {
        return error({ message: "Instance not found", code: "INSTANCE_NOT_FOUND" as Code }, 404);
      }

      if (err.message === "INSTANCE_TERMINAL") {
        return error({ message: "Instance is terminal", code: "INSTANCE_TERMINAL" as Code }, 409);
      }

      if (err.message === "INSTANCE_ID_ALREADY_EXISTS") {
        return error(
          { message: "Instance already exists", code: "INSTANCE_ID_ALREADY_EXISTS" as Code },
          409,
        );
      }

      if (err.message === "WORKFLOW_PARAMS_INVALID") {
        return error(
          { message: "Invalid workflow params", code: "WORKFLOW_PARAMS_INVALID" as Code },
          400,
        );
      }

      throw err;
    };

    return [
      defineRoute({
        method: "GET",
        path: "/",
        outputSchema: z.object({
          workflows: z.array(z.object({ name: z.string() })),
        }),
        handler: async (_context, { json }) => {
          const workflows = getWorkflowNames(config.workflows).map((name) => ({ name }));
          return json({ workflows });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/:workflowName/instances",
        queryParameters: ["status", "pageSize", "cursor"],
        errorCodes: ["WORKFLOW_NOT_FOUND"],
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
        handler: async function (context, { json, error }) {
          const { pathParams, query } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const params = listInstancesQuerySchema.parse({
            status: query.get("status") || undefined,
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
          });

          const cursor = parseCursor(params.cursor);

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listInstances({
                  workflowName,
                  status: params.status as InstanceStatus["status"] | undefined,
                  pageSize: params.pageSize,
                  cursor,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              instances: result.instances,
              cursor: result.cursor?.encode(),
              hasNextPage: result.hasNextPage,
            });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
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
        handler: async function (context, { json, error }) {
          const { pathParams, input } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const payload = await input.valid();

          if (payload.id) {
            const idError = assertIdentifier(payload.id, "INVALID_INSTANCE_ID", errorResponder);
            if (idError) {
              return idError;
            }
          }

          try {
            const params = await services.validateWorkflowParams(workflowName, payload.params);
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.createInstance(workflowName, {
                  id: payload.id,
                  params,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(result);
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
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
        handler: async function (context, { json, error }) {
          const { pathParams, input } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const payload = await input.valid();

          for (const instance of payload.instances) {
            const idError = assertIdentifier(instance.id, "INVALID_INSTANCE_ID", errorResponder);
            if (idError) {
              return idError;
            }
          }

          if (payload.instances.length === 0) {
            return json({ instances: [] });
          }

          try {
            const validatedInstances = await Promise.all(
              payload.instances.map(async (instance) => ({
                id: instance.id,
                params: await services.validateWorkflowParams(workflowName, instance.params),
              })),
            );
            const result = await this.handlerTx()
              .withServiceCalls(() => [services.createBatch(workflowName, validatedInstances)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({ instances: result });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
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
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            const { details, meta } = await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    services.getInstanceStatus(workflowName, instanceId),
                    services.getInstanceMetadata(workflowName, instanceId),
                  ] as const,
              )
              .transform(({ serviceResult: [detailsResult, metaResult] }) => ({
                details: detailsResult,
                meta: metaResult,
              }))
              .execute();

            const currentStep = await this.handlerTx()
              .withServiceCalls(() => [
                services.getInstanceCurrentStep({
                  instanceId,
                  runNumber: meta.runNumber,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({ id: instanceId, details, meta: { ...meta, currentStep } });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/:workflowName/instances/:instanceId/history",
        outputSchema: z.object({
          runNumber: z.number(),
          steps: z.array(historyStepSchema),
          events: z.array(historyEventSchema),
        }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listHistory({
                  workflowName,
                  instanceId,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              runNumber: result.runNumber,
              steps: result.steps,
              events: result.events,
            });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/:workflowName/instances/:instanceId/history/:run",
        outputSchema: z.object({
          runNumber: z.number(),
          steps: z.array(historyStepSchema),
          events: z.array(historyEventSchema),
        }),
        errorCodes: [
          "WORKFLOW_NOT_FOUND",
          "INVALID_INSTANCE_ID",
          "INVALID_RUN_NUMBER",
          "INSTANCE_NOT_FOUND",
        ],
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          const parsedRun = runNumberSchema.safeParse(pathParams.run);
          if (!parsedRun.success) {
            return errorResponder(
              { message: "Invalid run number", code: "INVALID_RUN_NUMBER" },
              400,
            );
          }
          const resolvedRunNumber = parsedRun.data;

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listHistory({
                  workflowName,
                  instanceId,
                  runNumber: resolvedRunNumber,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              runNumber: result.runNumber,
              steps: result.steps,
              events: result.events,
            });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/:workflowName/instances/:instanceId/pause",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            await this.handlerTx()
              .withServiceCalls(() => [services.pauseInstance(workflowName, instanceId)])
              .execute();
            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/:workflowName/instances/:instanceId/resume",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            await this.handlerTx()
              .withServiceCalls(() => [services.resumeInstance(workflowName, instanceId)])
              .execute();
            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/:workflowName/instances/:instanceId/terminate",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            await this.handlerTx()
              .withServiceCalls(() => [services.terminateInstance(workflowName, instanceId)])
              .execute();
            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/:workflowName/instances/:instanceId/restart",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function (context, { json, error }) {
          const { pathParams } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            await this.handlerTx()
              .withServiceCalls(() => [services.restartInstance(workflowName, instanceId)])
              .execute();
            return json({ ok: true });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
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
        handler: async function (context, { json, error }) {
          const { pathParams, input } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const payload = await input.valid();

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          const typeError = assertIdentifier(payload.type, "INVALID_EVENT_TYPE", errorResponder);
          if (typeError) {
            return typeError;
          }

          try {
            const status = await this.handlerTx()
              .withServiceCalls(() => [
                services.sendEvent(workflowName, instanceId, {
                  type: payload.type,
                  payload: payload.payload,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({ status });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
    ];
  },
);
