import { buildScopedInstanceRowId } from "@fragno-dev/workflows/instance-ref";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { serviceCalls, withDatabase } from "@fragno-dev/db";
import type { WorkflowsFragmentServices, WorkflowsHistoryStep } from "@fragno-dev/workflows";

import {
  buildSessionContext,
  type AgentEvent,
  type AgentMessage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import { piSchema } from "../schema";
import type { PiHarnessStepResult } from "./harness/run-pi-harness-step";
import type { PiFragmentConfig, PiSession } from "./types";

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
  events: AgentEvent[];
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPiHarnessStepResult = (value: unknown): value is PiHarnessStepResult =>
  isObjectRecord(value) && value["type"] === "harness-run" && Array.isArray(value["entries"]);

const leafIdAfterEntry = (entry: SessionTreeEntry): string | null =>
  entry.type === "leaf" ? entry.targetId : entry.id;

const getLeafIdFromEntries = (entries: readonly SessionTreeEntry[]): string | null => {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = leafIdAfterEntry(entry);
  }
  return leafId;
};

const getPathToRoot = (
  entries: readonly SessionTreeEntry[],
  leafId: string | null,
): SessionTreeEntry[] => {
  if (leafId === null) {
    return [];
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionTreeEntry[] = [];
  let current = byId.get(leafId);
  if (!current) {
    return [];
  }

  while (current) {
    path.unshift(current);
    if (!current.parentId) {
      break;
    }
    current = byId.get(current.parentId);
    if (!current) {
      return [];
    }
  }

  return path;
};

const projectSessionDetailFromSessionEntries = ({
  cursorState,
  entries,
}: {
  cursorState: PiAgentLoopCursorState;
  entries: readonly SessionTreeEntry[];
}): PiAgentLoopSerializableState => {
  const leafId = getLeafIdFromEntries(entries);
  const path = getPathToRoot(entries, leafId);
  const context = buildSessionContext(path);

  return {
    ...cursorState,
    messages: context.messages as AgentMessage[],
    events: [],
  };
};

const latestCompletedHarnessEntries = (
  steps: readonly WorkflowsHistoryStep[],
): readonly SessionTreeEntry[] => {
  const latestHarnessStep = [...steps]
    .filter((step) => step.status === "completed" && isPiHarnessStepResult(step.result))
    .at(-1);

  return isPiHarnessStepResult(latestHarnessStep?.result) ? latestHarnessStep.result.entries : [];
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
   * the step has a persisted `workflow_step.result` row. Used by `/events` to
   * dedup against the emission bus's persisted-emission cache.
   */
  completedStepKeys: ReadonlySet<string>;
};

export const piHarnessDefinition = defineFragment<PiFragmentConfig>("pi-harness")
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
              agent: sessionRow.agent,
              workflowName: sessionRow.workflowName,
              createdAt: sessionRow.createdAt,
              updatedAt: sessionRow.updatedAt,
            };
            const [workflowStatus, history] = serviceResult;
            const cursorState = createInitialPiAgentLoopCursorState();
            const sessionEntries = latestCompletedHarnessEntries(history.steps);
            const detailState = projectSessionDetailFromSessionEntries({
              cursorState,
              entries: sessionEntries,
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
              sessionEntries,
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
