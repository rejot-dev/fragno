// New single-transaction runner scaffold (no task claiming, OCC-only coordination).

import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import { BufferedPumpScopeAlreadyOpenError } from "@fragno-dev/db/buffered-pump";

import type { DatabaseRequestContext, IUnitOfWork } from "@fragno-dev/db";

import { applyOutcome, applyRunnerMutations, type RunnerTaskOutcome } from "./runner/plan-writes";
import { createRunnerState, type RunnerState } from "./runner/state";
import { isRunnerStepSuspended, RunnerStep } from "./runner/step";
import {
  workflowStepLivePumpKey,
  type WorkflowStepEmission,
  type WorkflowStepLivePumpRegistry,
} from "./runner/step-live-pump";
import type {
  RunnerTaskKind,
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowStepEmissionRecord,
  WorkflowStepRecord,
} from "./runner/types";
import { toError } from "./runner/utils";
import { workflowsSchema } from "./schema";
import {
  isSystemEventActor,
  WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY,
  WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
} from "./system-events";
import type { WorkflowEnqueuedHookPayload, WorkflowsRegistry } from "./workflow";

function resolveWorkflowsNamespace(uow: IUnitOfWork): string {
  const ns = uow.forSchema(workflowsSchema).namespace;
  return ns ?? workflowsSchema.name;
}

const isTerminalRunnerStatus = (status: string) =>
  status === "complete" || status === "terminated" || status === "errored";

type RunnerTickSelection = {
  instance: WorkflowInstanceRecord | null;
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
  stepEmissions: WorkflowStepEmissionRecord[];
};

type RunnerTickPlan = {
  processed: number;
  operations: Array<(uow: IUnitOfWork) => void>;
};

type RunnerTickContext = {
  workflowsByName: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
  handlerTx: DatabaseRequestContext["handlerTx"];
  busHandlerTx: DatabaseRequestContext["handlerTx"];
  createEpoch: () => string;
  stepEmissions?: WorkflowStepLivePumpRegistry;
  stepEmissionsToPublish: WorkflowStepEmission[];
};

type RunnerTickSelectionResult = {
  instance: WorkflowInstanceRecord;
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
  stepEmissions: WorkflowStepEmissionRecord[];
};

class WorkflowRunnerConcurrencyConflict extends Error {
  constructor(cause: unknown) {
    super("WORKFLOW_RUNNER_CONCURRENCY_CONFLICT");
    this.name = "WorkflowRunnerConcurrencyConflict";
    this.cause = cause;
  }
}

class WorkflowOutputValidationError extends Error {
  readonly workflowName: string;
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(workflowName: string, issues: readonly StandardSchemaV1.Issue[]) {
    super("WORKFLOW_OUTPUT_INVALID");
    this.name = "WorkflowOutputValidationError";
    this.workflowName = workflowName;
    this.issues = issues;
  }
}

async function validateWorkflowOutput(
  workflowName: string,
  outputSchema: StandardSchemaV1 | undefined,
  output: unknown,
) {
  if (!outputSchema) {
    return output;
  }

  const result = await outputSchema["~standard"].validate(output);
  if (result.issues) {
    throw new WorkflowOutputValidationError(workflowName, result.issues);
  }

  return result.value;
}

/**
 * Map hook reasons to runner task kinds.
 * Note: create/event/resume are all treated as normal "run" ticks today. Only explicit
 * wake/retry hooks use the specialized paths in RunnerStep.
 * Bigger picture: keep initial/event/resume ticks on the normal run path, and reserve
 * wake/retry paths for scheduled wakeups and retry hooks.
 */
function isConcurrencyConflictError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConcurrencyConflictError";
}

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

function selectTickInput(selection: RunnerTickSelection): RunnerTickSelectionResult | null {
  const instance = selection.instance;
  if (!instance) {
    return null;
  }
  return {
    instance,
    steps: selection.steps,
    events: selection.events,
    stepEmissions: selection.stepEmissions,
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
  if (isTerminalRunnerStatus(instance.status) || instance.status === "paused") {
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
                instanceId: selectionResult.instance.instanceId,
                instanceRef: String(selectionResult.instance.id),
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
                instanceId: selectionResult.instance.instanceId,
                instanceRef: String(selectionResult.instance.id),
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

function addStepCommittedEmissions(
  uow: IUnitOfWork,
  state: RunnerState,
  publishedStepEmissions: WorkflowStepEmission[],
) {
  const mutatedStepKeys = new Set<string>([
    ...state.mutations.stepCreates.keys(),
    ...state.mutations.stepUpdates.keys(),
  ]);
  const schemaUow = uow.forSchema(workflowsSchema);

  for (const request of state.mutations.stepEmissionCleanupRequests) {
    if (!mutatedStepKeys.has(request.stepKey)) {
      continue;
    }
    const createdAt = new Date();
    const payload = { control: "step-committed" as const, epoch: request.epoch };
    const id = schemaUow.create("workflow_step_emission", {
      instanceRef: request.instanceRef,
      stepKey: request.stepKey,
      epoch: request.epoch,
      sequence: 0,
      actor: "system",
      payload,
      createdAt,
    });
    publishedStepEmissions.push({
      id: id.toString(),
      actor: "system",
      stepKey: request.stepKey,
      epoch: request.epoch,
      sequence: 0,
      payload,
      createdAt,
    });
  }
}

async function planRunTask(
  selection: RunnerTickSelectionResult,
  ctx: RunnerTickContext,
  payload: WorkflowEnqueuedHookPayload & { timestamp: Date },
): Promise<RunnerTickPlan> {
  const events = sortEventsForRunner(selection.events);
  const state = createRunnerState(
    selection.instance,
    selection.steps,
    events,
    selection.stepEmissions,
  );
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
        applyRunnerMutations(uow, state, ctx.workflowsByName);
        addStepCommittedEmissions(uow, state, ctx.stepEmissionsToPublish);
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

  const step = new RunnerStep({
    state,
    taskKind,
    workflowName: instance.workflowName,
    instanceId: instance.instanceId,
    handlerTx: ctx.busHandlerTx,
    createEpoch: ctx.createEpoch,
    stepEmissions: ctx.stepEmissions,
    workflowsByName: ctx.workflowsByName,
  });
  const initialEvent = buildWorkflowEvent(instance, timestamp);

  try {
    const rawOutput = await workflow.run(initialEvent, step);
    const output = await validateWorkflowOutput(
      instance.workflowName,
      workflow.outputSchema,
      rawOutput,
    );
    return { type: "completed", output };
  } catch (err) {
    if (err instanceof BufferedPumpScopeAlreadyOpenError) {
      throw new WorkflowRunnerConcurrencyConflict(err);
    }

    if (isRunnerStepSuspended(err)) {
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
  const selectionResult = selectTickInput(selection);
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
      if (isTerminalRunnerStatus(instance.status)) {
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

  return updated;
}

/**
 * Execute one tick, doing all reads and writes inside a single handlerTx call.
 * Bigger picture: enforces the one-retrieve/one-mutate tick contract across the runner.
 */
export async function runWorkflowsTick(options: {
  handlerTx: DatabaseRequestContext["handlerTx"];
  busHandlerTx?: DatabaseRequestContext["handlerTx"];
  workflows: WorkflowsRegistry;
  payload: WorkflowEnqueuedHookPayload & { timestamp: Date };
  workflowsByName?: Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>;
  createEpoch?: () => string;
  stepEmissions?: WorkflowStepLivePumpRegistry;
}): Promise<number> {
  const workflowsByName =
    options.workflowsByName ??
    new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>(
      Object.values(options.workflows).map((entry) => [entry.name, entry]),
    );

  if (workflowsByName.size === 0) {
    return 0;
  }
  const createEpoch = options.createEpoch ?? (() => crypto.randomUUID());

  // Instance-scoped tick: we only fetch data for the payload's instance/run.
  let processed = 0;
  let mutatePhase = false;
  const stepEmissionsToPublish: WorkflowStepEmission[] = [];

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
            WorkflowStepEmissionRecord[],
          ];
          const [instances, steps, events, stepEmissions] = retrieveResults;
          const selection: RunnerTickSelection = {
            instance: instances[0] ?? null,
            steps: steps ?? [],
            events: events ?? [],
            stepEmissions: stepEmissions ?? [],
          };
          const plan = await buildTickPlan(
            selection,
            {
              workflowsByName,
              handlerTx: options.handlerTx,
              busHandlerTx: options.busHandlerTx ?? options.handlerTx,
              createEpoch,
              stepEmissions: options.stepEmissions,
              stepEmissionsToPublish,
            },
            options.payload,
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
            b.whereIndex("primary", (eb) => eb("id", "=", options.payload.instanceRef)),
          )
          .find("workflow_step", (b) =>
            b
              .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", options.payload.instanceRef),
              )
              .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
          )
          .find("workflow_event", (b) =>
            b
              .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", options.payload.instanceRef),
              )
              .orderByIndex("idx_workflow_event_instanceRef_createdAt", "asc"),
          )
          .find("workflow_step_emission", (b) =>
            b
              .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                eb("instanceRef", "=", options.payload.instanceRef),
              )
              .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", "asc"),
          ),
      )
      .execute();
  } catch (err) {
    if (err instanceof WorkflowRunnerConcurrencyConflict || isConcurrencyConflictError(err)) {
      return 0;
    }
    if (mutatePhase) {
      const error = toError(err);
      await markInstanceErrored(options.handlerTx, options.payload, error);
      return 0;
    }
    throw err;
  }

  const livePump = options.stepEmissions?.get(
    workflowStepLivePumpKey(options.payload.workflowName, options.payload.instanceId),
  );
  await livePump?.publishObserved(stepEmissionsToPublish);

  return processed;
}
