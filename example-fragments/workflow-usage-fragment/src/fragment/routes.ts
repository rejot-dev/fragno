import { defineRoutes } from "@fragno-dev/core";
import { createId } from "@fragno-dev/db/id";
import type { FragnoId } from "@fragno-dev/db/schema";
import type { InstanceStatus } from "@fragno-dev/workflows";
import { z } from "zod";

import { workflowUsageFragmentDefinition } from "./definition";
import { workflowUsageSchema } from "./schema";
import { INTERNAL_WORKFLOW_NAME } from "./workflow";

const WORKFLOW_STATUSES = [
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
] as const;

type WorkflowUsageSession = {
  id: string;
  name: string | null;
  agent: string;
  status: InstanceStatus["status"];
  workflowInstanceId: string | null;
  metadata: unknown | null;
  createdAt: Date;
  updatedAt: Date;
};

type WorkflowUsageRouteErrorCode =
  | "SESSION_NOT_FOUND"
  | "WORKFLOWS_REQUIRED"
  | "WORKFLOW_INSTANCE_MISSING";

type RouteError = Error & { code: WorkflowUsageRouteErrorCode; status: 404 | 500 };

const createRouteError = (
  code: WorkflowUsageRouteErrorCode,
  message: string,
  status: 404 | 500,
): RouteError => {
  const error = new Error(message) as RouteError;
  error.code = code;
  error.status = status;
  return error;
};

type SessionRow = {
  id: FragnoId;
  name: string | null;
  agent: string;
  status: string;
  workflowInstanceId: string | null;
  metadata: unknown | null;
  createdAt: Date;
  updatedAt: Date;
};

const toSessionOutput = (sessionRow: SessionRow): WorkflowUsageSession => ({
  ...sessionRow,
  id: sessionRow.id.valueOf(),
  status: sessionRow.status as InstanceStatus["status"],
});

const workflowStatusSchema = z.object({
  status: z.enum(WORKFLOW_STATUSES),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  output: z.unknown().optional(),
});

const sessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  agent: z.string(),
  status: z.enum(WORKFLOW_STATUSES),
  workflowInstanceId: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const historySchema = z.object({
  runNumber: z.number(),
  steps: z.array(z.unknown()),
  events: z.array(z.unknown()),
});

const sessionDetailSchema = sessionSchema.extend({
  workflow: workflowStatusSchema,
  history: historySchema.optional(),
});

const createSessionSchema = z.object({
  agent: z.string(),
  name: z.string().optional(),
  metadata: z.unknown().optional(),
});

const sendEventSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
});

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export const workflowUsageRoutesFactory = defineRoutes(workflowUsageFragmentDefinition).create(
  ({ config, defineRoute, serviceDeps }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/sessions",
        inputSchema: createSessionSchema,
        outputSchema: sessionSchema,
        errorCodes: ["AGENT_NOT_FOUND", "WORKFLOWS_REQUIRED", "WORKFLOW_CREATE_FAILED"],
        handler: async function ({ input }, { json, error }) {
          const values = await input.valid();

          const workflowsService = serviceDeps.workflows;
          if (!workflowsService) {
            return error(
              { message: "Workflows service is required.", code: "WORKFLOWS_REQUIRED" },
              { status: 500 },
            );
          }

          const agentName = values.agent;
          const agent = config.agents?.[agentName];
          if (!agent) {
            return error(
              { message: `Agent ${agentName} not found.`, code: "AGENT_NOT_FOUND" },
              { status: 404 },
            );
          }

          const now = new Date();
          const sessionId = createId();

          try {
            const created = await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    workflowsService.createInstance(INTERNAL_WORKFLOW_NAME, {
                      id: sessionId,
                      params: {
                        sessionId,
                        agentName,
                        systemPrompt: agent.systemPrompt,
                        metadata: values.metadata ?? null,
                        dsl: agent.dsl ?? null,
                      },
                    }),
                  ] as const,
              )
              .mutate(({ forSchema }) => {
                const uow = forSchema(workflowUsageSchema);
                uow.create("session", {
                  id: sessionId,
                  name: values.name ?? null,
                  agent: agentName,
                  status: "active",
                  workflowInstanceId: sessionId,
                  metadata: values.metadata ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
              })
              .transform(({ serviceResult }) => serviceResult[0])
              .execute();

            const session: WorkflowUsageSession = {
              id: sessionId,
              name: values.name ?? null,
              agent: agentName,
              status: created.details.status,
              workflowInstanceId: created.id,
              metadata: values.metadata ?? null,
              createdAt: now,
              updatedAt: now,
            };

            return json(session);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Failed to create workflow instance.";
            return error({ message, code: "WORKFLOW_CREATE_FAILED" }, { status: 500 });
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sessions",
        queryParameters: ["limit"],
        outputSchema: z.array(sessionSchema),
        handler: async function ({ query }, { json }) {
          const limit = Number.parseInt(query.get("limit") ?? `${DEFAULT_PAGE_SIZE}`, 10);
          const normalizedLimit = Number.isFinite(limit)
            ? Math.max(1, Math.min(MAX_PAGE_SIZE, limit))
            : DEFAULT_PAGE_SIZE;

          const [sessions] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(workflowUsageSchema);
              return uow.find("session", (b) =>
                b
                  .whereIndex("idx_session_created")
                  .orderByIndex("idx_session_created", "desc")
                  .pageSize(normalizedLimit),
              );
            })
            .execute();

          const outputs = sessions.map((session) => toSessionOutput(session as SessionRow));
          return json(outputs);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sessions/:sessionId",
        queryParameters: ["history"],
        outputSchema: sessionDetailSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOWS_REQUIRED", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const sessionId = pathParams.sessionId;

          const workflowsService = serviceDeps.workflows;
          if (!workflowsService) {
            return error(
              { message: "Workflows service is required.", code: "WORKFLOWS_REQUIRED" },
              { status: 500 },
            );
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                workflowsService.getInstanceStatus(INTERNAL_WORKFLOW_NAME, sessionId),
                workflowsService.listHistory({
                  workflowName: INTERNAL_WORKFLOW_NAME,
                  instanceId: sessionId,
                }),
              ])
              .retrieve(({ forSchema }) => {
                const uow = forSchema(workflowUsageSchema);
                return uow.findFirst("session", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
                );
              })
              .mutate(({ forSchema, retrieveResult: [sessionRow], serviceIntermediateResult }) => {
                if (!sessionRow) {
                  return;
                }
                const [workflowStatus] = serviceIntermediateResult as unknown as [
                  InstanceStatus,
                  unknown,
                ];
                const uow = forSchema(workflowUsageSchema);
                uow.update("session", sessionRow.id, (b) =>
                  b
                    .set({
                      status: workflowStatus.status,
                      updatedAt: new Date(),
                    })
                    .check(),
                );
              })
              .transform(({ retrieveResult: [sessionRow], serviceResult }) => {
                if (!sessionRow) {
                  throw createRouteError(
                    "SESSION_NOT_FOUND",
                    `Session ${sessionId} not found.`,
                    404,
                  );
                }
                const [workflowStatus, history] = serviceResult as [
                  InstanceStatus,
                  {
                    runNumber: number;
                    steps: { name: string; result: unknown }[];
                    events: unknown[];
                  },
                ];
                return { sessionRow, workflowStatus, history };
              })
              .execute();

            const session = toSessionOutput(result.sessionRow as SessionRow);
            const includeHistory = query.get("history") === "true" || query.get("history") === "1";
            return json({
              ...session,
              status: result.workflowStatus.status,
              workflow: result.workflowStatus,
              ...(includeHistory && { history: result.history }),
            });
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && "status" in err) {
              const routeError = err as RouteError;
              return error(
                { message: routeError.message, code: routeError.code },
                { status: routeError.status },
              );
            }
            if (err instanceof Error && err.message === "INSTANCE_NOT_FOUND") {
              return error(
                { message: `Session ${sessionId} not found.`, code: "SESSION_NOT_FOUND" },
                { status: 404 },
              );
            }
            const message = err instanceof Error ? err.message : "Failed to load session.";
            return error({ message, code: "WORKFLOW_INSTANCE_MISSING" }, { status: 500 });
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/sessions/:sessionId/events",
        inputSchema: sendEventSchema,
        outputSchema: z.object({ workflow: workflowStatusSchema }),
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOWS_REQUIRED", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const values = await input.valid();
          const sessionId = pathParams.sessionId;

          const workflowsService = serviceDeps.workflows;
          if (!workflowsService) {
            return error(
              { message: "Workflows service is required.", code: "WORKFLOWS_REQUIRED" },
              { status: 500 },
            );
          }

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                workflowsService.sendEvent(INTERNAL_WORKFLOW_NAME, sessionId, {
                  type: values.type,
                  payload: values.payload,
                }),
              ])
              .retrieve(({ forSchema }) => {
                const uow = forSchema(workflowUsageSchema);
                return uow.findFirst("session", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
                );
              })
              .mutate(({ forSchema, retrieveResult: [sessionRow], serviceIntermediateResult }) => {
                if (!sessionRow) {
                  return;
                }
                const [workflowStatus] = serviceIntermediateResult as unknown as [InstanceStatus];
                const uow = forSchema(workflowUsageSchema);
                uow.update("session", sessionRow.id, (b) =>
                  b
                    .set({
                      status: workflowStatus.status,
                      updatedAt: new Date(),
                    })
                    .check(),
                );
              })
              .transform(({ retrieveResult: [sessionRow], serviceResult }) => {
                if (!sessionRow) {
                  throw createRouteError(
                    "SESSION_NOT_FOUND",
                    `Session ${sessionId} not found.`,
                    404,
                  );
                }
                const [workflowStatus] = serviceResult as [InstanceStatus];
                return { workflowStatus };
              })
              .execute();

            return json({ workflow: result.workflowStatus }, 202);
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && "status" in err) {
              const routeError = err as RouteError;
              return error(
                { message: routeError.message, code: routeError.code },
                { status: routeError.status },
              );
            }
            if (err instanceof Error && err.message === "INSTANCE_NOT_FOUND") {
              return error(
                { message: `Session ${sessionId} not found.`, code: "SESSION_NOT_FOUND" },
                { status: 404 },
              );
            }
            const message = err instanceof Error ? err.message : "Failed to send event.";
            return error({ message, code: "WORKFLOW_INSTANCE_MISSING" }, { status: 500 });
          }
        },
      }),
    ];
  },
);
