import { createId } from "@fragno-dev/db/id";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { serviceCalls } from "@fragno-dev/db";

import { PiLogger } from "./debug-log";
import { piFragmentDefinition } from "./pi/definition";
import { normalizeSteeringMode, toSessionOutput } from "./pi/mappers";
import {
  activeSessionStreamItemSchema,
  messageAckSchema,
  sessionBaseSchema,
  sessionDetailSchema,
} from "./pi/route-schemas";
import type {
  PiActiveSessionProtocolMessage,
  PiActiveSessionUpdate,
  PiAgentLoopState,
  PiAgentLoopSerializableState,
  PiSession,
} from "./pi/types";
import {
  createInitialPiAgentLoopState,
  ensurePiActiveSessionState,
  PI_WORKFLOW_NAME,
} from "./pi/workflow/workflow";
import { piSchema } from "./schema";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type RouteError = Error & { code: string; status: number };

const createRouteError = (code: string, message: string, status: number): RouteError => {
  const error = new Error(message) as RouteError;
  error.code = code;
  error.status = status;
  return error;
};

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

const projectSessionDetailState = (
  state: PiAgentLoopState | null | undefined,
): PiAgentLoopSerializableState => {
  const nextState = state ?? createInitialPiAgentLoopState();

  return {
    messages: nextState.messages,
    events: nextState.events,
    trace: nextState.trace,
    summaries: nextState.summaries,
    turn: nextState.turn,
    phase: nextState.phase,
    waitingFor: nextState.waitingFor,
  };
};

const isSessionStreamable = (state: PiAgentLoopState) => state.phase !== "complete";

const ensureLiveSessionActiveState = (state: PiAgentLoopState) => {
  if (!isSessionStreamable(state)) {
    return null;
  }
  return ensurePiActiveSessionState(state);
};

const toActiveSessionProtocolMessage = (
  update: PiActiveSessionUpdate,
  source: "replay" | "live",
): PiActiveSessionProtocolMessage => {
  if (update.type === "settled") {
    return {
      layer: "system",
      type: "settled",
      turn: update.turn,
      status: update.status,
    };
  }

  return {
    layer: "pi",
    type: "event",
    turn: update.turn,
    source,
    event: update.event,
  };
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
        errorCodes: ["AGENT_NOT_FOUND", "WORKFLOW_CREATE_FAILED"],
        handler: async function ({ input }, { json, error }) {
          const values = await input.valid();

          const workflowsService = serviceDeps.workflows;

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
            await this.handlerTx()
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
                  steeringMode,
                  metadata: values.metadata ?? null,
                  tags: values.tags ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
              })
              .execute();

            const session: PiSession = {
              id: sessionId,
              name: values.name ?? null,
              status: "active",
              agent: agentName,
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

          const outputs = sessions.map(toSessionOutput);
          return json(outputs);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sessions/:sessionId",
        queryParameters: ["events", "trace", "summaries"],
        outputSchema: sessionDetailSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const sessionId = pathParams.sessionId;
          const includeEvents = parseBooleanQueryValue(query.get("events"), true);
          const includeTrace = parseBooleanQueryValue(query.get("trace"), true);
          const includeSummaries = parseBooleanQueryValue(query.get("summaries"), true);

          const workflowsService = serviceDeps.workflows;

          const workflowName = PI_WORKFLOW_NAME;

          try {
            const liveSessionSnapshot = workflowsService.getLiveInstanceState(
              workflowName,
              sessionId,
            );

            const result = await this.handlerTx()
              .retrieve(({ forSchema }) => {
                const uow = forSchema(piSchema);
                return uow.findFirst("session", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
                );
              })
              .withServiceCalls(() =>
                serviceCalls(
                  workflowsService.getInstanceStatus(workflowName, sessionId),
                  liveSessionSnapshot
                    ? undefined
                    : workflowsService.restoreInstanceState(workflowName, sessionId),
                ),
              )
              .transform(({ retrieveResult, serviceResult }) => {
                const [sessionRow] = retrieveResult;
                if (!sessionRow) {
                  throw createRouteError(
                    "SESSION_NOT_FOUND",
                    `Session ${sessionId} not found.`,
                    404,
                  );
                }

                const [workflowStatus, restoredState] = serviceResult;
                const detailState = projectSessionDetailState(
                  liveSessionSnapshot?.state ?? restoredState,
                );

                return {
                  session: toSessionOutput(sessionRow),
                  workflowStatus,
                  detailState,
                };
              })
              .execute();

            return json({
              ...result.session,
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
              const code =
                routeError.code === "SESSION_NOT_FOUND"
                  ? "SESSION_NOT_FOUND"
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
        method: "GET",
        path: "/sessions/:sessionId/active",
        outputSchema: z.array(activeSessionStreamItemSchema),
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams }, { error, jsonStream }) {
          const sessionId = pathParams.sessionId;

          const workflowsService = serviceDeps.workflows;

          const workflowName = PI_WORKFLOW_NAME;

          try {
            const liveSessionSnapshot = workflowsService.getLiveInstanceState(
              workflowName,
              sessionId,
            );
            const [restoredState] = liveSessionSnapshot
              ? [undefined]
              : await this.handlerTx()
                  .withServiceCalls(() => [
                    workflowsService.restoreInstanceState(workflowName, sessionId),
                  ])
                  .transform(({ serviceResult }) => serviceResult)
                  .execute();

            const detailState = liveSessionSnapshot?.state ?? restoredState;
            if (!detailState) {
              throw createRouteError(
                "WORKFLOW_INSTANCE_MISSING",
                `Session ${sessionId} could not load live workflow state.`,
                500,
              );
            }

            const activeSession = ensureLiveSessionActiveState(detailState);
            const targetTurn = detailState.turn;
            const replayUpdates = activeSession?.replayTurn(targetTurn) ?? [];
            const snapshotMessage: PiActiveSessionProtocolMessage = {
              layer: "system",
              type: "snapshot",
              turn: targetTurn,
              phase: detailState.phase,
              waitingFor: detailState.waitingFor,
              replayCount: replayUpdates.filter((update) => update.type === "event").length,
            };

            if (!activeSession) {
              const inactiveMessage: PiActiveSessionProtocolMessage = {
                layer: "system",
                type: "inactive",
                reason: detailState.phase === "complete" ? "session-complete" : "session-idle",
                turn: detailState.turn,
                phase: detailState.phase,
                waitingFor: detailState.waitingFor,
              };

              return jsonStream(async (stream) => {
                await stream.write(snapshotMessage);
                await stream.write(inactiveMessage);
              });
            }

            const pendingMessages = replayUpdates.map((update) =>
              toActiveSessionProtocolMessage(update, "replay"),
            );
            const replayAlreadySettled = replayUpdates.some((update) => update.type === "settled");

            if (replayAlreadySettled) {
              return jsonStream(async (stream) => {
                await stream.write(snapshotMessage);
                for (const message of pendingMessages) {
                  await stream.write(message);
                }
              });
            }

            let cleanupDone = false;
            let streamWriter: ((message: PiActiveSessionProtocolMessage) => Promise<void>) | null =
              null;
            let flushPromise: Promise<void> | null = null;
            let resolveSettled: (() => void) | null = null;
            const settledPromise = new Promise<void>((resolve) => {
              resolveSettled = resolve;
            });

            const flushPendingMessages = async () => {
              if (streamWriter === null || flushPromise) {
                return flushPromise ?? Promise.resolve();
              }

              flushPromise = (async () => {
                while (pendingMessages.length > 0 && streamWriter) {
                  const nextMessage = pendingMessages.shift();
                  if (!nextMessage) {
                    continue;
                  }
                  await streamWriter(nextMessage);
                }
              })();

              try {
                await flushPromise;
              } finally {
                flushPromise = null;
                if (pendingMessages.length > 0 && streamWriter !== null) {
                  void flushPendingMessages();
                }
              }
            };

            const unsubscribe = activeSession.subscribe((update: PiActiveSessionUpdate) => {
              if (update.turn !== targetTurn) {
                return;
              }

              pendingMessages.push(toActiveSessionProtocolMessage(update, "live"));
              if (update.type === "settled") {
                resolveSettled?.();
              }
              if (streamWriter) {
                void flushPendingMessages();
              }
            });

            const cleanup = () => {
              if (cleanupDone) {
                return;
              }
              cleanupDone = true;
              unsubscribe();
              streamWriter = null;
              resolveSettled?.();
            };

            return jsonStream(async (stream) => {
              streamWriter = (message) => stream.write(message);
              stream.onAbort(() => {
                cleanup();
              });

              try {
                await stream.write(snapshotMessage);
                await flushPendingMessages();
                await settledPromise;
                await flushPendingMessages();
              } catch (streamError) {
                cleanup();
                throw streamError;
              }
              cleanup();
            });
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && "status" in err) {
              const routeError = err as RouteError;
              const code =
                routeError.code === "SESSION_NOT_FOUND"
                  ? "SESSION_NOT_FOUND"
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
            const message =
              err instanceof Error ? err.message : "Failed to stream the active session.";
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
        errorCodes: ["SESSION_NOT_FOUND", "SESSION_NOT_READY", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const values = await input.valid();
          const sessionId = pathParams.sessionId;

          const workflowsService = serviceDeps.workflows;

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

            if (!payload.steeringMode) {
              // This route still needs the persisted session row before sending the event so the
              // workflow receives the session's effective steering mode when the caller omits it.
              payload.steeringMode = normalizeSteeringMode(
                sessionRow.steeringMode ?? config.defaultSteeringMode,
              );
            }

            const result = await this.handlerTx()
              .withServiceCalls(() =>
                serviceCalls(
                  workflowsService.sendEvent(workflowName, sessionId, {
                    type: "user_message",
                    payload,
                  }),
                  workflowsService.getInstanceStatus(workflowName, sessionId),
                ),
              )
              .mutate(({ forSchema }) => {
                const updates: {
                  updatedAt: Date;
                  steeringMode?: "all" | "one-at-a-time";
                } = {
                  updatedAt: new Date(),
                };
                if (values.steeringMode) {
                  updates.steeringMode = values.steeringMode;
                }
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
              const code =
                routeError.code === "SESSION_NOT_FOUND"
                  ? "SESSION_NOT_FOUND"
                  : routeError.code === "SESSION_NOT_READY"
                    ? "SESSION_NOT_READY"
                    : "WORKFLOW_INSTANCE_MISSING";
              const status =
                code === "SESSION_NOT_FOUND" ? 404 : code === "SESSION_NOT_READY" ? 409 : 500;
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
