import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  type LofiFindBuilder,
  type LofiQueryFindResult,
  type LofiQueryStore,
  type LofiRuntime,
} from "@fragno-dev/lofi";

import type { PiHarnessStepResult } from "../pi/harness/run-pi-harness-step";
import type { PiAgentStateSnapshot } from "../pi/types";
import {
  createPiWorkflowSessionLiveState,
  emptyPiWorkflowSessionProjectionState,
  overlayPiWorkflowSessionLiveState,
  projectPiWorkflowSession,
  reducePiWorkflowSessionEmission,
  settleCompletedPiWorkflowSessionLiveSteps,
  type PiSessionProjectionError,
  type PiSessionProjectionStatus,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionState,
} from "../pi/workflow-session-projection";

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
      );

type WorkflowInstanceProjectionRow =
  | LofiQueryFindResult<
      (typeof workflowsSchema)["tables"]["workflow_instance"],
      ReturnType<ReturnType<typeof workflowInstanceProjectionQuery>>
    >[number]
  | null;

type PiHarnessWorkflowInstanceProjectionRow = Omit<
  NonNullable<WorkflowInstanceProjectionRow>,
  "workflowSteps"
> & {
  workflowSteps: Array<
    Omit<NonNullable<WorkflowInstanceProjectionRow>["workflowSteps"][number], "result"> & {
      result: PiHarnessStepResult | null;
    }
  >;
};

type SessionProjectionOptions = {
  initialState?: PiAgentStateSnapshot;
  initialCompletedStepKeys?: readonly string[];
};

const projectWorkflowInstanceRow = (
  rawInstance: WorkflowInstanceProjectionRow,
  workflowName: string,
  sessionId: string,
  options: SessionProjectionOptions = {},
): PiWorkflowSessionProjectionState => {
  const instance = rawInstance as PiHarnessWorkflowInstanceProjectionRow | null;
  return projectPiWorkflowSession({
    workflowName,
    sessionId,
    instance,
    workflowSteps: instance?.workflowSteps ?? [],
    ...options,
  });
};

export const createSessionProjectionDataStore = (
  runtime: LofiRuntime,
  workflowName: string,
  sessionId: string,
  options: SessionProjectionOptions = {},
): LofiQueryStore<PiWorkflowSessionProjectionState> =>
  runtime
    .store()
    .retrieve(({ forSchema }) => ({
      instance: forSchema(workflowsSchema).findFirst(
        "workflow_instance",
        workflowInstanceProjectionQuery({ workflowName, sessionId }),
      ),
    }))
    .transformRetrieve(({ instance }) =>
      projectWorkflowInstanceRow(instance, workflowName, sessionId, options),
    )
    .withEphemeral(workflowsSchema, "workflow_step_emission", {
      initialState: createPiWorkflowSessionLiveState,

      // Only reduce emissions belonging to this session and not yet represented by durable steps.
      reduce: (liveState, item, { retrieved: { instance }, durableData }) => {
        if (
          !instance ||
          String(item.instanceRef) !== String(instance.id) ||
          durableData.completedStepKeys.includes(item.stepKey)
        ) {
          return undefined;
        }

        reducePiWorkflowSessionEmission(liveState, {
          stepKey: item.stepKey,
          payload: item.payload as PiWorkflowSessionProjectionEmission["payload"],
          createdAt: item.createdAt,
        });
        return liveState;
      },

      // Completed durable steps supersede their transient drafts after each query refresh.
      reconcile: (liveState, { retrieved: { instance }, durableData }) => {
        settleCompletedPiWorkflowSessionLiveSteps(
          liveState,
          new Set(durableData.completedStepKeys),
        );
        if (instance) {
          const projectedInstance = instance as PiHarnessWorkflowInstanceProjectionRow;
          liveState.activeLiveWork ||= projectedInstance.workflowSteps.some(
            (step) =>
              step.status !== "completed" &&
              !(
                step.status === "waiting" &&
                step.type === "waitForEvent" &&
                step.waitEventType === "command"
              ),
          );
        }
      },

      // Keep durable messages authoritative while layering the current in-flight Pi state on top.
      overlay: (durableData, liveState, { retrieved: { instance } }) => {
        if (!instance) {
          return durableData;
        }
        const projectedInstance = instance as PiHarnessWorkflowInstanceProjectionRow;
        return overlayPiWorkflowSessionLiveState(
          durableData,
          projectedInstance,
          projectedInstance.workflowSteps,
          liveState,
        );
      },
    })
    .withInitialData(emptyPiWorkflowSessionProjectionState(options.initialState));

export const readPiWorkflowLofiSessionProjection = async (
  runtime: LofiRuntime,
  args: { workflowName: string; sessionId: string },
): Promise<PiSessionProjectionSourceState> => {
  const query = runtime.adapter.createQueryEngine(workflowsSchema);
  const instance = await query.findFirst(
    "workflow_instance",
    workflowInstanceProjectionQuery(args),
  );

  const data = projectWorkflowInstanceRow(instance, args.workflowName, args.sessionId);
  return { state: data.state, status: data.status, error: data.error };
};
