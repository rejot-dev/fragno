// Executes a single claimed task by running workflow code and updating persistence.

import type { FragnoRuntime } from "@fragno-dev/core";
import { workflowsSchema } from "../schema";
import type {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowBindings,
  WorkflowsRegistry,
} from "../workflow";
import type { RunHandlerTx, WorkflowInstanceRecord, WorkflowTaskRecord } from "./types";
import { RunnerStep, WorkflowAbort, WorkflowPause, WorkflowSuspend } from "./step";
import { isPausedStatus, isTerminalStatus } from "./status";

export type ProcessTaskContext = {
  runHandlerTx: RunHandlerTx;
  time: FragnoRuntime["time"];
  workflowsByName: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
  workflowBindings: WorkflowBindings;
  setInstanceStatus: (
    instance: WorkflowInstanceRecord,
    status: string,
    update: Partial<WorkflowInstanceRecord>,
  ) => Promise<boolean>;
  scheduleTask: (
    task: WorkflowTaskRecord,
    kind: "wake" | "retry" | "run",
    runAt: Date,
  ) => Promise<boolean>;
  completeTask: (task: WorkflowTaskRecord) => Promise<void>;
  startTaskLeaseHeartbeat: (taskId: WorkflowTaskRecord["id"]) => () => void;
};

export const processTask = async (
  task: WorkflowTaskRecord,
  maxSteps: number,
  ctx: ProcessTaskContext,
) => {
  if (!task) {
    return 0;
  }

  // Load the instance state to validate the task and hydrate the workflow run.
  const instance = await ctx.runHandlerTx((handlerTx) =>
    handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
          b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb.and(
              eb("workflowName", "=", task.workflowName),
              eb("instanceId", "=", task.instanceId),
            ),
          ),
        ),
      )
      .transformRetrieve(([record]) => record)
      .execute(),
  );

  if (!instance) {
    await ctx.completeTask(task);
    return 0;
  }

  if (instance.runNumber !== task.runNumber) {
    await ctx.completeTask(task);
    return 0;
  }

  if (isTerminalStatus(instance.status)) {
    await ctx.completeTask(task);
    return 0;
  }

  if (isPausedStatus(instance.status)) {
    await ctx.scheduleTask(task, task.kind as "run" | "wake" | "retry", task.runAt);
    return 0;
  }

  const workflowEntry = ctx.workflowsByName.get(instance.workflowName);
  if (!workflowEntry) {
    const updated = await ctx.setInstanceStatus(instance, "errored", {
      errorName: "WorkflowNotFound",
      errorMessage: "WORKFLOW_NOT_FOUND",
      completedAt: ctx.time.now(),
    });
    if (!updated) {
      await ctx.completeTask(task);
      return 0;
    }
    await ctx.completeTask(task);
    return 0;
  }

  if (instance.status !== "running") {
    const updated = await ctx.setInstanceStatus(instance, "running", {
      startedAt: instance.startedAt ?? ctx.time.now(),
    });
    if (!updated) {
      await ctx.completeTask(task);
      return 0;
    }
  }

  const workflow = new workflowEntry.workflow() as WorkflowEntrypoint<unknown, unknown>;
  workflow.workflows = ctx.workflowBindings;

  const event: WorkflowEvent<unknown> = {
    payload: instance.params ?? {},
    timestamp: instance.createdAt,
    instanceId: instance.instanceId,
  };

  const step = new RunnerStep({
    runHandlerTx: ctx.runHandlerTx,
    workflowName: instance.workflowName,
    instanceId: instance.instanceId,
    runNumber: instance.runNumber,
    maxSteps,
    time: ctx.time,
  });

  // Keep the task lease alive while user code is running.
  const stopHeartbeat = ctx.startTaskLeaseHeartbeat(task.id);

  try {
    const output = await workflow.run(event, step);
    const updated = await ctx.setInstanceStatus(instance, "complete", {
      output: output ?? null,
      errorName: null,
      errorMessage: null,
      completedAt: ctx.time.now(),
      pauseRequested: false,
    });
    if (!updated) {
      await ctx.completeTask(task);
      return 0;
    }
    await ctx.completeTask(task);
    return 1;
  } catch (err) {
    if (err instanceof WorkflowAbort) {
      await ctx.completeTask(task);
      return 0;
    }

    if (err instanceof WorkflowPause) {
      const updated = await ctx.setInstanceStatus(instance, "paused", {
        pauseRequested: false,
      });
      if (!updated) {
        await ctx.completeTask(task);
        return 0;
      }
      await ctx.completeTask(task);
      return 1;
    }

    if (err instanceof WorkflowSuspend) {
      if (instance.pauseRequested) {
        const updated = await ctx.setInstanceStatus(instance, "paused", {
          pauseRequested: false,
        });
        if (!updated) {
          await ctx.completeTask(task);
          return 0;
        }
        await ctx.completeTask(task);
        return 1;
      }

      const updated = await ctx.setInstanceStatus(instance, "waiting", {});
      if (!updated) {
        await ctx.completeTask(task);
        return 0;
      }
      await ctx.scheduleTask(task, err.kind, err.runAt);
      return 1;
    }

    const error = err as Error;
    const updated = await ctx.setInstanceStatus(instance, "errored", {
      errorName: error.name ?? "Error",
      errorMessage: error.message ?? "",
      completedAt: ctx.time.now(),
      pauseRequested: false,
    });
    if (!updated) {
      await ctx.completeTask(task);
      return 0;
    }
    await ctx.completeTask(task);
    return 1;
  } finally {
    stopHeartbeat();
  }
};
