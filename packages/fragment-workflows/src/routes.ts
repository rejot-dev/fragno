import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor, isUniqueConstraintError } from "@fragno-dev/db";

import {
  buildInstanceStatus,
  validateWorkflowParams,
  workflowsFragmentDefinition,
} from "./definition";
import { buildScopedInstanceRowId } from "./instance-ref";
import { workflowsSchema } from "./schema";
import { streamWorkflowStepEmissions } from "./stream-step-emissions";
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
  remoteWorkflowName: identifierSchema.optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  cursor: z.string().optional(),
});

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
  id: identifierSchema.optional(),
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

const LIVE_STEP_EMISSION_STREAM_TIMEOUT_MS = 60_000;

const parseBooleanQueryValue = (value: string | null): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

type WorkflowStepEmissionOutput = z.infer<typeof historyEmissionSchema>;

const mapStepEmissionOutput = (emission: {
  id: string | { toString(): string };
  stepKey: string;
  epoch: string;
  sequence: number;
  actor: string;
  payload: unknown;
  createdAt: Date;
}): WorkflowStepEmissionOutput => ({
  id: emission.id.toString(),
  stepKey: emission.stepKey,
  epoch: emission.epoch,
  sequence: emission.sequence,
  actor: emission.actor,
  payload: emission.payload ?? null,
  createdAt: emission.createdAt,
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
  return decodeCursor(cursorParam);
};

const resolveInstanceStatus = (status: string): InstanceStatus["status"] => {
  const parsed = instanceStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw new Error(`INSTANCE_STATUS_INVALID:${status}`);
  }
  return parsed.data;
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

      if (err.message === "EVENT_ID_CONFLICT") {
        return error(
          { message: "Event id belongs to another instance", code: "EVENT_ID_CONFLICT" as Code },
          409,
        );
      }

      if (err.message === "STEP_NOT_FOUND") {
        return error({ message: "Step not found", code: "STEP_NOT_FOUND" as Code }, 404);
      }

      if (isUniqueConstraintError(err)) {
        return error(
          { message: "Instance already exists", code: "INSTANCE_ID_ALREADY_EXISTS" as Code },
          409,
        );
      }

      if (err.message === "WORKFLOW_REMOTE_HOST_INVALID") {
        return error(
          {
            message: "Workflow is not a remote workflow host",
            code: "WORKFLOW_REMOTE_HOST_INVALID" as Code,
          },
          400,
        );
      }

      if (err.message === "WORKFLOW_REMOTE_NAME_REQUIRED") {
        return error(
          {
            message: "Remote workflow name is required",
            code: "WORKFLOW_REMOTE_NAME_REQUIRED" as Code,
          },
          400,
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
        queryParameters: ["status", "remoteWorkflowName", "pageSize", "cursor"],
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_CURSOR"],
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
        handler: async function (context, { json, error }) {
          const { pathParams, query } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;

          const params = listInstancesQuerySchema.parse({
            status: query.get("status") || undefined,
            remoteWorkflowName: query.get("remoteWorkflowName") || undefined,
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
          });

          let cursor: ReturnType<typeof parseCursor>;
          try {
            cursor = parseCursor(params.cursor);
          } catch {
            return errorResponder({ message: "Invalid cursor", code: "INVALID_CURSOR" }, 400);
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listInstances({
                  workflowName,
                  remoteWorkflowName: params.remoteWorkflowName,
                  status: params.status as InstanceStatus["status"] | undefined,
                  pageSize: params.pageSize,
                  cursor,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              instances: result.instances,
              nextCursor: result.cursor?.encode(),
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
          "WORKFLOW_REMOTE_HOST_INVALID",
          "WORKFLOW_REMOTE_NAME_REQUIRED",
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
            const params = await validateWorkflowParams(
              new Map(
                Object.values(config.workflows ?? {}).map((workflow) => [workflow.name, workflow]),
              ),
              workflowName,
              payload.params,
            );
            if (!payload.id) {
              const result = await this.handlerTx()
                .withServiceCalls(() => [
                  services.createInstance(workflowName, {
                    params,
                    remoteWorkflowName: payload.remoteWorkflowName,
                  }),
                ])
                .transform(({ serviceResult: [createdInstance] }) => createdInstance)
                .execute();

              return json(result);
            }

            const requestedInstanceId = payload.id;
            const result = await this.handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
                  b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", requestedInstanceId),
                    ),
                  ),
                ),
              )
              .earlyReturn(({ retrieveResult: [existingInstance], control }) => {
                if (!existingInstance) {
                  return control.continue();
                }

                return control.return({
                  id: existingInstance.instanceId,
                  details: buildInstanceStatus(existingInstance),
                });
              })
              .withServiceCalls(() => [
                services.createInstance(workflowName, {
                  id: requestedInstanceId,
                  params,
                  remoteWorkflowName: payload.remoteWorkflowName,
                }),
              ])
              .transform(({ serviceResult: [createdInstance] }) => createdInstance)
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
        errorCodes: [
          "WORKFLOW_NOT_FOUND",
          "INVALID_INSTANCE_ID",
          "WORKFLOW_PARAMS_INVALID",
          "WORKFLOW_REMOTE_HOST_INVALID",
          "WORKFLOW_REMOTE_NAME_REQUIRED",
        ],
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
                params: await validateWorkflowParams(
                  new Map(
                    Object.values(config.workflows ?? {}).map((workflow) => [
                      workflow.name,
                      workflow,
                    ]),
                  ),
                  workflowName,
                  instance.params,
                ),
              })),
            );
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.createBatch(workflowName, validatedInstances, {
                  remoteWorkflowName: payload.remoteWorkflowName,
                }),
              ])
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
            const { details, meta, currentStep } = await this.handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(workflowsSchema)
                  .findFirst("workflow_instance", (b) =>
                    b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                      eb.and(
                        eb("workflowName", "=", workflowName),
                        eb("instanceId", "=", instanceId),
                      ),
                    ),
                  )
                  .findWithCursor("workflow_step", (b) =>
                    b
                      .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                        eb("instanceRef", "=", buildScopedInstanceRowId(workflowName, instanceId)),
                      )
                      .orderByIndex("idx_workflow_step_instanceRef_createdAt", "desc")
                      .pageSize(1),
                  ),
              )
              .transformRetrieve(([instance, steps]) => {
                if (!instance) {
                  throw new Error("INSTANCE_NOT_FOUND");
                }

                const status = resolveInstanceStatus(instance.status);
                const error =
                  instance.errorName || instance.errorMessage
                    ? {
                        name: instance.errorName ?? "Error",
                        message: instance.errorMessage ?? "",
                      }
                    : undefined;
                const details = {
                  status,
                  error,
                  output: instance.output ?? undefined,
                };
                const meta = {
                  workflowName: instance.workflowName,
                  remoteWorkflowName: instance.remoteWorkflowName ?? undefined,
                  params: instance.params ?? {},
                  createdAt: instance.createdAt,
                  updatedAt: instance.updatedAt,
                  startedAt: instance.startedAt,
                  completedAt: instance.completedAt,
                };

                const latestStep = steps.items[0];
                const currentStep = latestStep
                  ? {
                      stepKey: latestStep.stepKey,
                      parentStepKey: latestStep.parentStepKey,
                      depth: latestStep.depth,
                      name: latestStep.name,
                      type: latestStep.type,
                      status: latestStep.status,
                      attempts: latestStep.attempts,
                      maxAttempts: latestStep.maxAttempts,
                      timeoutMs: latestStep.timeoutMs,
                      nextRetryAt: latestStep.nextRetryAt,
                      wakeAt: latestStep.wakeAt,
                      waitEventType: latestStep.waitEventType,
                      error:
                        latestStep.errorName || latestStep.errorMessage
                          ? {
                              name: latestStep.errorName ?? "Error",
                              message: latestStep.errorMessage ?? "",
                            }
                          : undefined,
                    }
                  : undefined;

                return { details, meta, currentStep };
              })
              .execute();

            return json({ id: instanceId, details, meta: { ...meta, currentStep } });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/:workflowName/instances/:instanceId/current-step/emissions",
        queryParameters: ["once"],
        outputSchema: z.array(historyEmissionSchema),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function (context, { jsonStream, error }) {
          const { pathParams, query } = context;
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const once = parseBooleanQueryValue(query.get("once"));

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            await this.handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
                  b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                    ),
                  ),
                ),
              )
              .transformRetrieve(([instance]) => {
                if (!instance) {
                  throw new Error("INSTANCE_NOT_FOUND");
                }
              })
              .execute();

            return jsonStream(async (stream) => {
              const emissionBusHandle = services.observeStepEmissions<WorkflowStepEmissionOutput>({
                workflowName,
                instanceId,
                handlerTx: this.handlerTx,
              });

              try {
                const emissionBus = emissionBusHandle.pump;
                const snapshot = await emissionBus.snapshot();
                const initialEmissions = snapshot.map(mapStepEmissionOutput);

                if (once) {
                  for (const emission of initialEmissions) {
                    await stream.write(emission);
                  }
                  return;
                }

                await streamWorkflowStepEmissions({
                  stream,
                  emissionBus: {
                    observe: (handler) => {
                      const unsubscribe = emissionBus.observe(
                        (message) => {
                          const mapped = mapStepEmissionOutput(message);
                          return handler({
                            ...message,
                            payload: mapped,
                          });
                        },
                        { after: snapshot },
                      );
                      return unsubscribe;
                    },
                  },
                  initialEmissions,
                  timeoutMs: LIVE_STEP_EMISSION_STREAM_TIMEOUT_MS,
                });
              } finally {
                await emissionBusHandle.close();
              }
            });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/:workflowName/instances/:instanceId/history",
        outputSchema: z.object({
          steps: z.array(historyStepSchema),
          events: z.array(historyEventSchema),
          emissions: z.array(historyEmissionSchema),
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
              steps: result.steps,
              events: result.events,
              emissions: result.emissions,
            });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
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

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.retryInstance(workflowName, instanceId, {
                  stepKey: payload.stepKey,
                  delayMs: payload.delayMs,
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
        path: "/:workflowName/instances/:instanceId/pause",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: [
          "WORKFLOW_NOT_FOUND",
          "INVALID_INSTANCE_ID",
          "INSTANCE_NOT_FOUND",
          "INSTANCE_TERMINAL",
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
        errorCodes: [
          "WORKFLOW_NOT_FOUND",
          "INVALID_INSTANCE_ID",
          "INSTANCE_NOT_FOUND",
          "INSTANCE_TERMINAL",
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
        errorCodes: [
          "WORKFLOW_NOT_FOUND",
          "INVALID_INSTANCE_ID",
          "INSTANCE_NOT_FOUND",
          "INSTANCE_TERMINAL",
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
            await this.handlerTx()
              .withServiceCalls(() => [
                services.sendEvent(workflowName, instanceId, {
                  id: payload.id,
                  type: payload.type,
                  payload: payload.payload,
                }),
              ])
              .execute();

            return json({ accepted: true });
          } catch (err) {
            if (payload.id && isUniqueConstraintError(err)) {
              return json({ accepted: true });
            }
            return handleServiceError(err, errorResponder);
          }
        },
      }),
    ];
  },
);
