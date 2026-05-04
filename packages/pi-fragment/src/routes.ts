import { createId } from "@fragno-dev/db/id";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { serviceCalls, type DatabaseRequestContext } from "@fragno-dev/db";

import { PiLogger } from "./debug-log";
import { piFragmentDefinition } from "./pi/definition";
import { normalizeSteeringMode, toSessionOutput } from "./pi/mappers";
import { createPiJsonlExport } from "./pi/pi-jsonl-export";
import {
  activeSessionStreamItemSchema,
  commandAckSchema,
  commandInputSchema,
  sessionBaseSchema,
  sessionDetailSchema,
} from "./pi/route-schemas";
import type {
  PiActiveSessionProtocolMessage,
  PiActiveSessionUpdate,
  PiAgentLoopSerializableState,
  PiAgentLoopState,
  PiPromptInput,
  PiSession,
  PiSessionCommandPayload,
  PiWorkflowsInstanceStatus,
} from "./pi/types";
import { projectSessionDetailFromWorkflowHistory } from "./pi/workflow/reconstruct-session";
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

const isSessionStreamable = (state: PiAgentLoopState) => state.phase !== "complete";

const ensureLiveSessionActiveState = (state: PiAgentLoopState) => {
  if (!isSessionStreamable(state)) {
    return null;
  }
  return ensurePiActiveSessionState(state);
};

const createCommandPayload = (
  commandId: string,
  command: z.infer<typeof commandInputSchema>,
): PiSessionCommandPayload => {
  switch (command.kind) {
    case "prompt":
    case "steer":
    case "followUp":
      return { commandId, kind: command.kind, input: command.input as PiPromptInput };
    case "abort":
    case "complete":
      return command.reason
        ? { commandId, kind: command.kind, reason: command.reason }
        : { commandId, kind: command.kind };
    case "continue":
      return { commandId, kind: command.kind };
  }
};

type PiSessionDetailSnapshot = {
  session: PiSession;
  workflowStatus: PiWorkflowsInstanceStatus;
  detailState: PiAgentLoopSerializableState;
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

    const loadPiSessionDetailSnapshot = async (
      routeContext: DatabaseRequestContext,
      sessionId: string,
    ): Promise<PiSessionDetailSnapshot> => {
      const workflowsService = serviceDeps.workflows;
      const workflowName = PI_WORKFLOW_NAME;
      const liveSessionSnapshot = workflowsService.getLiveInstanceState(workflowName, sessionId);

      const result = await routeContext
        .handlerTx()
        .withServiceCalls(() =>
          serviceCalls(
            workflowsService.getInstanceStatus(workflowName, sessionId),
            workflowsService.listHistory({ workflowName, instanceId: sessionId }),
            liveSessionSnapshot
              ? undefined
              : workflowsService.restoreInstanceState(workflowName, sessionId),
          ),
        )
        .retrieve(({ forSchema }) =>
          forSchema(piSchema).findFirst("session", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
          ),
        )
        .transform(({ retrieveResult: [sessionRow], serviceResult }) => {
          if (!sessionRow) {
            throw createRouteError("SESSION_NOT_FOUND", `Session ${sessionId} not found.`, 404);
          }

          const [workflowStatus, history, restoredCursorState] = serviceResult;
          const cursorState =
            liveSessionSnapshot?.state ?? restoredCursorState ?? createInitialPiAgentLoopState();
          const detailState = projectSessionDetailFromWorkflowHistory({
            liveState: cursorState,
            events: history.events,
            steps: history.steps,
          });

          return {
            session: toSessionOutput(sessionRow),
            workflowStatus,
            detailState,
          };
        })
        .execute();

      return result;
    };

    const toSessionDetailLoadError = (err: unknown, sessionId: string) => {
      if (err && typeof err === "object" && "code" in err && "status" in err) {
        const routeError = err as RouteError;
        const code: "SESSION_NOT_FOUND" | "WORKFLOW_INSTANCE_MISSING" =
          routeError.code === "SESSION_NOT_FOUND"
            ? "SESSION_NOT_FOUND"
            : "WORKFLOW_INSTANCE_MISSING";
        return {
          body: { message: routeError.message, code },
          init: { status: code === "SESSION_NOT_FOUND" ? (404 as const) : (500 as const) },
        };
      }
      if (err instanceof Error && err.message === "INSTANCE_NOT_FOUND") {
        return {
          body: { message: `Session ${sessionId} not found.`, code: "SESSION_NOT_FOUND" as const },
          init: { status: 404 as const },
        };
      }
      const message = err instanceof Error ? err.message : "Failed to load workflow detail.";
      return {
        body: { message, code: "WORKFLOW_INSTANCE_MISSING" as const },
        init: { status: 500 as const },
      };
    };

    return [
      defineRoute({
        method: "POST",
        path: "/sessions",
        inputSchema: z.object({
          agent: z.string(),
          name: z.string().optional(),
          systemMessage: z.string().optional(),
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
            const systemPrompt = [agent.systemPrompt, values.systemMessage]
              .filter((value): value is string => typeof value === "string" && value.trim() !== "")
              .join("\n\n");

            await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    workflowsService.createInstance(PI_WORKFLOW_NAME, {
                      id: sessionId,
                      params: {
                        sessionId,
                        agentName,
                        systemPrompt,
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
        queryParameters: ["events", "trace", "turns"],
        outputSchema: sessionDetailSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const sessionId = pathParams.sessionId;
          const includeEvents = parseBooleanQueryValue(query.get("events"), true);
          const includeTrace = parseBooleanQueryValue(query.get("trace"), true);
          const includeTurns = parseBooleanQueryValue(query.get("turns"), true);

          try {
            const result = await loadPiSessionDetailSnapshot(this, sessionId);

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
              turns: includeTurns ? result.detailState.turns : [],
              commandHistory: result.detailState.commandHistory,
            });
          } catch (err) {
            const loadError = toSessionDetailLoadError(err, sessionId);
            return error(loadError.body, loadError.init);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sessions/:sessionId/export/pi-jsonl",
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams }, { error }) {
          const sessionId = pathParams.sessionId;

          try {
            const snapshot = await loadPiSessionDetailSnapshot(this, sessionId);
            const agent = config.agents[snapshot.session.agent];
            if (!agent) {
              return error(
                {
                  message: `Agent ${snapshot.session.agent} not found for session ${sessionId}.`,
                  code: "WORKFLOW_INSTANCE_MISSING",
                },
                { status: 500 },
              );
            }

            const jsonl = createPiJsonlExport({
              session: snapshot.session,
              agent,
              messages: snapshot.detailState.messages,
            });

            return new Response(jsonl, {
              status: 200,
              headers: {
                "content-type": "application/x-ndjson; charset=utf-8",
                "content-disposition": `attachment; filename="pi-session-${sessionId}.jsonl"`,
              },
            });
          } catch (err) {
            const loadError = toSessionDetailLoadError(err, sessionId);
            return error(loadError.body, loadError.init);
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
        path: "/sessions/:sessionId/command",
        inputSchema: commandInputSchema,
        outputSchema: commandAckSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const command = await input.valid();
          const sessionId = pathParams.sessionId;
          const workflowsService = serviceDeps.workflows;
          const workflowName = PI_WORKFLOW_NAME;
          const commandId = createId();
          const payload = createCommandPayload(commandId, command);

          try {
            const liveInjection =
              command.kind === "abort" || command.kind === "steer" || command.kind === "followUp"
                ? (() => {
                    const liveState = workflowsService.getLiveInstanceState(
                      workflowName,
                      sessionId,
                    );
                    const activeSession = liveState?.state
                      ? ensurePiActiveSessionState(liveState.state)
                      : null;
                    return activeSession?.recordLiveInjection(
                      commandId,
                      command.kind,
                      "input" in payload ? payload.input : undefined,
                    );
                  })()
                : null;

            const result = await this.handlerTx()
              .withServiceCalls(() =>
                liveInjection?.injected
                  ? serviceCalls(workflowsService.getInstanceStatus(workflowName, sessionId))
                  : serviceCalls(
                      workflowsService.sendEvent(workflowName, sessionId, {
                        type: "command",
                        payload,
                      }),
                      workflowsService.getInstanceStatus(workflowName, sessionId),
                    ),
              )
              .retrieve(({ forSchema }) =>
                forSchema(piSchema).findFirst("session", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
                ),
              )
              .mutate(({ forSchema, retrieveResult: [sessionRow] }) => {
                if (!sessionRow) {
                  throw createRouteError(
                    "SESSION_NOT_FOUND",
                    `Session ${sessionId} not found.`,
                    404,
                  );
                }

                const uow = forSchema(piSchema);
                uow.update("session", sessionRow.id, (b) =>
                  b.set({ updatedAt: new Date() }).check(),
                );
              })
              .transform(({ serviceResult }) => {
                const workflowStatus = liveInjection?.injected
                  ? serviceResult[0]
                  : serviceResult[1];
                if (!workflowStatus) {
                  throw createRouteError(
                    "WORKFLOW_INSTANCE_MISSING",
                    `Session ${sessionId} workflow status is missing.`,
                    500,
                  );
                }
                return { workflowStatus };
              })
              .execute();

            return json(
              {
                accepted: true,
                commandId,
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
            const message = err instanceof Error ? err.message : "Failed to deliver command.";
            return error({ message, code: "WORKFLOW_INSTANCE_MISSING" }, { status: 500 });
          }
        },
      }),
    ];
  },
);
