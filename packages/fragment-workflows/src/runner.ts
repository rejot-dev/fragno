// Workflow runner entry point that wires helpers together and drives task ticks.

import type { RunnerTickOptions, WorkflowsRegistry, WorkflowsRunner } from "./workflow";
import { createWorkflowsBindingsForRunner } from "./bindings-runner";
import { workflowsSchema } from "./schema";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_INSTANCES,
  DEFAULT_MAX_STEPS,
  PRIORITY_BY_KIND,
} from "./runner/constants";
import { runHandlerTx } from "./runner/queries";
import {
  claimTask,
  deleteTask,
  startTaskLeaseHeartbeat,
  commitInstanceAndTask,
} from "./runner/task";
import { processTask } from "./runner/process";
import type { RunHandlerTx, WorkflowsRunnerOptions, WorkflowTaskRecord } from "./runner/types";

// General flow:
// 1) find runnable tasks and expired leases
// 2) claim tasks with a lease
// 3) load instance + workflow, run steps, and persist buffered state
// 4) reschedule or complete tasks based on the outcome
export function createWorkflowsRunner(runnerOptions: WorkflowsRunnerOptions): WorkflowsRunner {
  const workflowsByName = new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>();
  for (const entry of Object.values(runnerOptions.workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const runtime = runnerOptions.runtime;
  const time = runtime.time;
  const runnerId = runnerOptions.runnerId ?? runtime.random.uuid();
  const leaseMs = runnerOptions.leaseMs ?? DEFAULT_LEASE_MS;

  const runHandlerTxForRunner: RunHandlerTx = (callback) =>
    runHandlerTx(runnerOptions.fragment, callback);

  const workflowBindings = createWorkflowsBindingsForRunner({
    workflows: runnerOptions.workflows,
    fragment: runnerOptions.fragment,
  });

  const claimTaskForRunner = (task: WorkflowTaskRecord, now: Date) =>
    claimTask(task, now, { runHandlerTx: runHandlerTxForRunner, time, runnerId, leaseMs });

  const commitInstanceAndTaskForRunner = (
    task: WorkflowTaskRecord,
    instance: Parameters<typeof commitInstanceAndTask>[1],
    status: Parameters<typeof commitInstanceAndTask>[2],
    update: Parameters<typeof commitInstanceAndTask>[3],
    taskAction: Parameters<typeof commitInstanceAndTask>[4],
    mutations: Parameters<typeof commitInstanceAndTask>[5],
  ) =>
    commitInstanceAndTask(task, instance, status, update, taskAction, mutations, {
      runHandlerTx: runHandlerTxForRunner,
      time,
    });

  const deleteTaskForRunner = (task: WorkflowTaskRecord) =>
    deleteTask(task, { runHandlerTx: runHandlerTxForRunner });

  const startTaskLeaseHeartbeatForRunner = (
    task: WorkflowTaskRecord,
    state: Parameters<typeof startTaskLeaseHeartbeat>[1],
  ) =>
    startTaskLeaseHeartbeat(task, state, {
      runHandlerTx: runHandlerTxForRunner,
      time,
      runnerId,
      leaseMs,
    });

  return {
    async tick(tickOptions: RunnerTickOptions = {}) {
      const now = time.now();
      const maxInstances = tickOptions.maxInstances ?? DEFAULT_MAX_INSTANCES;
      const maxSteps = tickOptions.maxSteps ?? DEFAULT_MAX_STEPS;

      const [pendingTasks, expiredProcessingTasks] = await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema)
              .find("workflow_task", (b) =>
                b
                  .whereIndex("idx_workflow_task_status_runAt", (eb) =>
                    eb.and(eb("status", "=", "pending"), eb("runAt", "<=", now)),
                  )
                  .orderByIndex("idx_workflow_task_status_runAt", "asc")
                  .pageSize(maxInstances * 3),
              )
              .find("workflow_task", (b) =>
                b
                  .whereIndex("idx_workflow_task_status_lockedUntil", (eb) =>
                    eb.and(eb("status", "=", "processing"), eb("lockedUntil", "<=", now)),
                  )
                  .orderByIndex("idx_workflow_task_status_lockedUntil", "asc")
                  .pageSize(maxInstances * 3),
              ),
          )
          .transformRetrieve(([pending, expired]) => [pending, expired])
          .execute(),
      );

      const tasksById = new Map<string, WorkflowTaskRecord>();
      for (const task of pendingTasks) {
        tasksById.set(String(task.id), task);
      }
      for (const task of expiredProcessingTasks) {
        tasksById.set(String(task.id), task);
      }
      const tasks = Array.from(tasksById.values());

      tasks.sort((a, b) => {
        const priorityA = PRIORITY_BY_KIND[a.kind] ?? 9;
        const priorityB = PRIORITY_BY_KIND[b.kind] ?? 9;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        return a.runAt.getTime() - b.runAt.getTime();
      });

      let processed = 0;
      for (const task of tasks) {
        if (processed >= maxInstances) {
          break;
        }
        const claimed = await claimTaskForRunner(task, now);
        if (!claimed) {
          continue;
        }
        processed += await processTask(claimed, maxSteps, {
          time,
          workflowsByName,
          workflowBindings,
          commitInstanceAndTask: commitInstanceAndTaskForRunner,
          deleteTask: deleteTaskForRunner,
          startTaskLeaseHeartbeat: startTaskLeaseHeartbeatForRunner,
        });
      }

      return processed;
    },
  };
}
