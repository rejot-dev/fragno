// Task leasing and scheduling helpers for the workflow runner.

import { ConcurrencyConflictError } from "@fragno-dev/db";
import { FragnoId } from "@fragno-dev/db/schema";
import type { FragnoRuntime } from "@fragno-dev/core";
import { workflowsSchema } from "../schema";
import type { RunHandlerTx, WorkflowTaskRecord } from "./types";
import { isPausedStatus, isTerminalStatus } from "./status";

type TaskContext = {
  runHandlerTx: RunHandlerTx;
  time: FragnoRuntime["time"];
  runnerId: string;
  leaseMs: number;
};

export const claimTask = async (
  task: WorkflowTaskRecord,
  now: Date,
  ctx: TaskContext,
): Promise<WorkflowTaskRecord | null> => {
  if (!task) {
    return null;
  }

  const claimedAt = ctx.time.now();
  const lockedUntil = new Date(now.getTime() + ctx.leaseMs);

  let outcome;
  try {
    outcome = await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema)
            .findFirst("workflow_task", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
            )
            .findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(
                  eb("workflowName", "=", task.workflowName),
                  eb("instanceId", "=", task.instanceId),
                ),
              ),
            ),
        )
        .transformRetrieve(([currentTask, instance]) => {
          if (!currentTask) {
            return { kind: "noop" as const };
          }

          if (!instance || instance.runNumber !== currentTask.runNumber) {
            return { kind: "delete" as const, taskId: currentTask.id };
          }

          if (isTerminalStatus(instance.status)) {
            return { kind: "delete" as const, taskId: currentTask.id };
          }

          if (isPausedStatus(instance.status)) {
            return { kind: "noop" as const };
          }

          const hasActiveLease = currentTask.lockedUntil ? currentTask.lockedUntil > now : false;
          const canStealProcessing = currentTask.status === "processing" && !hasActiveLease;
          if (currentTask.status !== "pending" && !canStealProcessing) {
            return { kind: "noop" as const };
          }

          if (currentTask.status === "pending" && hasActiveLease) {
            return { kind: "noop" as const };
          }

          return {
            kind: "claim" as const,
            task: currentTask,
          };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (retrieveResult.kind === "delete") {
            const taskId = retrieveResult.taskId;
            forSchema(workflowsSchema).delete("workflow_task", taskId, (b) => {
              if (taskId instanceof FragnoId) {
                return b.check();
              }
              return b;
            });
            return;
          }

          if (retrieveResult.kind === "claim") {
            const taskId = retrieveResult.task.id;
            forSchema(workflowsSchema).update("workflow_task", taskId, (b) => {
              const builder = b.set({
                status: "processing",
                lockOwner: ctx.runnerId,
                lockedUntil,
                updatedAt: claimedAt,
              });
              if (taskId instanceof FragnoId) {
                builder.check();
              }
              return builder;
            });
          }
        })
        .transform(({ retrieveResult }) => retrieveResult)
        .execute(),
    );
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return null;
    }
    throw err;
  }

  if (outcome.kind !== "claim") {
    return null;
  }

  return {
    ...outcome.task,
    status: "processing",
    lockOwner: ctx.runnerId,
    lockedUntil,
    updatedAt: claimedAt,
  };
};

export const scheduleTask = async (
  task: WorkflowTaskRecord,
  kind: "wake" | "retry" | "run",
  runAt: Date,
  ctx: Pick<TaskContext, "runHandlerTx" | "time">,
) => {
  try {
    const outcome = await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
          ),
        )
        .transformRetrieve(([current]) => {
          if (!current) {
            return { kind: "noop" as const };
          }

          if (current.updatedAt.getTime() !== task.updatedAt.getTime()) {
            return { kind: "noop" as const };
          }

          return { kind: "update" as const, id: current.id };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (retrieveResult.kind !== "update") {
            return;
          }
          const currentId = retrieveResult.id;
          forSchema(workflowsSchema).update("workflow_task", currentId, (b) => {
            const builder = b.set({
              kind,
              runAt,
              status: "pending",
              attempts: 0,
              lastError: null,
              lockOwner: null,
              lockedUntil: null,
              updatedAt: ctx.time.now(),
            });
            if (currentId instanceof FragnoId) {
              builder.check();
            }
            return builder;
          });
        })
        .transform(({ retrieveResult }) => retrieveResult)
        .execute(),
    );
    return outcome.kind === "update";
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return false;
    }
    throw err;
  }
};

export const completeTask = async (
  task: WorkflowTaskRecord,
  ctx: Pick<TaskContext, "runHandlerTx">,
) => {
  try {
    await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
          ),
        )
        .transformRetrieve(([current]) => {
          if (!current) {
            return { kind: "noop" as const };
          }
          return { kind: "delete" as const, id: current.id };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (retrieveResult.kind !== "delete") {
            return;
          }
          const currentId = retrieveResult.id;
          forSchema(workflowsSchema).delete("workflow_task", currentId, (b) => {
            if (currentId instanceof FragnoId) {
              return b.check();
            }
            return b;
          });
        })
        .execute(),
    );
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return;
    }
    throw err;
  }
};

export const renewTaskLease = async (taskId: WorkflowTaskRecord["id"], ctx: TaskContext) => {
  try {
    const outcome = await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", taskId)),
          ),
        )
        .transformRetrieve(([current]) => {
          if (!current) {
            return { kind: "noop" as const };
          }

          if (current.status !== "processing" || current.lockOwner !== ctx.runnerId) {
            return { kind: "noop" as const };
          }

          return { kind: "update" as const, id: current.id };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (retrieveResult.kind !== "update") {
            return;
          }
          const currentId = retrieveResult.id;
          forSchema(workflowsSchema).update("workflow_task", currentId, (b) => {
            const builder = b.set({
              lockedUntil: new Date(ctx.time.now().getTime() + ctx.leaseMs),
              updatedAt: ctx.time.now(),
            });
            if (currentId instanceof FragnoId) {
              builder.check();
            }
            return builder;
          });
        })
        .transform(({ retrieveResult }) => retrieveResult)
        .execute(),
    );
    return outcome.kind === "update";
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return false;
    }
    throw err;
  }
};

export const startTaskLeaseHeartbeat = (taskId: WorkflowTaskRecord["id"], ctx: TaskContext) => {
  const intervalMs = Math.max(Math.floor(ctx.leaseMs / 2), 10);
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const heartbeat = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const renewed = await renewTaskLease(taskId, ctx);
      if (!renewed) {
        stopped = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void heartbeat();
  }, intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};
