import { createId } from "@fragno-dev/db/id";
import { WorkflowsLogger } from "@fragno-dev/workflows/debug-log";
import { streamWorkflowStepEmissions } from "@fragno-dev/workflows/stream-step-emissions";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { serviceCalls, type DatabaseRequestContext } from "@fragno-dev/db";

import { PiLogger } from "./debug-log";
import { piFragmentDefinition } from "./pi/definition";
import { createPiJsonlExport } from "./pi/pi-jsonl-export";
import {
  commandAckSchema,
  commandInputSchema,
  sessionBaseSchema,
  sessionDetailSchema,
  sessionEventStreamItemSchema,
} from "./pi/route-schemas";
import type {
  PiSession,
  PiSessionCommandPayload,
  PiSessionEventStreamItem,
  PiWorkflowsInstanceStatus,
} from "./pi/types";
import {
  projectSessionDetailFromWorkflowHistory,
  type PiAgentLoopCursorState,
  type PiAgentLoopSerializableState,
} from "./pi/workflow/reconstruct-session";
import { PI_WORKFLOW_NAME } from "./pi/workflow/workflow";
import { piSchema } from "./schema";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

class RouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const createRouteError = (code: string, message: string, status: number): RouteError =>
  new RouteError(code, message, status);

const isRouteError = (err: unknown): err is RouteError => err instanceof RouteError;

const createCommandPayload = (
  commandId: string,
  command: z.infer<typeof commandInputSchema>,
): PiSessionCommandPayload => {
  switch (command.kind) {
    case "prompt":
    case "steer":
    case "followUp":
      return { commandId, kind: command.kind, input: command.input };
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
  /**
   * Step keys whose emissions are already represented in `detailState` because
   * the step has a persisted `workflow_step.result` row. Used by `/events` to
   * dedup against the emission bus's persisted-emission cache.
   */
  completedStepKeys: ReadonlySet<string>;
};

const LIVE_EVENT_STREAM_TIMEOUT_MS = 60_000;
const WAIT_FOR_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

const createInitialPiAgentLoopCursorState = (): PiAgentLoopCursorState => ({
  turn: 0,
  phase: "waiting-for-command",
  waitingFor: {
    type: "command",
    turn: 0,
    stepKey: "waitForEvent:wait-command-turn-0-command-0",
    allowedCommands: ["prompt", "followUp", "complete"],
    timeoutMs: WAIT_FOR_COMMAND_TIMEOUT_MS,
  },
});

const parseBooleanQueryValue = (value: string | null): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const piRoutesFactory = defineRoutes(piFragmentDefinition).create(
  ({ config, defineRoute, serviceDeps }) => {
    PiLogger.reset();
    if (config.logging) {
      PiLogger.configure(config.logging);
      WorkflowsLogger.configure(config.logging);
    }

    const loadPiSessionDetailSnapshot = async (
      routeContext: DatabaseRequestContext,
      sessionId: string,
    ): Promise<PiSessionDetailSnapshot> => {
      const workflowsService = serviceDeps.workflows;
      const workflowName = PI_WORKFLOW_NAME;

      const result = await routeContext
        .handlerTx()
        .withServiceCalls(() =>
          serviceCalls(
            workflowsService.getInstanceStatus(workflowName, sessionId),
            workflowsService.listHistory({ workflowName, instanceId: sessionId }),
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

          const [workflowStatus, history] = serviceResult;
          const cursorState = createInitialPiAgentLoopCursorState();
          const detailState = projectSessionDetailFromWorkflowHistory({
            cursorState,
            events: history.events,
            steps: history.steps,
          });
          const completedStepKeys = new Set(
            history.steps
              .filter((step) => step.status === "completed" && step.result !== null)
              .map((step) => step.stepKey),
          );

          return {
            session: {
              id: sessionRow.id.valueOf(),
              name: sessionRow.name ?? null,
              status: sessionRow.status as PiSession["status"],
              agent: sessionRow.agent,
              createdAt: sessionRow.createdAt,
              updatedAt: sessionRow.updatedAt,
            },
            workflowStatus,
            detailState,
            completedStepKeys,
          };
        })
        .execute();

      return result;
    };

    const toSessionDetailLoadError = (err: unknown, sessionId: string) => {
      if (isRouteError(err)) {
        const code: "SESSION_NOT_FOUND" | "WORKFLOW_INSTANCE_MISSING" =
          err.code === "SESSION_NOT_FOUND" ? "SESSION_NOT_FOUND" : "WORKFLOW_INSTANCE_MISSING";
        return {
          body: { message: err.message, code },
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

          return json(
            sessions.map((session) => ({
              id: session.id.valueOf(),
              name: session.name ?? null,
              status: session.status as PiSession["status"],
              agent: session.agent,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            })),
          );
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sessions/:sessionId",
        outputSchema: sessionDetailSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams: { sessionId } }, { json, error }) {
          try {
            const result = await loadPiSessionDetailSnapshot(this, sessionId);
            const agentEvents = result.detailState.events;

            return json({
              ...result.session,
              agentName: result.session.agent,
              status: result.workflowStatus.status,
              workflow: {
                status: result.workflowStatus.status,
                error: result.workflowStatus.error,
                output: result.workflowStatus.output,
              },
              agent: {
                state: { messages: result.detailState.messages },
                events: agentEvents,
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
        path: "/sessions/:sessionId/events",
        queryParameters: ["once"],
        outputSchema: z.array(sessionEventStreamItemSchema),
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ pathParams, query }, { error, jsonStream }) {
          const sessionId = pathParams.sessionId;
          const once = parseBooleanQueryValue(query.get("once"));
          const workflowsService = serviceDeps.workflows;

          try {
            const initialDetail = await loadPiSessionDetailSnapshot(this, sessionId);

            return jsonStream(async (stream) => {
              const emissionBusHandle =
                workflowsService.observeStepEmissions<PiSessionEventStreamItem>({
                  workflowName: PI_WORKFLOW_NAME,
                  instanceId: sessionId,
                  handlerTx: this.handlerTx,
                });
              const emissionBus = emissionBusHandle.pump;

              const snapshot = await emissionBus.snapshot();

              const inFlightEvents = snapshot
                .filter(
                  (emission) =>
                    emission.actor === "user" &&
                    !initialDetail.completedStepKeys.has(emission.stepKey),
                )
                .map((emission) => emission.payload)
                .filter(
                  (payload): payload is PiSessionEventStreamItem =>
                    !("type" in payload) || payload.type !== "snapshot",
                );

              const initialEmissions: PiSessionEventStreamItem[] = [
                {
                  type: "snapshot",
                  state: { messages: initialDetail.detailState.messages },
                },
                ...inFlightEvents,
              ];

              try {
                if (once) {
                  for (const emission of initialEmissions) {
                    await stream.write(emission);
                  }
                  return;
                }

                await streamWorkflowStepEmissions({
                  stream,
                  emissionBus: {
                    observe: (handler) =>
                      emissionBus.observe(
                        (message) => {
                          if (message.actor === "user") {
                            return handler(message);
                          }
                        },
                        { after: snapshot },
                      ),
                  },
                  initialEmissions,
                  timeoutMs: LIVE_EVENT_STREAM_TIMEOUT_MS,
                });
              } finally {
                await emissionBusHandle.close();
              }
            });
          } catch (err) {
            if (isRouteError(err)) {
              const code =
                err.code === "SESSION_NOT_FOUND"
                  ? "SESSION_NOT_FOUND"
                  : "WORKFLOW_INSTANCE_MISSING";
              const status = code === "SESSION_NOT_FOUND" ? 404 : 500;
              return error({ message: err.message, code }, { status });
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
            const result = await this.handlerTx()
              .withServiceCalls(() =>
                serviceCalls(
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
                const workflowStatus = serviceResult[1];
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
            if (isRouteError(err)) {
              const code =
                err.code === "SESSION_NOT_FOUND"
                  ? "SESSION_NOT_FOUND"
                  : "WORKFLOW_INSTANCE_MISSING";
              const status = code === "SESSION_NOT_FOUND" ? 404 : 500;
              return error({ message: err.message, code }, { status });
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
