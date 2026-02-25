// New single-transaction runner scaffold (no task claiming, OCC-only coordination).

import {
  ConcurrencyConflictError,
  type DatabaseRequestContext,
  type IUnitOfWork,
} from "@fragno-dev/db";
import type { WorkflowsRegistry } from "./workflow";
import { workflowsSchema } from "./schema";
import { isTerminalStatus } from "./runner/status";
import { createRunnerState } from "./runner/state";
import { RunnerStep, RunnerStepSuspended } from "./runner/step";
import type {
  RunnerTaskKind,
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowStepRecord,
} from "./runner/types";
import {
  isSystemEventActor,
  WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY,
  WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
} from "./system-events";
import type { WorkflowEnqueuedHookPayload } from "./workflow";
import { applyOutcome, applyRunnerMutations, type RunnerTaskOutcome } from "./runner/plan-writes";
import { toError } from "./runner/utils";

function resolveWorkflowsNamespace(uow: IUnitOfWork): string {
  const ns = uow.forSchema(workflowsSchema).namespace;
  return ns ?? workflowsSchema.name;
}

type RunnerTickSelection = {
  instance: WorkflowInstanceRecord | null;
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
};

type RunnerTickPlan = {
  processed: number;
  operations: Array<(uow: IUnitOfWork) => void>;
};

type RunnerTickContext = {
  workflowsByName: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
};

type RunnerTickSelectionResult = {
  instance: WorkflowInstanceRecord;
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
};

/**
 * Map hook reasons to runner task kinds.
 * Note: create/event/resume are all treated as normal "run" ticks today. Only explicit
 * wake/retry hooks use the specialized paths in RunnerStep.
 * Bigger picture: keep initial/event/resume ticks on the normal run path, and reserve
 * wake/retry paths for scheduled wakeups and retry hooks.
 */
function coerceTaskKind(reason: WorkflowEnqueuedHookPayload["reason"]): RunnerTaskKind {
  if (reason === "retry") {
    return "retry";
  }
  if (reason === "wake") {
    return "wake";
  }
  return "run";
}

/**
 * Sort event history deterministically by createdAt, then id for tie-breaking.
 * Note: the DB already orders by createdAt; we keep a stable in-memory sort to
 * guard against equal timestamps or unordered retrieval paths.
 * Bigger picture: keeps event consumption stable across retries and OCC conflicts.
 */
function sortEventsForRunner(events: WorkflowEventRecord[]): WorkflowEventRecord[] {
  return [...events].sort((a, b) => {
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
    return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Locate pending system pause events for this run.
 * Bigger picture: pause requests are stored as system events to avoid conflicting instance writes.
 */
function findPendingPauseEvents(events: WorkflowEventRecord[]): WorkflowEventRecord[] {
  return events.filter(
    (event) =>
      isSystemEventActor(event.actor) &&
      event.type === WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE &&
      !event.consumedByStepKey,
  );
}

function selectTickInput(
  selection: RunnerTickSelection,
  payload: WorkflowEnqueuedHookPayload,
): RunnerTickSelectionResult | null {
  const instance = selection.instance;
  if (!instance) {
    return null;
  }
  if (instance.runNumber !== payload.runNumber) {
    return null;
  }

  return {
    instance,
    steps: selection.steps,
    events: selection.events,
  };
}

function planConsumePauseEvents(pauseEvents: WorkflowEventRecord[]): RunnerTickPlan {
  if (pauseEvents.length === 0) {
    return { processed: 0, operations: [] };
  }

  return {
    processed: 1,
    operations: [
      (uow) => {
        const schemaUow = uow.forSchema(workflowsSchema);
        for (const event of pauseEvents) {
          schemaUow.update("workflow_event", event.id, (b) =>
            b
              .set({
                consumedByStepKey: WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY,
                deliveredAt: b.now(),
              })
              .check(),
          );
        }
      },
    ],
  };
}

function planPauseInstance(
  instance: WorkflowInstanceRecord,
  pauseEvents: WorkflowEventRecord[],
): RunnerTickPlan {
  return {
    processed: 1,
    operations: [
      (uow) => {
        const schemaUow = uow.forSchema(workflowsSchema);
        schemaUow.update("workflow_instance", instance.id, (b) =>
          b.set({ status: "paused", updatedAt: b.now() }).check(),
        );
        for (const event of pauseEvents) {
          schemaUow.update("workflow_event", event.id, (b) =>
            b
              .set({
                consumedByStepKey: WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY,
                deliveredAt: b.now(),
              })
              .check(),
          );
        }
      },
    ],
  };
}

function planPauseOrTerminal(
  instance: WorkflowInstanceRecord,
  pauseEvents: WorkflowEventRecord[],
): RunnerTickPlan | null {
  if (isTerminalStatus(instance.status) || instance.status === "paused") {
    return planConsumePauseEvents(pauseEvents);
  }

  if (pauseEvents.length > 0) {
    return planPauseInstance(instance, pauseEvents);
  }

  return null;
}

function planEarlyReschedule(
  selectionResult: RunnerTickSelectionResult,
  payload: WorkflowEnqueuedHookPayload & { timestamp: Date },
): RunnerTickPlan | null {
  if (payload.reason === "wake") {
    let wakeAt: Date | null = null;
    for (const step of selectionResult.steps) {
      if (step.status !== "waiting" || !step.wakeAt) {
        continue;
      }
      if (!wakeAt || step.wakeAt < wakeAt) {
        wakeAt = step.wakeAt;
      }
    }

    if (wakeAt && payload.timestamp < wakeAt) {
      return {
        processed: 1,
        operations: [
          (uow) => {
            const ns = resolveWorkflowsNamespace(uow);
            uow.triggerHook(
              ns,
              "onWorkflowEnqueued",
              {
                workflowName: selectionResult.instance.workflowName,
                instanceId: selectionResult.instance.id.toString(),
                instanceRef: String(selectionResult.instance.id),
                runNumber: selectionResult.instance.runNumber,
                reason: "wake",
              },
              { processAt: wakeAt },
            );
          },
        ],
      };
    }
  }

  if (payload.reason === "retry") {
    let nextRetryAt: Date | null = null;
    for (const step of selectionResult.steps) {
      if (step.status !== "waiting" || !step.nextRetryAt) {
        continue;
      }
      if (!nextRetryAt || step.nextRetryAt < nextRetryAt) {
        nextRetryAt = step.nextRetryAt;
      }
    }

    if (nextRetryAt && payload.timestamp < nextRetryAt) {
      return {
        processed: 1,
        operations: [
          (uow) => {
            const ns = resolveWorkflowsNamespace(uow);
            uow.triggerHook(
              ns,
              "onWorkflowEnqueued",
              {
                workflowName: selectionResult.instance.workflowName,
                instanceId: selectionResult.instance.id.toString(),
                instanceRef: String(selectionResult.instance.id),
                runNumber: selectionResult.instance.runNumber,
                reason: "retry",
              },
              { processAt: nextRetryAt },
            );
          },
        ],
      };
    }
  }

  return null;
}

async function planRunTask(
  selection: RunnerTickSelectionResult,
  ctx: RunnerTickContext,
  payload: WorkflowEnqueuedHookPayload & { timestamp: Date },
): Promise<RunnerTickPlan> {
  const events = sortEventsForRunner(selection.events);
  const state = createRunnerState(selection.instance, selection.steps, events);
  const outcome = await runTask(
    selection.instance,
    coerceTaskKind(payload.reason),
    payload.timestamp,
    state,
    ctx,
  );

  return {
    processed: 1,
    operations: [
      (uow) => {
        applyRunnerMutations(uow, state);
        applyOutcome(uow, selection.instance, outcome);
      },
    ],
  };
}

/**
 * Build the workflow event delivered to user code.
 * Bigger picture: runner invokes workflows with a stable event payload derived from instance state.
 */
function buildWorkflowEvent(instance: WorkflowInstanceRecord, timestamp: Date) {
  return {
    payload: instance.params ?? {},
    timestamp,
    instanceId: instance.id.toString(),
  };
}

/**
 * Execute workflow code for a single tick using RunnerStep and return an outcome.
 * Bigger picture: converts user code into buffered mutations plus a scheduling decision.
 */
async function runTask(
  instance: WorkflowInstanceRecord,
  taskKind: RunnerTaskKind,
  timestamp: Date,
  state: ReturnType<typeof createRunnerState>,
  ctx: RunnerTickContext,
): Promise<RunnerTaskOutcome> {
  const workflow = ctx.workflowsByName.get(instance.workflowName);
  if (!workflow) {
    return { type: "errored", error: new Error("WORKFLOW_NOT_FOUND") };
  }

  const step = new RunnerStep({ state, taskKind });
  const initialEvent = buildWorkflowEvent(instance, timestamp);

  try {
    const output = await workflow.run(initialEvent, step);
    return { type: "completed", output };
  } catch (err) {
    if (err instanceof RunnerStepSuspended) {
      return { type: "suspended", reason: err.reason };
    }

    return { type: "errored", error: toError(err) };
  }
}

/**
 * Produce the execution plan for this tick: which mutations to run and how much
 * work was processed, without executing any writes yet.
 *
 * This is async because workflow execution will call user code and await step
 * helpers; the plan must be built before mutations are scheduled.
 *
 * Bigger picture: creates the write plan for a single-transaction tick.
 */
async function buildTickPlan(
  selection: RunnerTickSelection,
  ctx: RunnerTickContext,
  payload: WorkflowEnqueuedHookPayload & { timestamp: Date },
): Promise<RunnerTickPlan> {
  const selectionResult = selectTickInput(selection, payload);
  if (!selectionResult) {
    return { processed: 0, operations: [] };
  }

  // Phase 1: pause/terminal handling (consumes pause events or pauses the instance).
  const pendingPauseEvents = findPendingPauseEvents(selectionResult.events);
  const pausePlan = planPauseOrTerminal(selectionResult.instance, pendingPauseEvents);
  if (pausePlan) {
    return pausePlan;
  }

  // Phase 2: early wake/retry hooks reschedule to the persisted deadline.
  const earlyPlan = planEarlyReschedule(selectionResult, payload);
  if (earlyPlan) {
    return earlyPlan;
  }

  // Phase 3: execute user workflow code and apply buffered mutations/outcome.
  return await planRunTask(selectionResult, ctx, payload);
}

/**
 * Mark the instance errored after a failed mutation phase.
 * Bigger picture: prevents durable hook retries from looping on non-retryable mutation failures.
 */
async function markInstanceErrored(
  handlerTx: DatabaseRequestContext["handlerTx"],
  payload: WorkflowEnqueuedHookPayload,
  error: Error,
): Promise<boolean> {
  let updated = false;
  await handlerTx({
    onAfterRetrieve: (uow, results) => {
      const [instances] = results as [WorkflowInstanceRecord[]];
      const instance = instances[0];
      if (!instance) {
        return;
      }
      if (instance.runNumber !== payload.runNumber) {
        return;
      }
      if (isTerminalStatus(instance.status)) {
        return;
      }

      const schemaUow = uow.forSchema(workflowsSchema);
      schemaUow.update("workflow_instance", instance.id, (b) => {
        const now = b.now();
        return b
          .set({
            status: "errored",
            output: null,
            errorName: error.name,
            errorMessage: error.message,
            updatedAt: now,
            completedAt: now,
            ...(instance.startedAt ? {} : { startedAt: now }),
          })
          .check();
      });
      updated = true;
    },
  })
    .retrieve(({ forSchema }) =>
      forSchema(workflowsSchema).find("workflow_instance", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", payload.instanceId)),
      ),
    )
    .execute();

  return updated;
}

/**
 * Execute one tick, doing all reads and writes inside a single handlerTx call.
 * Bigger picture: enforces the one-retrieve/one-mutate tick contract across the runner.
 */
export async function runWorkflowsTick(options: {
  handlerTx: DatabaseRequestContext["handlerTx"];
  workflows: WorkflowsRegistry;
  payload: WorkflowEnqueuedHookPayload & { timestamp: Date };
  workflowsByName?: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
}): Promise<number> {
  const workflowsByName =
    options.workflowsByName ??
    new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>(
      Object.values(options.workflows).map((entry) => [entry.name, entry]),
    );

  if (workflowsByName.size === 0) {
    return 0;
  }

  // Instance-scoped tick: we only fetch data for the payload's instance/run.
  let processed = 0;
  let mutatePhase = false;

  try {
    await options
      .handlerTx({
        // We must plan mutations after retrieve and before executeMutations. The
        // transform hooks are synchronous and run too late, so we use onAfterRetrieve.
        onAfterRetrieve: async (uow, results) => {
          const retrieveResults = results as [
            WorkflowInstanceRecord[],
            WorkflowStepRecord[],
            WorkflowEventRecord[],
          ];
          const [instances, steps, events] = retrieveResults;
          const selection: RunnerTickSelection = {
            instance: instances[0] ?? null,
            steps: steps ?? [],
            events: events ?? [],
          };
          const plan = await buildTickPlan(selection, { workflowsByName }, options.payload);
          processed = plan.processed;
          for (const operation of plan.operations) {
            operation(uow);
          }
        },
        onBeforeMutate: () => {
          mutatePhase = true;
        },
      })
      .retrieve(({ forSchema }) =>
        forSchema(workflowsSchema)
          .find("workflow_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", options.payload.instanceId)),
          )
          .find("workflow_step", (b) =>
            b
              .whereIndex("idx_workflow_step_instanceRef_runNumber_createdAt", (eb) =>
                eb.and(
                  eb("instanceRef", "=", options.payload.instanceRef),
                  eb("runNumber", "=", options.payload.runNumber),
                ),
              )
              .orderByIndex("idx_workflow_step_instanceRef_runNumber_createdAt", "asc"),
          )
          .find("workflow_event", (b) =>
            b
              .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt", (eb) =>
                eb.and(
                  eb("instanceRef", "=", options.payload.instanceRef),
                  eb("runNumber", "=", options.payload.runNumber),
                ),
              )
              .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "asc"),
          ),
      )
      .execute();
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return 0;
    }
    if (mutatePhase) {
      const error = toError(err);
      await markInstanceErrored(options.handlerTx, options.payload, error);
      return 0;
    }
    throw err;
  }

  return processed;
}
