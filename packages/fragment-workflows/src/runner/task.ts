// Task leasing and task/instance transition helpers for the workflow runner.

import { ConcurrencyConflictError } from "@fragno-dev/db";
import { FragnoId } from "@fragno-dev/db/schema";
import type { FragnoRuntime } from "@fragno-dev/core";
import { workflowsSchema } from "../schema";
import type {
  RunHandlerTx,
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowInstanceUpdate,
  WorkflowStepRecord,
  WorkflowTaskRecord,
} from "./types";
import { isPausedStatus, isTerminalStatus } from "./status";
import type { RunnerMutationBuffer, RunnerState } from "./state";
import { updateRemoteState } from "./state";

const requireFragnoId = (value: unknown, label: string): FragnoId => {
  if (value instanceof FragnoId) {
    return value;
  }
  throw new Error(`OCC_REQUIRED_${label}`);
};

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
): Promise<{
  task: WorkflowTaskRecord;
  instance: WorkflowInstanceRecord;
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
} | null> => {
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
              b.whereIndex("primary", (eb) => eb("id", "=", task.id)).join((j) => j.taskInstance()),
            )
            .find("workflow_step", (b) =>
              b.whereIndex("idx_workflow_step_instanceRef_runNumber", (eb) =>
                eb.and(
                  eb("instanceRef", "=", task.instanceRef),
                  eb("runNumber", "=", task.runNumber),
                ),
              ),
            )
            .find("workflow_event", (b) =>
              b
                .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt", (eb) =>
                  eb.and(
                    eb("instanceRef", "=", task.instanceRef),
                    eb("runNumber", "=", task.runNumber),
                  ),
                )
                .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "asc"),
            ),
        )
        .transformRetrieve(([currentTask, steps, events]) => {
          if (!currentTask) {
            return { kind: "noop" as const };
          }

          const instance = (
            currentTask as WorkflowTaskRecord & {
              taskInstance?: WorkflowInstanceRecord | null;
            }
          ).taskInstance;

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
            instance,
            steps,
            events,
          };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (retrieveResult.kind === "delete") {
            const taskId = retrieveResult.taskId;
            requireFragnoId(taskId, "TASK_ID");
            forSchema(workflowsSchema).delete("workflow_task", taskId, (b) => b.check());
            return;
          }

          if (retrieveResult.kind === "claim") {
            const taskId = retrieveResult.task.id;
            forSchema(workflowsSchema).update("workflow_task", taskId, (b) => {
              requireFragnoId(taskId, "TASK_ID");
              const builder = b.set({
                status: "processing",
                lockOwner: ctx.runnerId,
                lockedUntil,
                updatedAt: claimedAt,
              });
              builder.check();
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
    task: {
      ...outcome.task,
      status: "processing",
      lockOwner: ctx.runnerId,
      lockedUntil,
      updatedAt: claimedAt,
    },
    instance: outcome.instance,
    steps: outcome.steps,
    events: outcome.events,
  };
};

export const commitInstanceAndTask = async (
  task: WorkflowTaskRecord,
  instance: WorkflowInstanceRecord,
  status: string,
  update: Partial<WorkflowInstanceUpdate>,
  taskAction:
    | { kind: "delete" }
    | { kind: "schedule"; taskKind: "wake" | "retry" | "run"; runAt: Date },
  mutations: RunnerMutationBuffer,
  ctx: Pick<TaskContext, "runHandlerTx" | "time">,
): Promise<boolean> => {
  const { id: _ignoredInstanceId, ...safeUpdate } = update as WorkflowInstanceRecord;

  try {
    await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(workflowsSchema);
          const instanceId = instance.id;
          uow.update("workflow_instance", instanceId, (b) => {
            requireFragnoId(instanceId, "INSTANCE_ID");
            const builder = b.set({
              ...safeUpdate,
              status,
              updatedAt: ctx.time.now(),
            });
            builder.check();
            return builder;
          });

          if (taskAction.kind === "delete") {
            uow.delete("workflow_task", task.id);
          } else {
            uow.update("workflow_task", task.id, (b) =>
              b.set({
                kind: taskAction.taskKind,
                runAt: taskAction.runAt,
                status: "pending",
                attempts: 0,
                lastError: null,
                lockOwner: null,
                lockedUntil: null,
                updatedAt: ctx.time.now(),
              }),
            );
            const reason =
              taskAction.taskKind === "retry"
                ? "retry"
                : taskAction.taskKind === "wake"
                  ? "wake"
                  : "create";
            uow.triggerHook(
              "onWorkflowEnqueued",
              {
                workflowName: task.workflowName,
                instanceId: task.instanceId,
                reason,
              },
              { processAt: taskAction.runAt },
            );
          }

          for (const [, createData] of mutations.stepCreates) {
            uow.create("workflow_step", createData);
          }

          for (const [, updateEntry] of mutations.stepUpdates) {
            uow.update("workflow_step", updateEntry.id, (b) => {
              requireFragnoId(updateEntry.id, "STEP_ID");
              const builder = b.set(updateEntry.data);
              builder.check();
              return builder;
            });
          }

          for (const [, eventUpdate] of mutations.eventUpdates) {
            uow.update("workflow_event", eventUpdate.id, (b) => {
              requireFragnoId(eventUpdate.id, "EVENT_ID");
              const builder = b.set(eventUpdate.data);
              builder.check();
              return builder;
            });
          }

          for (const log of mutations.logs) {
            uow.create("workflow_log", log);
          }
        })
        .execute(),
    );
    return true;
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      const fallback = await ctx.runHandlerTx((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(
                  eb("workflowName", "=", instance.workflowName),
                  eb("instanceId", "=", instance.instanceId),
                ),
              ),
            ),
          )
          .transformRetrieve(([current]) => {
            if (!current) {
              return { kind: "deleteTask" as const };
            }

            if (current.runNumber !== instance.runNumber) {
              return { kind: "deleteTask" as const };
            }

            if (isTerminalStatus(current.status)) {
              return { kind: "deleteTask" as const };
            }

            if (
              current.pauseRequested ||
              current.status === "waitingForPause" ||
              current.status === "paused"
            ) {
              return { kind: "pause" as const, instance: current };
            }

            return { kind: "noop" as const };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            const uow = forSchema(workflowsSchema);

            if (retrieveResult.kind === "deleteTask") {
              uow.delete("workflow_task", task.id);
              return;
            }

            if (retrieveResult.kind !== "pause") {
              return;
            }

            const instanceId = retrieveResult.instance.id;
            uow.update("workflow_instance", instanceId, (b) => {
              requireFragnoId(instanceId, "INSTANCE_ID");
              const builder = b.set({
                status: "paused",
                pauseRequested: false,
                updatedAt: ctx.time.now(),
              });
              builder.check();
              return builder;
            });

            uow.delete("workflow_task", task.id);
            for (const [, createData] of mutations.stepCreates) {
              uow.create("workflow_step", createData);
            }

            for (const [, updateEntry] of mutations.stepUpdates) {
              uow.update("workflow_step", updateEntry.id, (b) => {
                requireFragnoId(updateEntry.id, "STEP_ID");
                const builder = b.set(updateEntry.data);
                builder.check();
                return builder;
              });
            }

            for (const [, eventUpdate] of mutations.eventUpdates) {
              uow.update("workflow_event", eventUpdate.id, (b) => {
                requireFragnoId(eventUpdate.id, "EVENT_ID");
                const builder = b.set(eventUpdate.data);
                builder.check();
                return builder;
              });
            }

            for (const log of mutations.logs) {
              uow.create("workflow_log", log);
            }
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );

      return fallback.kind === "pause";
    }
    throw err;
  }
};

export const deleteTask = async (
  task: WorkflowTaskRecord,
  ctx: Pick<TaskContext, "runHandlerTx">,
): Promise<void> => {
  try {
    await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .mutate(({ forSchema }) => {
          // Delete without a version check to avoid stale ID conflicts.
          forSchema(workflowsSchema).delete("workflow_task", task.id);
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

export const renewTaskLease = async (
  taskId: WorkflowTaskRecord["id"],
  ctx: TaskContext,
): Promise<{ ok: boolean; instance: WorkflowInstanceRecord | null }> => {
  try {
    const outcome = await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", taskId)).join((j) => j.taskInstance()),
          ),
        )
        .transformRetrieve(([currentTask]) => {
          const instance = currentTask?.taskInstance;
          return { task: currentTask ?? null, instance: instance ?? null };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (!retrieveResult.task) {
            return;
          }
          forSchema(workflowsSchema).update("workflow_task", taskId, (b) =>
            b.set({
              lockedUntil: new Date(ctx.time.now().getTime() + ctx.leaseMs),
              updatedAt: ctx.time.now(),
            }),
          );
        })
        .transform(({ retrieveResult }) => retrieveResult)
        .execute(),
    );
    if (!outcome.task) {
      return { ok: false, instance: outcome.instance };
    }
    return { ok: true, instance: outcome.instance };
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return { ok: false, instance: null };
    }
    throw err;
  }
};

export const startTaskLeaseHeartbeat = (
  task: WorkflowTaskRecord,
  state: RunnerState,
  ctx: TaskContext,
) => {
  // Heartbeat refreshes the lease and snapshots pause/terminal state for in-memory checks.
  const intervalMs = Math.max(Math.floor(ctx.leaseMs / 2), 10);
  let stopped = false;
  let inFlight = false;
  let refreshPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const applyRefreshResult = (renewed: Awaited<ReturnType<typeof renewTaskLease>>) => {
    updateRemoteState(state, renewed.instance);
    if (!renewed.ok) {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };

  const heartbeat = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const renewed = await renewTaskLease(task.id, ctx);
      applyRefreshResult(renewed);
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void heartbeat();
  }, intervalMs);

  state.remoteStateRefresh = async () => {
    if (stopped) {
      return;
    }
    if (refreshPromise) {
      await refreshPromise;
      return;
    }

    refreshPromise = (async () => {
      const renewed = await renewTaskLease(task.id, ctx);
      applyRefreshResult(renewed);
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  };

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};
