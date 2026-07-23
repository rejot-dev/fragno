import { buildScopedInstanceRowId } from "@fragno-dev/workflows/instance-ref";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { serviceCalls, withDatabase, type HookFn } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { piSchema } from "../schema";
import type { PiHarnessStepResult } from "./harness/run-pi-harness-step";
import type { PiFragmentConfig, PiSession, PiOperationCompletedHookPayload } from "./types";
import {
  latestCompletedPiHarnessEntries,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionStep,
} from "./workflow-session-projection";

export type PiAgentLoopCursorState = {
  turn: number;
  phase: "waiting-for-command" | "running-agent";
  waitingFor:
    | {
        type: "command";
        turn: number;
        stepKey: string;
        allowedCommands: ("prompt" | "followUp" | "steer" | "nextTurn" | "abort")[];
        timeoutMs: number | null;
      }
    | {
        type: "agent" | "assistant";
        turn: number;
        operation?: "prompt";
        stepKey: string;
      }
    | null;
};

export type PiAgentLoopSerializableState = PiAgentLoopCursorState & {
  messages: AgentMessage[];
};

export type PiHarnessHooksMap = {
  onOperationCompleted: HookFn<PiOperationCompletedHookPayload>;
};

const WAIT_FOR_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

const createInitialPiAgentLoopCursorState = (): PiAgentLoopCursorState => ({
  turn: 0,
  phase: "waiting-for-command",
  waitingFor: {
    type: "command",
    turn: 0,
    stepKey: "waitForEvent:wait-command-turn-0-command-0",
    allowedCommands: ["prompt", "followUp", "steer", "nextTurn", "abort"],
    timeoutMs: WAIT_FOR_COMMAND_TIMEOUT_MS,
  },
});

export type PiSessionDetailSnapshot = {
  session: PiSession;
  workflowStatus: InstanceStatus;
  detailState: PiAgentLoopSerializableState;
  sessionEntries: readonly SessionTreeEntry[];
  /**
   * Step keys whose emissions are already represented in `detailState` because
   * the step has a persisted `workflow_step.result` row.
   */
  completedStepKeys: ReadonlySet<string>;
};

export const piHarnessDefinition = defineFragment<PiFragmentConfig>("pi-harness")
  .extend(withDatabase(piSchema))
  .usesService<"workflows", WorkflowsFragmentServices>("workflows")
  .provideHooks<PiHarnessHooksMap>(({ defineHook, config }) => ({
    onOperationCompleted: defineHook<PiOperationCompletedHookPayload>(async function (payload) {
      await config.onOperationCompleted?.(payload, this);
    }),
  }))
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
              agent: sessionRow.agent,
              workflowName: sessionRow.workflowName,
              createdAt: sessionRow.createdAt,
              updatedAt: sessionRow.updatedAt,
            };
            const [workflowStatus, history] = serviceResult;
            const cursorState = createInitialPiAgentLoopCursorState();
            const workflowSteps: PiWorkflowSessionProjectionStep[] = history.steps.map((step) => ({
              stepKey: step.stepKey,
              type: step.type,
              status: step.status,
              waitEventType: step.waitEventType,
              result: (step.result ?? null) as PiHarnessStepResult | null,
            }));
            const projection = projectPiWorkflowSession({
              workflowName,
              sessionId,
              instance: workflowStatus,
              workflowSteps,
              workflowStepEmissions: history.emissions.map((emission) => ({
                stepKey: emission.stepKey,
                payload:
                  typeof emission.payload === "object" && emission.payload !== null
                    ? (emission.payload as never)
                    : null,
                createdAt: emission.createdAt,
              })),
            });
            const detailState: PiAgentLoopSerializableState = {
              ...cursorState,
              messages: projection.state.messages,
            };
            const completedStepKeys = new Set(projection.completedStepKeys);

            return {
              session,
              workflowStatus,
              detailState,
              sessionEntries: latestCompletedPiHarnessEntries(workflowSteps),
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
              createdAt: values.createdAt,
              updatedAt: values.createdAt,
            });
          })
          .build();
      },
    }),
  )
  .build();

export const piFragmentDefinition = piHarnessDefinition;
