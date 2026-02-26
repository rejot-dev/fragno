import { defineRoutes } from "@fragno-dev/core";
import { createId } from "@fragno-dev/db/id";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { z } from "zod";

import { piSchema } from "./schema";
import { piFragmentDefinition } from "./pi/definition";
import { messageAckSchema, sessionBaseSchema, sessionDetailSchema } from "./pi/route-schemas";
import {
  extractAssistantTextFromMessage,
  normalizeSteeringMode,
  toSessionOutput,
} from "./pi/mappers";
import { PI_WORKFLOW_NAME } from "./pi/workflow";
import type {
  PiSession,
  PiTurnSummary,
  PiWorkflowHistoryStep,
  PiWorkflowsHistoryPage,
  PiWorkflowsInstanceStatus,
} from "./pi/types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_HISTORY_RUNS = 5;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getArrayFromResult = <T>(result: unknown, key: string): T[] | null => {
  if (!isRecord(result)) {
    return null;
  }
  const value = result[key];
  return Array.isArray(value) ? (value as T[]) : null;
};

const getAssistantFromResult = (result: unknown): AgentMessage | null => {
  if (!isRecord(result)) {
    return null;
  }
  const assistant = result["assistant"];
  if (!assistant || typeof assistant !== "object") {
    return null;
  }
  return assistant as AgentMessage;
};

const parseAssistantTurn = (name: string): number | null => {
  const match = /^assistant-(\d+)$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
};

const deriveHistory = (steps: PiWorkflowHistoryStep[], output: unknown) => {
  let messages: AgentMessage[] = [];
  const trace: AgentEvent[] = [];
  const summaries: PiTurnSummary[] = [];
  let lastAssistant: AgentMessage | null = null;

  const sortedSteps = [...steps].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const step of sortedSteps) {
    if (!step.result) {
      continue;
    }

    const stepMessages = getArrayFromResult<AgentMessage>(step.result, "messages");
    if (stepMessages) {
      messages = stepMessages;
    }

    const stepTrace = getArrayFromResult<AgentEvent>(step.result, "trace");
    if (stepTrace) {
      trace.push(...stepTrace);
    }

    const assistant = getAssistantFromResult(step.result);
    const turn = parseAssistantTurn(step.name);
    if (assistant && turn !== null) {
      lastAssistant = assistant;
      summaries.push({
        turn,
        assistant,
        summary: extractAssistantTextFromMessage(assistant) || null,
      });
    }
  }

  if (messages.length === 0 && isRecord(output) && Array.isArray(output["messages"])) {
    messages = output["messages"] as AgentMessage[];
  }
  if (lastAssistant && !messages.some((message) => message?.role === "assistant")) {
    messages = [...messages, lastAssistant];
  }

  return { messages, trace, summaries };
};

const collectHistorySteps = (
  pages: PiWorkflowsHistoryPage[],
  maxRunNumber: number,
): PiWorkflowHistoryStep[] => {
  return pages.filter((page) => page.runNumber <= maxRunNumber).flatMap((page) => page.steps);
};

export const piRoutesFactory = defineRoutes(piFragmentDefinition).create(
  ({ config, defineRoute, serviceDeps }) => {
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
        outputSchema: sessionDetailSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOWS_REQUIRED", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams }, { json, error }) {
          const sessionId = pathParams.sessionId;

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
              .withServiceCalls(() => {
                const historyCalls = Array.from({ length: MAX_HISTORY_RUNS + 1 }, (_, runNumber) =>
                  workflowsService.listHistory({
                    workflowName,
                    instanceId: workflowInstanceId,
                    runNumber,
                  }),
                );
                return [
                  workflowsService.getInstanceStatus(workflowName, workflowInstanceId),
                  workflowsService.getInstanceRunNumber(workflowName, workflowInstanceId),
                  ...historyCalls,
                ];
              })
              .mutate(({ forSchema, serviceIntermediateResult }) => {
                const [workflowStatus] = serviceIntermediateResult as [
                  PiWorkflowsInstanceStatus,
                  number,
                  ...PiWorkflowsHistoryPage[],
                ];
                const uow = forSchema(piSchema);
                uow.update("session", sessionRow.id, (b) =>
                  b
                    .set({
                      status: workflowStatus.status,
                      updatedAt: new Date(),
                    })
                    .check(),
                );
              })
              .transform(({ serviceResult }) => {
                const [workflowStatus, runNumber, ...historyPages] = serviceResult as [
                  PiWorkflowsInstanceStatus,
                  number,
                  ...PiWorkflowsHistoryPage[],
                ];

                const maxRunNumber = Number.isFinite(runNumber)
                  ? Math.max(0, Math.min(MAX_HISTORY_RUNS, runNumber))
                  : 0;
                const pages = historyPages.slice(0, maxRunNumber + 1);
                const steps = collectHistorySteps(pages, maxRunNumber);
                const history = deriveHistory(steps, workflowStatus.output);

                return { workflowStatus, history };
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
              messages: result.history.messages,
              trace: result.history.trace,
              summaries: result.history.summaries,
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
            const message = err instanceof Error ? err.message : "Failed to load workflow history.";
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
              .withServiceCalls(() => [
                workflowsService.sendEvent(workflowName, workflowInstanceId, {
                  type: "user_message",
                  payload,
                }),
                workflowsService.getInstanceStatus(workflowName, workflowInstanceId),
                workflowsService.getInstanceRunNumber(workflowName, workflowInstanceId),
              ])
              .mutate(({ forSchema, serviceIntermediateResult }) => {
                const [, workflowStatus] = serviceIntermediateResult as [
                  unknown,
                  PiWorkflowsInstanceStatus,
                  number,
                ];
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
                const [, workflowStatus, runNumber] = serviceResult as [
                  unknown,
                  PiWorkflowsInstanceStatus,
                  number,
                ];
                return { workflowStatus, runNumber };
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
