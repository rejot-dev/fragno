import { createId } from "@fragno-dev/db/id";
import { WorkflowsLogger } from "@fragno-dev/workflows/debug-log";
import {
  WorkflowInstanceNotFoundError,
  WorkflowNotFoundError,
  WorkflowParamsInvalidError,
} from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { serviceCalls } from "@fragno-dev/db";
import { validateWorkflowParams } from "@fragno-dev/workflows";

import { piHarnessDefinition, type PiSessionDetailSnapshot } from "./pi/definition";
import { piHarnessEventProtocol } from "./pi/harness/agent-harness-event-protocol";
import {
  createWorkflowBackedSessionEntryIdAllocator,
  WorkflowBackedSessionStorage,
} from "./pi/harness/session-storage";
import { exportSessionStorageToJsonl, PI_JSONL_EXPORT_CWD } from "./pi/pi-jsonl-export";
import {
  commandAckSchema,
  commandInputSchema,
  sessionBaseSchema,
  sessionDetailSchema,
} from "./pi/route-schemas";
import {
  PiSessionDataIntegrityError,
  PiSessionDataUnavailableError,
  projectPiSessionFromWorkflowInstance,
  type PiSessionCommandPayload,
  type PiSessionDetail,
} from "./pi/types";
import type { PiHarnessEmission } from "./pi/workflows/workflow-agent-harness";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_AGENT_END_WAIT_TIMEOUT_MS = 60_000;
const MAX_AGENT_END_WAIT_TIMEOUT_MS = 120_000;

const createCommandPayload = (
  commandId: string,
  command: z.infer<typeof commandInputSchema>,
): PiSessionCommandPayload => {
  switch (command.kind) {
    case "prompt":
      return { commandId, kind: command.kind, input: command.input };
    case "skill":
      return { commandId, kind: command.kind, input: command.input };
    case "promptFromTemplate":
      return { commandId, kind: command.kind, input: command.input };
    case "compact":
      return { commandId, kind: command.kind, input: command.input };
    case "steer":
      return { commandId, kind: command.kind, input: command.input };
    case "followUp":
      return { commandId, kind: command.kind, input: command.input };
    case "abort":
      return command.reason
        ? { commandId, kind: command.kind, reason: command.reason }
        : { commandId, kind: command.kind };
  }

  throw new Error("Unsupported Pi session command kind.");
};

const normalizeAgentEndWaitTimeout = (timeoutMs: number | undefined): number =>
  Math.min(timeoutMs ?? DEFAULT_AGENT_END_WAIT_TIMEOUT_MS, MAX_AGENT_END_WAIT_TIMEOUT_MS);

const parsePositiveIntegerQueryValue = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const toSessionDetail = (snapshot: PiSessionDetailSnapshot): PiSessionDetail => ({
  ...snapshot.session,
  workflow: {
    status: snapshot.workflowStatus.status,
    error: snapshot.workflowStatus.error,
    output: snapshot.workflowStatus.output,
  },
  agent: {
    state: { messages: snapshot.messages },
  },
});

export const piRoutesFactory = defineRoutes(piHarnessDefinition).create(
  ({ config, defineRoute, serviceDeps, services }) => {
    if (config.logging) {
      WorkflowsLogger.configure(config.logging);
    }

    const toSessionDetailLoadError = (err: unknown, workflowName: string, sessionId: string) => {
      if (err instanceof WorkflowInstanceNotFoundError) {
        return {
          body: {
            message: `Session ${workflowName}/${sessionId} not found.`,
            code: "SESSION_NOT_FOUND" as const,
          },
          init: { status: 404 as const },
        };
      }
      if (err instanceof PiSessionDataUnavailableError) {
        return {
          body: {
            message: err.message,
            code: "SESSION_DATA_UNAVAILABLE" as const,
          },
          init: { status: 404 as const },
        };
      }
      if (err instanceof PiSessionDataIntegrityError) {
        return {
          body: {
            message: err.message,
            code: "SESSION_DATA_INTEGRITY_ERROR" as const,
          },
          init: { status: 500 as const },
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
        path: "/workflows/:workflowName/sessions",
        inputSchema: z.object({
          name: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          input: z.unknown().optional(),
        }),
        outputSchema: sessionBaseSchema,
        errorCodes: ["WORKFLOW_NOT_FOUND", "WORKFLOW_PARAMS_INVALID", "WORKFLOW_CREATE_FAILED"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const values = await input.valid();

          const workflowName = pathParams.workflowName;
          const now = new Date();
          const sessionId = createId();

          try {
            const workflowsByName = new Map(
              (config.workflows ?? []).map((workflow) => [workflow.name, workflow]),
            );
            const validatedParams = await validateWorkflowParams(
              workflowsByName,
              workflowName,
              values.input,
            );
            if (
              typeof validatedParams !== "object" ||
              validatedParams === null ||
              Array.isArray(validatedParams)
            ) {
              throw new WorkflowParamsInvalidError(workflowName, [
                "Workflow parameters must resolve to an object.",
              ]);
            }
            const params = { ...(validatedParams as Record<string, unknown>) };
            if (values.metadata !== undefined) {
              params["metadata"] = values.metadata;
            } else {
              delete params["metadata"];
            }
            await this.handlerTx()
              .withServiceCalls(() => [
                services.createWorkflowSession({
                  id: sessionId,
                  workflowName,
                  name: values.name,
                  params,
                }),
              ])
              .execute();

            return json({
              id: sessionId,
              name: values.name ?? null,
              metadata: values.metadata ?? null,
              workflowName,
              createdAt: now,
              updatedAt: now,
            });
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              return error(
                { message: `Workflow ${workflowName} not found.`, code: "WORKFLOW_NOT_FOUND" },
                { status: 404 },
              );
            }
            if (err instanceof WorkflowParamsInvalidError) {
              return error(
                { message: "Workflow input is invalid.", code: "WORKFLOW_PARAMS_INVALID" },
                { status: 400 },
              );
            }
            const message =
              err instanceof Error ? err.message : "Failed to create workflow instance.";
            return error({ message, code: "WORKFLOW_CREATE_FAILED" }, { status: 500 });
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/workflows/:workflowName/sessions",
        queryParameters: ["limit"],
        outputSchema: z.array(sessionBaseSchema),
        errorCodes: ["SESSION_DATA_INTEGRITY_ERROR"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const workflowName = pathParams.workflowName;
          const limit = Number.parseInt(query.get("limit") ?? `${DEFAULT_PAGE_SIZE}`, 10);
          const normalizedLimit = Number.isFinite(limit)
            ? Math.max(1, Math.min(MAX_PAGE_SIZE, limit))
            : DEFAULT_PAGE_SIZE;

          // TODO: Apply the limit after excluding workflow instances without Pi metadata, so non-Pi rows do not consume the requested page.
          const result = await this.handlerTx()
            .withServiceCalls(() => [
              serviceDeps.workflows.listInstances({
                workflowName,
                pageSize: normalizedLimit,
              }),
            ])
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          try {
            return json(
              result.instances.flatMap((instance) => {
                const session = projectPiSessionFromWorkflowInstance({
                  id: instance.id,
                  workflowName,
                  params: instance.params,
                  createdAt: instance.createdAt,
                  updatedAt: instance.updatedAt,
                });
                return session ? [session] : [];
              }),
            );
          } catch (err) {
            if (err instanceof PiSessionDataIntegrityError) {
              return error(
                { message: err.message, code: "SESSION_DATA_INTEGRITY_ERROR" },
                { status: 500 },
              );
            }
            throw err;
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/workflows/:workflowName/sessions/:sessionId",
        outputSchema: sessionDetailSchema,
        errorCodes: [
          "SESSION_NOT_FOUND",
          "SESSION_DATA_UNAVAILABLE",
          "SESSION_DATA_INTEGRITY_ERROR",
          "WORKFLOW_INSTANCE_MISSING",
        ],
        handler: async function ({ pathParams: { workflowName, sessionId } }, { json, error }) {
          try {
            const result = await this.handlerTx()
              .withServiceCalls(
                () => [services.getSessionDetailSnapshot(workflowName, sessionId)] as const,
              )
              .transform(({ serviceResult: [snapshot] }) => snapshot)
              .execute();
            return json(toSessionDetail(result));
          } catch (err) {
            const loadError = toSessionDetailLoadError(err, workflowName, sessionId);
            return error(loadError.body, loadError.init);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/workflows/:workflowName/sessions/:sessionId/export/pi-jsonl",
        errorCodes: [
          "SESSION_NOT_FOUND",
          "SESSION_DATA_UNAVAILABLE",
          "SESSION_DATA_INTEGRITY_ERROR",
          "WORKFLOW_INSTANCE_MISSING",
        ],
        handler: async function ({ pathParams: { workflowName, sessionId } }, { error }) {
          try {
            const snapshot = await this.handlerTx()
              .withServiceCalls(
                () => [services.getSessionDetailSnapshot(workflowName, sessionId)] as const,
              )
              .transform(({ serviceResult: [snapshot] }) => snapshot)
              .execute();
            const storage = new WorkflowBackedSessionStorage({
              metadata: {
                id: snapshot.session.id,
                createdAt: snapshot.session.createdAt.toISOString(),
              },
              entries: snapshot.sessionEntries,
              entryIds: createWorkflowBackedSessionEntryIdAllocator({
                prefix: `${snapshot.session.id}:export:entry`,
                startIndex: snapshot.sessionEntries.length,
              }),
            });
            const jsonl = await exportSessionStorageToJsonl(storage, { cwd: PI_JSONL_EXPORT_CWD });

            return new Response(jsonl, {
              status: 200,
              headers: {
                "content-type": "application/x-ndjson; charset=utf-8",
                "content-disposition": `attachment; filename="pi-session-${sessionId}.jsonl"`,
              },
            });
          } catch (err) {
            const loadError = toSessionDetailLoadError(err, workflowName, sessionId);
            return error(loadError.body, loadError.init);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/workflows/:workflowName/sessions/:sessionId/wait-for-agent-end",
        queryParameters: ["timeoutMs"],
        outputSchema: sessionDetailSchema,
        errorCodes: [
          "SESSION_NOT_FOUND",
          "SESSION_DATA_UNAVAILABLE",
          "SESSION_DATA_INTEGRITY_ERROR",
          "WORKFLOW_INSTANCE_MISSING",
          "AGENT_END_TIMEOUT",
        ],
        handler: async function ({ pathParams, query }, { json, error }) {
          const timeoutMs = parsePositiveIntegerQueryValue(query.get("timeoutMs"));
          const workflowName = pathParams.workflowName;
          const sessionId = pathParams.sessionId;
          const workflowsService = serviceDeps.workflows;
          const waitTimeoutMs = normalizeAgentEndWaitTimeout(timeoutMs);

          try {
            const emissionBusHandle = workflowsService.observeStepEmissions<PiHarnessEmission>({
              workflowName,
              instanceId: sessionId,
              handlerTx: this.handlerTx.bind(this),
            });

            try {
              const emissionSnapshot = await emissionBusHandle.pump.snapshot();
              await emissionBusHandle.pump.waitForObserved(
                (emission) =>
                  emission.payload.kind === "harness-event" &&
                  piHarnessEventProtocol.eventType(emission.payload.event) === "agent_end",
                {
                  after: emissionSnapshot,
                  timeoutMs: waitTimeoutMs,
                  timeoutMessage: `Timed out waiting for agent_end for ${workflowName}/${sessionId}.`,
                },
              );

              const result = await this.handlerTx()
                .withServiceCalls(
                  () => [services.getSessionDetailSnapshot(workflowName, sessionId)] as const,
                )
                .transform(({ serviceResult: [snapshot] }) => snapshot)
                .execute();

              return json(toSessionDetail(result));
            } finally {
              await emissionBusHandle.close();
            }
          } catch (err) {
            if (err instanceof Error && err.name === "BufferedPumpObserveTimeoutError") {
              return error({ message: err.message, code: "AGENT_END_TIMEOUT" }, { status: 408 });
            }
            const loadError = toSessionDetailLoadError(err, workflowName, sessionId);
            return error(loadError.body, loadError.init);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/workflows/:workflowName/sessions/:sessionId/command",
        inputSchema: commandInputSchema,
        outputSchema: commandAckSchema,
        errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const command = await input.valid();
          const workflowName = pathParams.workflowName;
          const sessionId = pathParams.sessionId;
          const workflowsService = serviceDeps.workflows;
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
              .transform(({ serviceResult: [, workflowStatus] }) => ({ workflowStatus }))
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
            if (err instanceof WorkflowInstanceNotFoundError) {
              return error(
                {
                  message: `Session ${workflowName}/${sessionId} not found.`,
                  code: "SESSION_NOT_FOUND",
                },
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
