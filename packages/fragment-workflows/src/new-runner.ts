// New single-transaction runner scaffold (no task claiming, OCC-only coordination).

import { ConcurrencyConflictError, type IUnitOfWork } from "@fragno-dev/db";
import type { WorkflowsRegistry, WorkflowsRunner } from "./workflow";
import { createWorkflowsBindingsForRunner } from "./bindings-runner";
import { workflowsSchema } from "./schema";
import { isTerminalStatus } from "./runner/status";
import { createRunnerState } from "./runner/state";
import { RunnerStep, RunnerStepSuspended } from "./runner/step";
import type {
  RunnerTaskKind,
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowStepRecord,
  WorkflowsRunnerOptions,
} from "./runner/types";
import {
  isSystemEventActor,
  WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY,
  WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
} from "./system-events";
import type { WorkflowEnqueuedHookPayload } from "./workflow";
import { applyOutcome, applyRunnerMutations, type RunnerTaskOutcome } from "./runner/plan-writes";
import { toError } from "./runner/utils";

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
  workflowBindings: ReturnType<typeof createWorkflowsBindingsForRunner>;
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
 * Sort event history deterministically by id for stable tie-breaking.
 * Bigger picture: keeps event consumption stable across retries and OCC conflicts.
 */
function sortEventsForRunner(events: WorkflowEventRecord[]): WorkflowEventRecord[] {
  return [...events].sort((a, b) => String(a.id).localeCompare(String(b.id)));
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

function shouldPauseInstance(
  instance: WorkflowInstanceRecord,
  pauseEvents: WorkflowEventRecord[],
): boolean {
  return instance.status === "waitingForPause" || instance.pauseRequested || pauseEvents.length > 0;
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
          b.set({ status: "paused", pauseRequested: true, updatedAt: b.now() }).check(),
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
    instanceId: instance.instanceId,
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
    const output = await workflow.run(initialEvent, step, { workflows: ctx.workflowBindings });
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

  const pendingPauseEvents = findPendingPauseEvents(selectionResult.events);

  if (isTerminalStatus(selectionResult.instance.status)) {
    return planConsumePauseEvents(pendingPauseEvents);
  }

  if (selectionResult.instance.status === "paused") {
    return planConsumePauseEvents(pendingPauseEvents);
  }

  if (shouldPauseInstance(selectionResult.instance, pendingPauseEvents)) {
    return planPauseInstance(selectionResult.instance, pendingPauseEvents);
  }

  return await planRunTask(selectionResult, ctx, payload);
}

/**
 * Best-effort recovery: mark the instance errored after a failed mutation phase.
 * Bigger picture: prevents durable hook retries from looping on non-retryable mutation failures.
 */
async function markInstanceErrored(
  fragment: WorkflowsRunnerOptions["fragment"],
  payload: WorkflowEnqueuedHookPayload,
  error: Error,
): Promise<boolean> {
  let updated = false;

  try {
    await fragment.inContext(function () {
      return this.handlerTx({
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
            b.whereIndex("primary", (eb) => eb("id", "=", payload.instanceRef)),
          ),
        )
        .execute();
    });
  } catch {
    return updated;
  }

  return updated;
}

/**
 * Create a single-transaction workflow runner that relies on OCC for coordination.
 * Bigger picture: enforces the one-retrieve/one-mutate tick contract across the runner.
 */
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
    async tick(payload: WorkflowEnqueuedHookPayload & { timestamp: Date }) {
      // Instance-scoped tick: we only fetch data for the payload's instance/run.

      let processed = 0;
      let mutatePhase = false;

      try {
        await runnerOptions.fragment.inContext(function () {
          return this.handlerTx({
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
              const plan = await buildTickPlan(
                selection,
                {
                  workflowsByName,
                  workflowBindings,
                },
                payload,
              );
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
                  b.whereIndex("primary", (eb) => eb("id", "=", payload.instanceRef)),
                )
                .find("workflow_step", (b) =>
                  b
                    .whereIndex("idx_workflow_step_instanceRef_runNumber", (eb) =>
                      eb.and(
                        eb("instanceRef", "=", payload.instanceRef),
                        eb("runNumber", "=", payload.runNumber),
                      ),
                    )
                    .orderByIndex("idx_workflow_step_instanceRef_runNumber", "asc"),
                )
                .find("workflow_event", (b) =>
                  b
                    .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt", (eb) =>
                      eb.and(
                        eb("instanceRef", "=", payload.instanceRef),
                        eb("runNumber", "=", payload.runNumber),
                      ),
                    )
                    .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "asc"),
                ),
            )
            .execute();
        });
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) {
          return 0;
        }
        if (mutatePhase) {
          const error = toError(err);
          await markInstanceErrored(runnerOptions.fragment, payload, error);
          return 0;
        }
        throw err;
      }

      return processed;
    },
  };
}
