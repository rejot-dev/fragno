// New single-transaction runner scaffold (no task claiming, OCC-only coordination).

import { ConcurrencyConflictError, type IUnitOfWork } from "@fragno-dev/db";
import type { RunnerTickOptions, WorkflowsRegistry, WorkflowsRunner } from "./workflow";
import { createWorkflowsBindingsForRunner } from "./bindings-runner";
import { workflowsSchema } from "./schema";
import { DEFAULT_MAX_INSTANCES, DEFAULT_MAX_STEPS, PRIORITY_BY_KIND } from "./runner/constants";
import { isPausedStatus, isTerminalStatus } from "./runner/status";
import type {
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowStepRecord,
  WorkflowTaskRecord,
  WorkflowsRunnerOptions,
} from "./runner/types";

type WorkflowTaskWithInstance = WorkflowTaskRecord & {
  taskInstance?: WorkflowInstanceRecord | null;
};

type RunnerTaskEntry = {
  task: WorkflowTaskRecord;
  instance: WorkflowInstanceRecord | null;
  source: "pending" | "expired";
};

type RunnerTickSelection = {
  tasks: RunnerTaskEntry[];
  stepsByInstanceRef: Map<string, WorkflowStepRecord[]>;
  eventsByInstanceRef: Map<string, WorkflowEventRecord[]>;
};

type RunnerTickPlan = {
  processed: number;
  operations: Array<(uow: IUnitOfWork) => void>;
};

type RunnerTickContext = {
  maxInstances: number;
  maxSteps: number;
  workflowsByName: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
  workflowBindings: ReturnType<typeof createWorkflowsBindingsForRunner>;
};

type RunnerTaskHistory = {
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
  missingHistory: boolean;
  truncationRisk: boolean;
};

type RunnerTaskHistoryOptions = {
  maxSteps: number;
  stepPrefetchHitLimit: boolean;
  eventPrefetchHitLimit: boolean;
};

/**
 * Normalize a task record into the runner's task entry shape.
 * Why: downstream planning expects a uniform { task, instance, source } tuple.
 */
function coerceTaskEntry(
  task: WorkflowTaskWithInstance,
  source: RunnerTaskEntry["source"],
): RunnerTaskEntry {
  return {
    task,
    instance: task.taskInstance ?? null,
    source,
  };
}

/**
 * Merge pending/expired tasks, de-dupe by id, and sort by priority then runAt.
 * Why: we need a single deterministic candidate list before applying maxInstances.
 */
function mergeCandidateTasks(
  pending: WorkflowTaskWithInstance[],
  expired: WorkflowTaskWithInstance[],
): RunnerTaskEntry[] {
  const tasksById = new Map<string, RunnerTaskEntry>();
  for (const task of pending) {
    tasksById.set(String(task.id), coerceTaskEntry(task, "pending"));
  }
  for (const task of expired) {
    const key = String(task.id);
    if (!tasksById.has(key)) {
      tasksById.set(key, coerceTaskEntry(task, "expired"));
    }
  }
  const tasks = Array.from(tasksById.values());
  tasks.sort((a, b) => {
    const priorityA = PRIORITY_BY_KIND[a.task.kind] ?? 9;
    const priorityB = PRIORITY_BY_KIND[b.task.kind] ?? 9;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    return a.task.runAt.getTime() - b.task.runAt.getTime();
  });
  return tasks;
}

/**
 * Build the in-memory selection snapshot from handlerTx retrieve results.
 * Why: isolates raw retrieve output from the planning layer and keeps types explicit.
 */
function buildSelectionFromResults(
  results: [
    WorkflowTaskWithInstance[],
    WorkflowTaskWithInstance[],
    WorkflowStepRecord[],
    WorkflowEventRecord[],
  ],
): RunnerTickSelection {
  const [pending, expired, steps, events] = results;
  return {
    tasks: mergeCandidateTasks(pending ?? [], expired ?? []),
    stepsByInstanceRef: indexStepsByInstanceRef(steps ?? []),
    eventsByInstanceRef: indexEventsByInstanceRef(events ?? []),
  };
}

/**
 * Group step records by instanceRef for quick lookup during task processing.
 * Why: enables per-task history assembly without re-scanning the full steps array.
 */
function indexStepsByInstanceRef(steps: WorkflowStepRecord[]): Map<string, WorkflowStepRecord[]> {
  const indexed = new Map<string, WorkflowStepRecord[]>();
  for (const step of steps) {
    const key = String(step.instanceRef);
    const bucket = indexed.get(key);
    if (bucket) {
      bucket.push(step);
    } else {
      indexed.set(key, [step]);
    }
  }
  return indexed;
}

/**
 * Group event records by instanceRef for quick lookup during task processing.
 * Why: enables per-task event filtering without extra queries.
 */
function indexEventsByInstanceRef(
  events: WorkflowEventRecord[],
): Map<string, WorkflowEventRecord[]> {
  const indexed = new Map<string, WorkflowEventRecord[]>();
  for (const event of events) {
    const key = String(event.instanceRef);
    const bucket = indexed.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      indexed.set(key, [event]);
    }
  }
  return indexed;
}

/**
 * Count rows across a Map<instanceRef, rows[]> for budget checks.
 * Why: we need to know if prefetch hit the global cap to flag possible truncation.
 */
function countIndexedRows<T>(indexed: Map<string, T[]>): number {
  let total = 0;
  for (const rows of indexed.values()) {
    total += rows.length;
  }
  return total;
}

/**
 * Sort step history deterministically by createdAt then stepKey.
 * Why: runner state uses a stable ordering for reproducible execution.
 */
function sortStepsForRunner(steps: WorkflowStepRecord[]): WorkflowStepRecord[] {
  return [...steps].sort((a, b) => {
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return String(a.stepKey).localeCompare(String(b.stepKey));
  });
}

/**
 * Sort event history deterministically by createdAt then id.
 * Why: event consumption order must be stable across retries and runners.
 */
function sortEventsForRunner(events: WorkflowEventRecord[]): WorkflowEventRecord[] {
  return [...events].sort((a, b) => {
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Build per-task step/event histories from the shared selection maps.
 * Why: isolates the per-task view from global prefetch state and keeps filtering
 * logic (runNumber, ordering, truncation checks) in one place.
 */
function buildTaskHistory(
  entry: RunnerTaskEntry,
  selection: RunnerTickSelection,
  options: RunnerTaskHistoryOptions,
): RunnerTaskHistory {
  const instanceRef = String(entry.task.instanceRef);
  const runNumber = entry.task.runNumber;
  const rawSteps = selection.stepsByInstanceRef.get(instanceRef) ?? [];
  const rawEvents = selection.eventsByInstanceRef.get(instanceRef) ?? [];

  const steps = sortStepsForRunner(rawSteps.filter((step) => step.runNumber === runNumber));
  const events = sortEventsForRunner(rawEvents.filter((event) => event.runNumber === runNumber));

  // If we hit the global prefetch limits and this instanceRef had no rows,
  // we may have under-fetched its history. Skip to avoid running on partial data.
  const missingHistory =
    (options.stepPrefetchHitLimit && rawSteps.length === 0) ||
    (options.eventPrefetchHitLimit && rawEvents.length === 0);

  // If the per-instance history reaches the maxSteps budget, assume truncation risk.
  const truncationRisk = steps.length >= options.maxSteps || events.length >= options.maxSteps;

  return { steps, events, missingHistory, truncationRisk };
}

/**
 * Produce the execution plan for this tick: which mutations to run and how many
 * tasks were processed, without executing any writes yet.
 *
 * This is async because workflow execution will call user code and await step
 * helpers; the plan must be built before mutations are scheduled.
 */
async function buildTickPlan(
  selection: RunnerTickSelection,
  ctx: RunnerTickContext,
): Promise<RunnerTickPlan> {
  const operations: RunnerTickPlan["operations"] = [];
  let processed = 0;

  const runnable: RunnerTaskEntry[] = [];
  for (const entry of selection.tasks) {
    const instance = entry.instance;
    if (!instance) {
      operations.push((uow) => {
        uow.forSchema(workflowsSchema).delete("workflow_task", entry.task.id);
      });
      continue;
    }
    if (instance.runNumber !== entry.task.runNumber) {
      operations.push((uow) => {
        uow.forSchema(workflowsSchema).delete("workflow_task", entry.task.id);
      });
      continue;
    }
    if (isTerminalStatus(instance.status)) {
      operations.push((uow) => {
        uow.forSchema(workflowsSchema).delete("workflow_task", entry.task.id);
      });
      continue;
    }
    if (isPausedStatus(instance.status)) {
      continue;
    }
    runnable.push(entry);
  }

  const candidates = runnable.slice(0, ctx.maxInstances);
  if (candidates.length === 0) {
    return { processed, operations };
  }

  const stepRowsBudget = ctx.maxInstances * ctx.maxSteps;
  const eventRowsBudget = ctx.maxInstances * ctx.maxSteps;
  const totalStepRows = countIndexedRows(selection.stepsByInstanceRef);
  const totalEventRows = countIndexedRows(selection.eventsByInstanceRef);
  const stepPrefetchHitLimit = totalStepRows >= stepRowsBudget;
  const eventPrefetchHitLimit = totalEventRows >= eventRowsBudget;

  // Hydrate steps/events for each candidate from selection maps.
  const hydrated: Array<{
    entry: RunnerTaskEntry;
    steps: WorkflowStepRecord[];
    events: WorkflowEventRecord[];
  }> = [];
  for (const entry of candidates) {
    const history = buildTaskHistory(entry, selection, {
      maxSteps: ctx.maxSteps,
      stepPrefetchHitLimit,
      eventPrefetchHitLimit,
    });
    if (history.missingHistory || history.truncationRisk) {
      // Skip to avoid running on partial data.
      // Why partial data can happen: step/event prefetch uses a global row cap
      // (maxInstances * maxSteps) without filtering to the selected tasks. If a
      // few instances have large histories, they can consume the cap and starve
      // other instances, leaving their history missing or truncated. Missing
      // step rows can make us think a step never ran, so we re-run it.
      // TODO: tighten prefetch bounds to avoid skipping tasks with large history.
      continue;
    }
    hydrated.push({ entry, steps: history.steps, events: history.events });
  }

  // TODO: run workflow code and collect mutations into operations (single transaction).
  // TODO: schedule next tasks or delete tasks based on outcome.

  return { processed, operations };
}

/** Create a single-transaction workflow runner that relies on OCC for coordination. */
export function createWorkflowsRunner(runnerOptions: WorkflowsRunnerOptions): WorkflowsRunner {
  const workflowsByName = new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>();
  for (const entry of Object.values(runnerOptions.workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const workflowBindings = createWorkflowsBindingsForRunner({
    workflows: runnerOptions.workflows,
    fragment: runnerOptions.fragment,
  });

  return {
    /** Execute one tick, doing all reads and writes inside a single handlerTx call. */
    async tick(tickOptions: RunnerTickOptions = {}) {
      const maxInstances = tickOptions.maxInstances ?? DEFAULT_MAX_INSTANCES;
      const maxSteps = tickOptions.maxSteps ?? DEFAULT_MAX_STEPS;
      // maxInstances is both a processing cap and a prefetch budget:
      // it limits how many tasks we plan to run and how many rows we read.
      // maxSteps only affects prefetch size for step/event history today; it
      // will also cap per-task execution once RunnerStep is wired in.

      let processed = 0;

      try {
        await runnerOptions.fragment.inContext(function () {
          return this.handlerTx({
            // We must plan mutations after retrieve and before executeMutations. The
            // transform hooks are synchronous and run too late, so we use onAfterRetrieve.
            onAfterRetrieve: async (uow, results) => {
              const retrieveResults = results as [
                WorkflowTaskWithInstance[],
                WorkflowTaskWithInstance[],
                WorkflowStepRecord[],
                WorkflowEventRecord[],
              ];
              const selection = buildSelectionFromResults(retrieveResults);
              const plan = await buildTickPlan(selection, {
                maxInstances,
                maxSteps,
                workflowsByName,
                workflowBindings,
              });
              processed = plan.processed;
              for (const operation of plan.operations) {
                operation(uow);
              }
            },
          })
            .retrieve(({ forSchema }) =>
              forSchema(workflowsSchema)
                .find("workflow_task", (b) =>
                  b
                    .whereIndex("idx_workflow_task_status_runAt", (eb) =>
                      eb.and(eb("status", "=", "pending"), eb("runAt", "<=", eb.now())),
                    )
                    .orderByIndex("idx_workflow_task_status_runAt", "asc")
                    .pageSize(maxInstances * 3)
                    .join((j) => j.taskInstance()),
                )
                .find("workflow_task", (b) =>
                  b
                    .whereIndex("idx_workflow_task_status_lockedUntil", (eb) =>
                      eb.and(eb("status", "=", "processing"), eb("lockedUntil", "<=", eb.now())),
                    )
                    .orderByIndex("idx_workflow_task_status_lockedUntil", "asc")
                    .pageSize(maxInstances * 3)
                    .join((j) => j.taskInstance()),
                )
                .find("workflow_step", (b) =>
                  b
                    .whereIndex("idx_workflow_step_instanceRef_runNumber")
                    .orderByIndex("idx_workflow_step_instanceRef_runNumber", "asc")
                    .pageSize(maxInstances * maxSteps),
                )
                .find("workflow_event", (b) =>
                  b
                    .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt")
                    .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "asc")
                    .pageSize(maxInstances * maxSteps),
                ),
            )
            .execute();
        });
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) {
          return 0;
        }
        throw err;
      }

      return processed;
    },
  };
}
