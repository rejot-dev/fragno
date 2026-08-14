import { workflowsSchema } from "@fragno-dev/workflows/schema";
import { selectCanonicalWorkflowStepEmissions } from "@fragno-dev/workflows/step-emission-control";

import {
  type LofiFindBuilder,
  type LofiQueryFindResult,
  type LofiQueryStore,
  type LofiRuntime,
} from "@fragno-dev/lofi";

import type { PiAgentStateSnapshot, PiWorkflowStatus } from "../pi/types";
import {
  createPiWorkflowSessionEmissionReducer,
  isPiWorkflowStepActive,
  projectPiWorkflowSessionLiveOverlay,
  reducePiWorkflowSessionEmission,
  settleCompletedPiWorkflowSessionLiveSteps,
} from "../pi/workflow-session-live-projection";
import {
  createLoadingPiWorkflowSessionProjection,
  projectPiWorkflowSession,
  type PiSessionProjectionStatus,
  type PiWorkflowSessionProjectionBaseline,
  type PiWorkflowSessionProjectionEmission,
  type PiWorkflowSessionProjectionState,
} from "../pi/workflow-session-projection";

export type PiSessionProjectionSourceState = {
  state: PiAgentStateSnapshot;
  status: PiSessionProjectionStatus;
  error: Error | null;
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
  "status" | "workflowSteps"
> & {
  status: PiWorkflowStatus;
  workflowSteps: NonNullable<WorkflowInstanceProjectionRow>["workflowSteps"];
};

type SessionProjectionOptions = {
  baseline?: PiWorkflowSessionProjectionBaseline;
};

type PiWorkflowLofiEmission = {
  actor: string;
  stepKey: string;
  executionId: string;
  epoch: string;
  sequence: number;
  payload: unknown;
  createdAt: Date;
};

type PiWorkflowLofiLiveState = {
  reducer: ReturnType<typeof createPiWorkflowSessionEmissionReducer>;
  emissions: PiWorkflowLofiEmission[];
};

const createPiWorkflowLofiLiveState = (): PiWorkflowLofiLiveState => ({
  reducer: createPiWorkflowSessionEmissionReducer(),
  emissions: [],
});

const rebuildCanonicalPiWorkflowLiveProjection = (
  state: PiWorkflowLofiLiveState,
  workflowSteps: readonly PiHarnessWorkflowInstanceProjectionRow["workflowSteps"][number][],
  completedStepKeys: readonly string[],
): void => {
  const completedStepKeySet = new Set(completedStepKeys);
  const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
    steps: workflowSteps,
    emissions: state.emissions,
  });
  const reducer = createPiWorkflowSessionEmissionReducer();

  for (const emission of canonicalEmissions) {
    if (completedStepKeySet.has(emission.stepKey)) {
      continue;
    }
    reducePiWorkflowSessionEmission(reducer, {
      stepKey: emission.stepKey,
      executionId: emission.executionId,
      epoch: emission.epoch,
      sequence: emission.sequence,
      payload: emission.payload as PiWorkflowSessionProjectionEmission["payload"],
      createdAt: emission.createdAt,
    });
  }

  state.reducer = reducer;
};

const projectWorkflowInstanceRow = (
  rawInstance: WorkflowInstanceProjectionRow,
  workflowName: string,
  sessionId: string,
  options: SessionProjectionOptions,
): PiWorkflowSessionProjectionState => {
  const instance = rawInstance as PiHarnessWorkflowInstanceProjectionRow | null;
  return projectPiWorkflowSession({
    workflowName,
    sessionId,
    instance,
    workflowSteps: instance?.workflowSteps ?? [],
    baseline: options.baseline,
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
      initialState: () => createPiWorkflowLofiLiveState(),

      // Buffer raw emissions so durable winner changes can rebuild the live projection.
      reduce: (liveState, item, { retrieved: { instance }, durableData }) => {
        if (!instance || String(item.instanceRef) !== String(instance.id)) {
          return undefined;
        }

        const projectedInstance = instance as PiHarnessWorkflowInstanceProjectionRow;
        const emission = item as typeof item & { actor: string };
        const bufferedEmission = {
          actor: emission.actor,
          stepKey: emission.stepKey,
          executionId: emission.executionId,
          epoch: emission.epoch,
          sequence: emission.sequence,
          payload: emission.payload,
          createdAt: emission.createdAt,
        };
        liveState.emissions.push(bufferedEmission);

        const [canonicalEmission] = selectCanonicalWorkflowStepEmissions({
          steps: projectedInstance.workflowSteps,
          emissions: [bufferedEmission],
        });
        if (
          canonicalEmission &&
          !new Set(durableData.completedStepKeys).has(canonicalEmission.stepKey)
        ) {
          reducePiWorkflowSessionEmission(liveState.reducer, {
            stepKey: canonicalEmission.stepKey,
            executionId: canonicalEmission.executionId,
            epoch: canonicalEmission.epoch,
            sequence: canonicalEmission.sequence,
            payload: canonicalEmission.payload as PiWorkflowSessionProjectionEmission["payload"],
            createdAt: canonicalEmission.createdAt,
          });
        }
        return liveState;
      },

      // Durable step winners can invalidate every transient emission from a losing execution.
      reconcile: (liveState, { retrieved: { instance }, durableData }) => {
        if (!instance) {
          return;
        }
        const projectedInstance = instance as PiHarnessWorkflowInstanceProjectionRow;
        rebuildCanonicalPiWorkflowLiveProjection(
          liveState,
          projectedInstance.workflowSteps,
          durableData.completedStepKeys,
        );
        settleCompletedPiWorkflowSessionLiveSteps(
          liveState.reducer.live,
          new Set(durableData.completedStepKeys),
        );
        liveState.reducer.live.activeLiveWork ||=
          projectedInstance.workflowSteps.some(isPiWorkflowStepActive);
      },

      // Keep durable messages authoritative while layering the current in-flight Pi state on top.
      overlay: (durableData, liveState, { retrieved: { instance } }) => {
        if (!instance || durableData.status !== "ready") {
          return durableData;
        }
        const projectedInstance = instance as PiHarnessWorkflowInstanceProjectionRow;
        return {
          ...durableData,
          ...projectPiWorkflowSessionLiveOverlay({
            contextMessages: durableData.contextMessages,
            timelineMessages: durableData.timelineMessages,
            instanceStatus: projectedInstance.status,
            workflowSteps: projectedInstance.workflowSteps,
            live: liveState.reducer.live,
          }),
        };
      },
    })
    .withInitialData(
      createLoadingPiWorkflowSessionProjection({
        workflowName,
        sessionId,
        baseline: options.baseline,
      }),
    );

export const readPiWorkflowLofiSessionProjection = async (
  runtime: LofiRuntime,
  args: {
    workflowName: string;
    sessionId: string;
  },
): Promise<PiSessionProjectionSourceState> => {
  const query = runtime.adapter.createQueryEngine(workflowsSchema);
  const instance = await query.findFirst(
    "workflow_instance",
    workflowInstanceProjectionQuery(args),
  );

  const data = projectWorkflowInstanceRow(instance, args.workflowName, args.sessionId, {});
  return {
    state: { messages: data.contextMessages },
    status: data.status,
    error: data.error,
  };
};
