import { buildScopedInstanceRowId } from "@fragno-dev/workflows/instance-ref";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { serviceCalls, withDatabase } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { piSchema } from "../schema";
import type { PiFragmentConfig, PiSession } from "./types";
import {
  projectSessionDetailFromWorkflowHistory,
  type PiAgentLoopCursorState,
  type PiAgentLoopSerializableState,
} from "./workflow/reconstruct-session";

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

export type PiSessionDetailSnapshot = {
  session: PiSession;
  workflowStatus: InstanceStatus;
  detailState: PiAgentLoopSerializableState;
  /**
   * Step keys whose emissions are already represented in `detailState` because
   * the step has a persisted `workflow_step.result` row. Used by `/events` to
   * dedup against the emission bus's persisted-emission cache.
   */
  completedStepKeys: ReadonlySet<string>;
};

export const piFragmentDefinition = defineFragment<PiFragmentConfig>("pi-fragment")
  .extend(withDatabase(piSchema))
  .usesService<"workflows", WorkflowsFragmentServices>("workflows")
  .providesBaseService(({ defineService, serviceDeps }) =>
    defineService({
      getSessionDetailSnapshot: function (workflowName: string, sessionId: string) {
        return this.serviceTx(piSchema)
          .withServiceCalls(() =>
            serviceCalls(
              serviceDeps.workflows.getInstanceStatus(workflowName, sessionId),
              serviceDeps.workflows.listHistory({ workflowName, instanceId: sessionId }),
            ),
          )
          .retrieve((uow) =>
            uow.findFirst("session", (b) =>
              b.whereIndex("idx_session_workflow_session", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("sessionId", "=", sessionId)),
              ),
            ),
          )
          .transform(({ retrieveResult: [sessionRow], serviceResult }) => {
            if (!sessionRow) {
              throw new Error("SESSION_NOT_FOUND");
            }

            const session: PiSession = {
              id: sessionRow.sessionId,
              name: sessionRow.name ?? null,
              status: sessionRow.status as PiSession["status"],
              agent: sessionRow.agent,
              workflowName: sessionRow.workflowName,
              createdAt: sessionRow.createdAt,
              updatedAt: sessionRow.updatedAt,
            };
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
              session,
              workflowStatus,
              detailState,
              completedStepKeys,
            };
          })
          .build();
      },
      createSession: function (values: {
        id: string;
        workflowName: string;
        agent: string;
        name?: string;
        createdAt: Date;
      }) {
        return this.serviceTx(piSchema)
          .mutate(({ uow }) => {
            uow.create("session", {
              id: buildScopedInstanceRowId(values.workflowName, values.id),
              sessionId: values.id,
              name: values.name ?? null,
              agent: values.agent,
              workflowName: values.workflowName,
              status: "active",
              createdAt: values.createdAt,
              updatedAt: values.createdAt,
            });
          })
          .build();
      },
      createWorkflowSession: function (values: {
        id: string;
        workflowName: string;
        agent: string;
        name?: string;
        createdAt: Date;
        params?: unknown;
      }) {
        return this.serviceTx(piSchema)
          .withServiceCalls(() => [
            serviceDeps.workflows.createInstance(values.workflowName, {
              id: values.id,
              params: values.params,
            }),
          ])
          .mutate(({ uow }) => {
            uow.create("session", {
              id: buildScopedInstanceRowId(values.workflowName, values.id),
              sessionId: values.id,
              name: values.name ?? null,
              agent: values.agent,
              workflowName: values.workflowName,
              status: "active",
              createdAt: values.createdAt,
              updatedAt: values.createdAt,
            });
          })
          .build();
      },
    }),
  )
  .build();
