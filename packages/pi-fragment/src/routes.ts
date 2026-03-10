import { defineRoutes } from "@fragno-dev/core";
import { serviceCalls } from "@fragno-dev/db";
import { createId } from "@fragno-dev/db/id";
import { z } from "zod";

import { piSchema } from "./schema";
import { piFragmentDefinition } from "./pi/definition";
import { messageAckSchema, sessionBaseSchema, sessionDetailSchema } from "./pi/route-schemas";
import { PiLogger } from "./debug-log";
import { normalizeSteeringMode, toSessionOutput } from "./pi/mappers";
import { createInitialPiAgentLoopState, PI_WORKFLOW_NAME } from "./pi/workflow";
import type { PiSession } from "./pi/types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type RouteError = Error & { code: string; status: number };

const createRouteError = (code: string, message: string, status: number): RouteError => {
  const error = new Error(message) as RouteError;
  error.code = code;
  error.status = status;
  return error;
};

type SessionRouteErrorCode =
  | "SESSION_NOT_FOUND"
  | "WORKFLOWS_REQUIRED"
  | "WORKFLOW_INSTANCE_MISSING";

const isSessionRouteErrorCode = (value: unknown): value is SessionRouteErrorCode =>
  value === "SESSION_NOT_FOUND" ||
  value === "WORKFLOWS_REQUIRED" ||
  value === "WORKFLOW_INSTANCE_MISSING";

const parseBooleanQueryValue = (value: string | null, defaultValue: boolean): boolean => {
  if (value === null) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return defaultValue;
};

export const piRoutesFactory = defineRoutes(piFragmentDefinition).create(
  ({ config, defineRoute, serviceDeps }) => {
    PiLogger.reset();
    if (config.logging) {
      PiLogger.configure(config.logging);
    }

    return [
      defineRoute({
        method: "POST",
        path: "/sessions",
        inputSchema: z.object({
          agent: z.string(),
          name: z.string().optional(),
          metadata: z.any().optional(),
          tags: z.array(z.string()).optional(),
          steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
        }),
        outputSchema: sessionBaseSchema,
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
          const steeringMode = normalizeSteeringMode(
            values.steeringMode ?? config.defaultSteeringMode,
          );
          const sessionId = createId();

          try {
            const created = await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    workflowsService.createInstance(PI_WORKFLOW_NAME, {
                      id: sessionId,
                      params: {
                        sessionId,
                        agentName,
                        systemPrompt: agent.systemPrompt,
                        initialMessages: [],
                      },
                    }),
                  ] as const,
              )
              .mutate(({ forSchema }) => {
                const uow = forSchema(piSchema);
                uow.create("session", {
                  id: sessionId,
                  name: values.name ?? null,
                  agent: agentName,
                  status: "active",
                  workflowInstanceId: sessionId,
                  steeringMode,
                  metadata: values.metadata ?? null,
                  tags: values.tags ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
              })
              .transform(({ serviceResult }) => serviceResult[0])
              .execute();

            const workflowInstanceId = created.id;
            const workflowStatus = created.details;

            const session: PiSession = {
              id: sessionId,
              name: values.name ?? null,
              status: workflowStatus.status,
              agent: agentName,
              workflowInstanceId,
              steeringMode,
              metadata: values.metadata ?? null,
              tags: values.tags ?? [],
              createdAt: now,
              updatedAt: now,
            };

            return json(session);
          } catch (err) {
            // TODO: cleanup workflow/session if createInstance or session persist fails.
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
        outputSchema: z.array(sessionBaseSchema),
        handler: async function ({ query }, { json }) {
          const limit = Number.parseInt(query.get("limit") ?? `${DEFAULT_PAGE_SIZE}`, 10);
          const normalizedLimit = Number.isFinite(limit)
            ? Math.max(1, Math.min(MAX_PAGE_SIZE, limit))
            : DEFAULT_PAGE_SIZE;

          const [sessions] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(piSchema);
              return uow.find("session", (b) =>
                b
                  .whereIndex("idx_session_created")
                  .orderByIndex("idx_session_created", "desc")
                  .pageSize(normalizedLimit),
              );
            })
            .execute();

          // TODO: hydrate workflow status without additional handlerTx calls.
          const outputs = sessions.map(toSessionOutput);
          return json(outputs);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sessions/:sessionId",
        queryParameters: ["events", "trace", "summaries"],
        outputSchema: sessionDetailSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOWS_REQUIRED", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const sessionId = pathParams.sessionId;
          const includeEvents = parseBooleanQueryValue(query.get("events"), true);
          const includeTrace = parseBooleanQueryValue(query.get("trace"), true);
          const includeSummaries = parseBooleanQueryValue(query.get("summaries"), true);

          const workflowsService = serviceDeps.workflows;
          if (!workflowsService) {
            return error(
              { message: "Workflows service is required.", code: "WORKFLOWS_REQUIRED" },
              { status: 500 },
            );
          }

          const workflowName = PI_WORKFLOW_NAME;

          try {
            const [sessionRow] = await this.handlerTx()
              .retrieve(({ forSchema }) => {
                const uow = forSchema(piSchema);
                return uow.findFirst("session", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
                );
              })
              .execute();

            if (!sessionRow) {
              throw createRouteError("SESSION_NOT_FOUND", `Session ${sessionId} not found.`, 404);
            }

            const workflowInstanceId = sessionRow.workflowInstanceId;
            if (!workflowInstanceId) {
              throw createRouteError("SESSION_NOT_FOUND", `Session ${sessionId} not found.`, 404);
            }

            const result = await this.handlerTx()
              .withServiceCalls(() =>
                serviceCalls(
                  workflowsService.getInstanceStatus(workflowName, workflowInstanceId),
                  workflowsService.restoreInstanceState(workflowName, workflowInstanceId),
                ),
              )
              .transform(({ serviceResult }) => {
                const [workflowStatus, restoredState] = serviceResult;
                const detailState = restoredState ?? createInitialPiAgentLoopState();

                return { workflowStatus, detailState };
              })
              .execute();

            const session = toSessionOutput(sessionRow);

            return json({
              ...session,
              status: result.workflowStatus.status,
              workflow: {
                status: result.workflowStatus.status,
                error: result.workflowStatus.error,
                output: result.workflowStatus.output,
              },
              messages: result.detailState.messages,
              events: includeEvents ? result.detailState.events : [],
              trace: includeTrace ? result.detailState.trace : [],
              turn: result.detailState.turn,
              phase: result.detailState.phase,
              waitingFor: result.detailState.waitingFor,
              summaries: includeSummaries ? result.detailState.summaries : [],
            });
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && "status" in err) {
              const routeError = err as RouteError;
              const code = isSessionRouteErrorCode(routeError.code)
                ? routeError.code
                : "WORKFLOW_INSTANCE_MISSING";
              const status = code === "SESSION_NOT_FOUND" ? 404 : 500;
              return error({ message: routeError.message, code }, { status });
            }
            if (err instanceof Error && err.message === "INSTANCE_NOT_FOUND") {
              return error(
                { message: `Session ${sessionId} not found.`, code: "SESSION_NOT_FOUND" },
                { status: 404 },
              );
            }
            const message = err instanceof Error ? err.message : "Failed to load workflow detail.";
            return error({ message, code: "WORKFLOW_INSTANCE_MISSING" }, { status: 500 });
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/sessions/:sessionId/messages",
        inputSchema: z.object({
          text: z.string(),
          done: z.boolean().optional(),
          steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
        }),
        outputSchema: messageAckSchema,
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

          const workflowName = PI_WORKFLOW_NAME;
          const payload: {
            text: string;
            done?: boolean;
            steeringMode?: "all" | "one-at-a-time";
          } = {
            text: values.text,
            done: values.done,
          };
          if (values.steeringMode) {
            payload.steeringMode = values.steeringMode;
          }

          try {
            const [sessionRow] = await this.handlerTx()
              .retrieve(({ forSchema }) => {
                const uow = forSchema(piSchema);
                return uow.findFirst("session", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
                );
              })
              .execute();

            if (!sessionRow) {
              throw createRouteError("SESSION_NOT_FOUND", `Session ${sessionId} not found.`, 404);
            }

            const workflowInstanceId = sessionRow.workflowInstanceId;
            if (!workflowInstanceId) {
              throw createRouteError("SESSION_NOT_FOUND", `Session ${sessionId} not found.`, 404);
            }

            if (!payload.steeringMode) {
              // Ensure workflow events use the session's steering mode when not overridden.
              payload.steeringMode = normalizeSteeringMode(
                sessionRow.steeringMode ?? config.defaultSteeringMode,
              );
            }

            const result = await this.handlerTx()
              .withServiceCalls(() =>
                serviceCalls(
                  workflowsService.sendEvent(workflowName, workflowInstanceId, {
                    type: "user_message",
                    payload,
                  }),
                  workflowsService.getInstanceStatus(workflowName, workflowInstanceId),
                ),
              )
              .mutate(({ forSchema, serviceIntermediateResult }) => {
                const [, workflowStatus] = serviceIntermediateResult;
                const updates: {
                  updatedAt: Date;
                  steeringMode?: "all" | "one-at-a-time";
                  status?: string;
                } = {
                  updatedAt: new Date(),
                };
                if (values.steeringMode) {
                  updates.steeringMode = values.steeringMode;
                }
                updates.status = workflowStatus.status;
                const uow = forSchema(piSchema);
                uow.update("session", sessionRow.id, (b) => b.set(updates).check());
              })
              .transform(({ serviceResult }) => {
                const [, workflowStatus] = serviceResult;
                return { workflowStatus };
              })
              .execute();

            return json(
              {
                status: result.workflowStatus.status,
              },
              202,
            );
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && "status" in err) {
              const routeError = err as RouteError;
              const code = isSessionRouteErrorCode(routeError.code)
                ? routeError.code
                : "WORKFLOW_INSTANCE_MISSING";
              const status = code === "SESSION_NOT_FOUND" ? 404 : 500;
              return error({ message: routeError.message, code }, { status });
            }
            if (err instanceof Error && err.message === "INSTANCE_NOT_FOUND") {
              return error(
                { message: `Session ${sessionId} not found.`, code: "SESSION_NOT_FOUND" },
                { status: 404 },
              );
            }
            const message = err instanceof Error ? err.message : "Failed to deliver message.";
            return error({ message, code: "WORKFLOW_INSTANCE_MISSING" }, { status: 500 });
          }
        },
      }),
    ];
  },
);
