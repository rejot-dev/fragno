// Executes a single claimed task by running workflow code and updating persistence.

import type { FragnoRuntime } from "@fragno-dev/core";
import type {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowBindings,
  WorkflowsRegistry,
} from "../workflow";
import type {
  WorkflowInstanceRecord,
  WorkflowInstanceUpdate,
  WorkflowEventRecord,
  WorkflowStepRecord,
  WorkflowTaskRecord,
} from "./types";
import { RunnerStep, WorkflowAbort, WorkflowPause, WorkflowSuspend } from "./step";
import type { RunnerMutationBuffer, RunnerState } from "./state";
import { createRunnerState } from "./state";

export type ProcessTaskContext = {
  time: FragnoRuntime["time"];
  workflowsByName: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
  workflowBindings: WorkflowBindings;
  commitInstanceAndTask: (
    task: WorkflowTaskRecord,
    instance: WorkflowInstanceRecord,
    status: string,
    update: Partial<WorkflowInstanceUpdate>,
    taskAction:
      | { kind: "delete" }
      | { kind: "schedule"; taskKind: "wake" | "retry" | "run"; runAt: Date },
    mutations: RunnerMutationBuffer,
  ) => Promise<boolean>;
  deleteTask: (task: WorkflowTaskRecord) => Promise<void>;
  startTaskLeaseHeartbeat: (task: WorkflowTaskRecord, state: RunnerState) => () => void;
};

export const processTask = async (
  claimed: {
    task: WorkflowTaskRecord;
    instance: WorkflowInstanceRecord;
    steps: WorkflowStepRecord[];
    events: WorkflowEventRecord[];
  },
  maxSteps: number,
  ctx: ProcessTaskContext,
) => {
  const { task, instance, steps, events } = claimed;

  const state = createRunnerState(instance, steps, events);
  const startUpdate = instance.startedAt ? {} : { startedAt: ctx.time.now() };

  const workflowEntry = ctx.workflowsByName.get(instance.workflowName);
  if (!workflowEntry) {
    const updated = await ctx.commitInstanceAndTask(
      task,
      instance,
      "errored",
      {
        ...startUpdate,
        errorName: "WorkflowNotFound",
        errorMessage: "WORKFLOW_NOT_FOUND",
        completedAt: ctx.time.now(),
      },
      { kind: "delete" },
      state.mutations,
    );
    if (!updated) {
      await ctx.deleteTask(task);
      return 0;
    }
    return 0;
  }

  const workflow = new workflowEntry.workflow() as WorkflowEntrypoint<unknown, unknown>;
  workflow.workflows = ctx.workflowBindings;

  const event: WorkflowEvent<unknown> = {
    payload: instance.params ?? {},
    timestamp: instance.createdAt,
    instanceId: instance.instanceId,
  };

  const step = new RunnerStep({
    state,
    workflowName: instance.workflowName,
    instanceRef: task.instanceRef,
    instanceId: instance.instanceId,
    runNumber: instance.runNumber,
    maxSteps,
    time: ctx.time,
  });

  // Keep the task lease alive while user code is running.
  const stopHeartbeat = ctx.startTaskLeaseHeartbeat(task, state);

  try {
    const output = await workflow.run(event, step);
    const updated = await ctx.commitInstanceAndTask(
      task,
      instance,
      "complete",
      {
        ...startUpdate,
        output: output ?? null,
        errorName: null,
        errorMessage: null,
        completedAt: ctx.time.now(),
        pauseRequested: false,
      },
      { kind: "delete" },
      state.mutations,
    );
    if (!updated) {
      await ctx.deleteTask(task);
      return 0;
    }
    return 1;
  } catch (err) {
    if (err instanceof WorkflowAbort) {
      await ctx.deleteTask(task);
      return 0;
    }

    if (err instanceof WorkflowPause) {
      const updated = await ctx.commitInstanceAndTask(
        task,
        instance,
        "paused",
        {
          ...startUpdate,
          pauseRequested: false,
        },
        { kind: "delete" },
        state.mutations,
      );
      if (!updated) {
        await ctx.deleteTask(task);
        return 0;
      }
      return 1;
    }

    if (err instanceof WorkflowSuspend) {
      if (instance.pauseRequested) {
        const updated = await ctx.commitInstanceAndTask(
          task,
          instance,
          "paused",
          {
            ...startUpdate,
            pauseRequested: false,
          },
          { kind: "delete" },
          state.mutations,
        );
        if (!updated) {
          await ctx.deleteTask(task);
          return 0;
        }
        return 1;
      }

      const updated = await ctx.commitInstanceAndTask(
        task,
        instance,
        "waiting",
        { ...startUpdate },
        { kind: "schedule", taskKind: err.kind, runAt: err.runAt },
        state.mutations,
      );
      if (!updated) {
        await ctx.deleteTask(task);
        return 0;
      }
      return 1;
    }

    const error = err as Error;
    const updated = await ctx.commitInstanceAndTask(
      task,
      instance,
      "errored",
      {
        ...startUpdate,
        errorName: error.name ?? "Error",
        errorMessage: error.message ?? "",
        completedAt: ctx.time.now(),
        pauseRequested: false,
      },
      { kind: "delete" },
      state.mutations,
    );
    if (!updated) {
      await ctx.deleteTask(task);
      return 0;
    }
    return 1;
  } finally {
    stopHeartbeat();
  }
};
