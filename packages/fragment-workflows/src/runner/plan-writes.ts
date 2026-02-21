// Helpers for translating runner state into UOW mutations.

import type { HandlerTxContext, HooksMap, IUnitOfWork, TypedUnitOfWork } from "@fragno-dev/db";
import { workflowsSchema } from "../schema";
import type { AnyTxResult } from "../workflow";
import type { RunnerState } from "./state";
import type {
  WorkflowInstanceRecord,
  WorkflowStepCreate,
  WorkflowStepCreateDraft,
  WorkflowStepUpdate,
  WorkflowStepUpdateDraft,
} from "./types";
import type { RunnerStepSuspended } from "./step";
import { isMutateOnlyTx } from "./utils";

export type RunnerTaskOutcome =
  | { type: "completed"; output: unknown }
  | { type: "suspended"; reason: RunnerStepSuspended["reason"] }
  | { type: "errored"; error: Error };

/**
 * Remove undefined keys from mutation payloads to avoid clobbering columns.
 * Bigger picture: keeps buffered updates minimal and preserves existing DB values.
 */
function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const cleaned: Record<string, unknown> = { ...value };
  for (const [key, entry] of Object.entries(cleaned)) {
    if (entry === undefined) {
      delete cleaned[key];
    }
  }
  return cleaned as T;
}

/**
 * Resolve delay-based timestamps using DB time helpers.
 * Bigger picture: runner scheduling must be anchored to database time, not server time.
 */
function resolveStepDraftTimes(
  uow: TypedUnitOfWork<typeof workflowsSchema>,
  draft: WorkflowStepCreateDraft,
): WorkflowStepCreate;
function resolveStepDraftTimes(
  uow: TypedUnitOfWork<typeof workflowsSchema>,
  draft: WorkflowStepUpdateDraft,
): WorkflowStepUpdate;
function resolveStepDraftTimes(
  uow: TypedUnitOfWork<typeof workflowsSchema>,
  draft: WorkflowStepCreateDraft | WorkflowStepUpdateDraft,
): WorkflowStepCreate | WorkflowStepUpdate {
  const nextRetryAt =
    draft.nextRetryDelayMs !== undefined && draft.nextRetryDelayMs !== null
      ? uow.now().plus({ ms: draft.nextRetryDelayMs })
      : draft.nextRetryAt;
  const wakeAt =
    draft.wakeDelayMs !== undefined && draft.wakeDelayMs !== null
      ? uow.now().plus({ ms: draft.wakeDelayMs })
      : draft.wakeAt;

  const { nextRetryDelayMs, wakeDelayMs, ...rest } = draft;

  return stripUndefined({
    ...rest,
    nextRetryAt,
    wakeAt,
  });
}

/**
 * Run queued WorkflowStepTx mutate callbacks against a handler context.
 * Bigger picture: lets user workflow code schedule arbitrary mutations in the same tick.
 */
function applyTxMutations(
  uow: IUnitOfWork,
  mutations: Array<(ctx: HandlerTxContext<HooksMap>) => void>,
) {
  if (mutations.length === 0) {
    return;
  }

  const ctx: HandlerTxContext<HooksMap> = {
    forSchema: uow.forSchema.bind(uow),
    idempotencyKey: uow.idempotencyKey,
    currentAttempt: 0,
  };

  for (const mutate of mutations) {
    mutate(ctx);
  }
}

/**
 * Apply mutate-only TxResult service calls using the current UOW.
 * Bigger picture: allows composed service mutations while preserving single-retrieve semantics.
 */
function applyServiceCalls(uow: IUnitOfWork, calls: AnyTxResult[]) {
  for (const call of calls) {
    if (!isMutateOnlyTx(call)) {
      throw new Error("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
    }
    const { callbacks, schema } = call._internal;
    if (!callbacks.mutate) {
      continue;
    }
    if (!schema) {
      throw new Error("WORKFLOW_STEP_TX_SCHEMA_REQUIRED");
    }
    callbacks.mutate({
      uow: uow.forSchema(schema),
      retrieveResult: [],
      serviceIntermediateResult: [],
    });
  }
}

/**
 * Translate buffered runner mutations into concrete UOW operations.
 * Bigger picture: this is the only place we touch the database for step/event/log changes.
 */
export function applyRunnerMutations(uow: IUnitOfWork, state: RunnerState) {
  const schemaUow = uow.forSchema(workflowsSchema);

  for (const draft of state.mutations.stepCreates.values()) {
    const data = resolveStepDraftTimes(schemaUow, draft);
    schemaUow.create("workflow_step", data);
  }

  for (const entry of state.mutations.stepUpdates.values()) {
    const data = resolveStepDraftTimes(schemaUow, entry.data);
    schemaUow.update("workflow_step", entry.id, (b) =>
      b.set({ ...data, updatedAt: b.now() }).check(),
    );
  }

  for (const entry of state.mutations.eventUpdates.values()) {
    const data = { ...entry.data };
    schemaUow.update("workflow_event", entry.id, (b) => {
      const update = stripUndefined(data);
      const withDeliveredAt =
        data.consumedByStepKey && data.deliveredAt === undefined
          ? { ...update, deliveredAt: b.now() }
          : update;
      return b.set(withDeliveredAt).check();
    });
  }

  applyTxMutations(uow, state.mutations.txMutations);
  applyServiceCalls(uow, state.mutations.txServiceCalls);
}

/**
 * Apply the per-tick outcome: update instance status and schedule follow-up hooks.
 * Bigger picture: drives the workflow state machine forward inside the same tick transaction.
 */
export function applyOutcome(
  uow: IUnitOfWork,
  instance: WorkflowInstanceRecord,
  outcome: RunnerTaskOutcome,
) {
  const schemaUow = uow.forSchema(workflowsSchema);

  schemaUow.update("workflow_instance", instance.id, (b) => {
    const baseUpdate = {
      updatedAt: b.now(),
      ...(instance.startedAt ? {} : { startedAt: b.now() }),
    };

    const outcomeUpdate =
      outcome.type === "completed"
        ? {
            status: "complete",
            output: outcome.output ?? null,
            errorName: null,
            errorMessage: null,
            completedAt: b.now(),
          }
        : outcome.type === "errored"
          ? {
              status: "errored",
              output: null,
              errorName: outcome.error.name,
              errorMessage: outcome.error.message,
              completedAt: b.now(),
            }
          : outcome.type === "suspended"
            ? { status: "waiting" }
            : {};

    return b.set({ ...baseUpdate, ...outcomeUpdate }).check();
  });

  if (outcome.type !== "suspended") {
    return;
  }

  const { reason } = outcome;
  const runAt =
    reason.type === "sleep" || reason.type === "waitForEvent" ? (reason.runAt ?? null) : null;
  const delayMs = reason.delayMs ?? null;

  if (runAt === null && delayMs === null) {
    return;
  }

  const kind = reason.type === "retry" ? "retry" : "wake";
  const processAt = runAt ?? schemaUow.now().plus({ ms: delayMs ?? 0 });

  uow.triggerHook(
    "onWorkflowEnqueued",
    {
      workflowName: instance.workflowName,
      instanceId: instance.instanceId,
      instanceRef: String(instance.id),
      runNumber: instance.runNumber,
      reason: kind,
    },
    { processAt },
  );
}
