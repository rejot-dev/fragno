import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  createLofiQueryStore,
  type LofiFindBuilder,
  type LofiQueryFindResult,
  type LofiRuntime,
} from "@fragno-dev/lofi";

import type { PiHarnessEmission, PiHarnessStepResult } from "../pi/harness/run-pi-harness-step";
import type { PiAgentStateSnapshot } from "../pi/types";
import {
  emptyPiWorkflowSessionProjectionState,
  latestCompletedPiHarnessEntries,
  piAgentMessagesFromSessionEntries,
  projectPiWorkflowSession,
  type DraftAgentActivity,
  type DraftAgentMessage,
  type DraftTool,
  type PiSessionProjectionError,
  type PiSessionProjectionStatus,
  type PiWorkflowSessionProjectionState,
} from "../pi/workflow-session-projection";

export {
  latestCompletedPiHarnessEntries,
  piAgentMessagesFromSessionEntries,
  projectPiWorkflowSession,
};
export type { DraftAgentActivity, DraftAgentMessage, DraftTool, PiWorkflowSessionProjectionState };

export type PiWorkflowLofiSessionProjectionState = PiWorkflowSessionProjectionState;

export type PiSessionProjectionSourceState = {
  state: PiAgentStateSnapshot;
  status: PiSessionProjectionStatus;
  error: PiSessionProjectionError | null;
};

const workflowInstanceProjectionQuery =
  (args: { workflowName: string; sessionId: string }) =>
  (b: LofiFindBuilder<typeof workflowsSchema, "workflow_instance">) =>
    b
      .whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", args.workflowName), eb("instanceId", "=", args.sessionId)),
      )
      .joinMany("workflowSteps", "workflow_step", (step) =>
        step
          .onIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
            eb("instanceRef", "=", eb.parent("id")),
          )
          .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
      )
      .joinMany("workflowStepEmissions", "workflow_step_emission", (emission) =>
        emission
          .onIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
            eb("instanceRef", "=", eb.parent("id")),
          )
          .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", "asc"),
      );

type WorkflowInstanceProjectionRow =
  | LofiQueryFindResult<
      (typeof workflowsSchema)["tables"]["workflow_instance"],
      ReturnType<ReturnType<typeof workflowInstanceProjectionQuery>>
    >[number]
  | null;

type PiHarnessWorkflowInstanceProjectionRow = Omit<
  NonNullable<WorkflowInstanceProjectionRow>,
  "workflowSteps" | "workflowStepEmissions"
> & {
  workflowSteps: Array<
    Omit<NonNullable<WorkflowInstanceProjectionRow>["workflowSteps"][number], "result"> & {
      result: PiHarnessStepResult | null;
    }
  >;
  workflowStepEmissions: Array<
    Omit<NonNullable<WorkflowInstanceProjectionRow>["workflowStepEmissions"][number], "payload"> & {
      payload: PiHarnessEmission | { kind: undefined; control: string } | null;
    }
  >;
};

type SessionProjectionOptions = {
  initialState?: PiAgentStateSnapshot;
  initialCompletedStepKeys?: readonly string[];
};

const projectWorkflowInstanceRow = (
  rawInstance: WorkflowInstanceProjectionRow,
  args: { workflowName: string; sessionId: string } & SessionProjectionOptions,
): PiWorkflowSessionProjectionState => {
  const instance = rawInstance as PiHarnessWorkflowInstanceProjectionRow | null;
  return projectPiWorkflowSession({
    workflowName: args.workflowName,
    sessionId: args.sessionId,
    instance,
    workflowSteps: instance?.workflowSteps ?? [],
    workflowStepEmissions: instance?.workflowStepEmissions ?? [],
    initialState: args.initialState,
    initialCompletedStepKeys: args.initialCompletedStepKeys,
  });
};

export const createSessionProjectionDataStore = (
  runtime: LofiRuntime,
  workflowName: string,
  sessionId: string,
  options: SessionProjectionOptions | undefined = undefined,
) =>
  createLofiQueryStore(
    runtime,
    ({ forSchema }) =>
      forSchema(workflowsSchema).findFirst(
        "workflow_instance",
        workflowInstanceProjectionQuery({ workflowName, sessionId }),
      ),
    {
      initialData: emptyPiWorkflowSessionProjectionState(options?.initialState),
      map: ([instance]): PiWorkflowSessionProjectionState =>
        projectWorkflowInstanceRow(instance, {
          workflowName,
          sessionId,
          initialState: options?.initialState,
          initialCompletedStepKeys: options?.initialCompletedStepKeys,
        }),
    },
  );

export const readPiWorkflowLofiSessionProjection = async (
  runtime: LofiRuntime,
  args: { workflowName: string; sessionId: string },
): Promise<PiSessionProjectionSourceState> => {
  const query = runtime.adapter.createQueryEngine(workflowsSchema);
  const instance = await query.findFirst(
    "workflow_instance",
    workflowInstanceProjectionQuery(args),
  );

  const data = projectWorkflowInstanceRow(instance, args);
  return { state: data.state, status: data.status, error: data.error };
};
