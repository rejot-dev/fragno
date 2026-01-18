import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";
import type { TxResult } from "@fragno-dev/db";
import { z } from "zod";
import { workflowsFragmentDefinition } from "./definition";
import type { InstanceStatus, WorkflowsRegistry } from "./workflow";

const workflowNameSchema = z.string().min(1).max(64);
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

const listInstancesQuerySchema = z.object({
  status: instanceStatusSchema.optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  cursor: z.string().optional(),
});

const historyQuerySchema = z.object({
  runNumber: z.coerce.number().int().min(0).optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  stepsCursor: z.string().optional(),
  eventsCursor: z.string().optional(),
});

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

type RouteInstanceDetails = { id: string; details: InstanceStatus };

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
    const knownWorkflowNames = new Set(getWorkflowNames(config.workflows));

    const assertWorkflowName = <Code extends string>(
      workflowName: string,
      error: ErrorResponder<Code>,
    ) => {
      const parsed = workflowNameSchema.safeParse(workflowName);
      if (!parsed.success || !knownWorkflowNames.has(workflowName)) {
        return error(
          { message: "Workflow not found", code: "WORKFLOW_NOT_FOUND" as Code },
          404,
        );
      }
      return undefined;
    };

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

    const handleServiceError = <Code extends string>(
      err: unknown,
      error: ErrorResponder<Code>,
    ) => {
      if (!(err instanceof Error)) {
        throw err;
      }

      if (err.message === "INSTANCE_NOT_FOUND") {
        return error(
          { message: "Instance not found", code: "INSTANCE_NOT_FOUND" as Code },
          404,
        );
      }

      if (err.message === "INSTANCE_TERMINAL") {
        return error(
          { message: "Instance is terminal", code: "INSTANCE_TERMINAL" as Code },
          409,
        );
      }

      if (err.message === "INSTANCE_ID_ALREADY_EXISTS") {
        return error(
          { message: "Instance already exists", code: "INSTANCE_ID_ALREADY_EXISTS" as Code },
          409,
        );
      }

      throw err;
    };

    return [
      defineRoute({
        method: "GET",
        path: "/workflows",
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
        path: "/workflows/:workflowName/instances",
        queryParameters: ["status", "pageSize", "cursor"],
        outputSchema: z.object({
          instances: z.array(
            z.object({
              id: z.string(),
              details: instanceStatusOutputSchema,
            }),
          ),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        handler: async function ({ pathParams, query }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

          const params = listInstancesQuerySchema.parse({
            status: query.get("status") || undefined,
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
          });

          const cursor = parseCursor(params.cursor);

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
        },
      }),
      defineRoute({
        method: "POST",
        path: "/workflows/:workflowName/instances",
        inputSchema: createInstanceSchema,
        outputSchema: z.object({
          id: z.string(),
          details: instanceStatusOutputSchema,
        }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_ID_ALREADY_EXISTS"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

          const payload = await input.valid();
          if (payload.id) {
            const idError = assertIdentifier(payload.id, "INVALID_INSTANCE_ID", errorResponder);
            if (idError) {
              return idError;
            }
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.createInstance(workflowName, {
                  id: payload.id,
                  params: payload.params,
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
        path: "/workflows/:workflowName/instances/batch",
        inputSchema: createBatchSchema,
        outputSchema: z.object({
          instances: z.array(
            z.object({
              id: z.string(),
              details: instanceStatusOutputSchema,
            }),
          ),
        }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

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

          const serviceCall = services.createBatch(
            workflowName,
            payload.instances,
          ) as TxResult<RouteInstanceDetails[], unknown>;

          const result = await this.handlerTx()
            .withServiceCalls(() => [serviceCall])
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          return json({ instances: result });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/workflows/:workflowName/instances/:instanceId",
        outputSchema: z.object({
          id: z.string(),
          details: instanceStatusOutputSchema,
        }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          try {
            const details = await this.handlerTx()
              .withServiceCalls(() => [services.getInstanceStatus(workflowName, instanceId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({ id: instanceId, details });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/workflows/:workflowName/instances/:instanceId/history",
        queryParameters: ["runNumber", "pageSize", "stepsCursor", "eventsCursor"],
        outputSchema: z.object({
          runNumber: z.number(),
          steps: z.array(historyStepSchema),
          events: z.array(historyEventSchema),
          stepsCursor: z.string().optional(),
          stepsHasNextPage: z.boolean(),
          eventsCursor: z.string().optional(),
          eventsHasNextPage: z.boolean(),
        }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          const params = historyQuerySchema.parse({
            runNumber: query.get("runNumber") || undefined,
            pageSize: query.get("pageSize"),
            stepsCursor: query.get("stepsCursor") || undefined,
            eventsCursor: query.get("eventsCursor") || undefined,
          });

          const stepsCursor = parseCursor(params.stepsCursor);
          const eventsCursor = parseCursor(params.eventsCursor);

          let resolvedRunNumber = params.runNumber;

          if (resolvedRunNumber === undefined) {
            try {
              resolvedRunNumber = await this.handlerTx()
                .withServiceCalls(() => [services.getInstanceRunNumber(workflowName, instanceId)])
                .transform(({ serviceResult: [result] }) => result)
                .execute();
            } catch (err) {
              return handleServiceError(err, errorResponder);
            }
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listHistory({
                  workflowName,
                  instanceId,
                  runNumber: resolvedRunNumber,
                  pageSize: params.pageSize,
                  stepsCursor,
                  eventsCursor,
                }),
              ])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json({
              runNumber: result.runNumber,
              steps: result.steps,
              events: result.events,
              stepsCursor: result.stepsCursor?.encode(),
              stepsHasNextPage: result.stepsHasNextPage,
              eventsCursor: result.eventsCursor?.encode(),
              eventsHasNextPage: result.eventsHasNextPage,
            });
          } catch (err) {
            return handleServiceError(err, errorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/workflows/:workflowName/instances/:instanceId/pause",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

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
        path: "/workflows/:workflowName/instances/:instanceId/resume",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

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
        path: "/workflows/:workflowName/instances/:instanceId/terminate",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

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
        path: "/workflows/:workflowName/instances/:instanceId/restart",
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: ["WORKFLOW_NOT_FOUND", "INVALID_INSTANCE_ID", "INSTANCE_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

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
        path: "/workflows/:workflowName/instances/:instanceId/events",
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
        handler: async function ({ pathParams, input }, { json, error }) {
          const errorResponder = error as ErrorResponder;
          const workflowName = pathParams.workflowName;
          const workflowError = assertWorkflowName(workflowName, errorResponder);
          if (workflowError) {
            return workflowError;
          }

          const instanceId = pathParams.instanceId;
          const idError = assertIdentifier(instanceId, "INVALID_INSTANCE_ID", errorResponder);
          if (idError) {
            return idError;
          }

          const payload = await input.valid();
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
