// Runner implementation of the WorkflowStep interface.

import { AsyncLocalStorage } from "node:async_hooks";

import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";

import type { DatabaseRequestContext, HandlerTxContext, HooksMap } from "@fragno-dev/db";

import { WorkflowsLogger } from "../debug-log";
import { isSystemEventActor } from "../system-events";
import { parseDurationMs } from "../utils";
import type {
  AnyTxResult,
  WorkflowDuration,
  WorkflowStepEmissionsCleanupHookPayload,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepConsumeTx,
  WorkflowStepEvent,
  WorkflowStepTx,
} from "../workflow";
import { WaitForEventTimeoutError } from "../workflow";
import type { RunnerState, WorkflowStepSnapshot } from "./state";
import { createWorkflowStepLivePump, workflowStepLivePumpKey } from "./step-live-pump";
import type { WorkflowStepLivePump, WorkflowStepLivePumpRegistry } from "./step-live-pump";
import type {
  RunnerTaskKind,
  WorkflowEventRecord,
  WorkflowEventUpdate,
  WorkflowStepCreateDraft,
  WorkflowStepUpdateDraft,
} from "./types";
import { buildNestedStepKey, isMutateOnlyTx, isNonRetryableError, toError } from "./utils";

export type RunnerStepSuspendReason =
  | { type: "sleep"; stepKey: string; delayMs?: number | null; runAt?: Date }
  | {
      type: "waitForEvent";
      stepKey: string;
      eventType: string;
      delayMs?: number | null;
      runAt?: Date;
    }
  | { type: "retry"; stepKey: string; delayMs?: number | null };

export class RunnerStepSuspended extends Error {
  readonly reason: RunnerStepSuspendReason;

  constructor(reason: RunnerStepSuspendReason) {
    super("WORKFLOW_STEP_SUSPENDED");
    this.name = "RunnerStepSuspended";
    this.reason = reason;
  }
}

type RunnerStepOptions = {
  state: RunnerState;
  taskKind: RunnerTaskKind;
  workflowName: string;
  instanceId: string;
  handlerTx: DatabaseRequestContext["handlerTx"];
  createEpoch: () => string;
  stepEmissions?: WorkflowStepLivePumpRegistry;
};

type StepTxQueue = {
  tx: WorkflowStepTx;
  commitSuccess: () => void;
  commitTerminalError: () => void;
};

type StepIdentity = {
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
};

type StepExecutionContext = {
  identity: StepIdentity;
};

const ROOT_STEP_SCOPE = "$root";

/**
 * Build a deterministic step key from type, name, and optional occurrence.
 * Bigger picture: stable step keys are the identity for replayable workflow steps.
 */
function buildStepKey(type: string, name: string, occurrence?: number): string {
  const base = `${type}:${name}`;
  if (occurrence === undefined || occurrence === 0) {
    return base;
  }
  return `${base}#${occurrence}`;
}

/**
 * Normalize timestamps to a Date instance.
 * Bigger picture: step scheduling uses consistent Date objects for comparisons.
 */
function coerceTimestamp(timestamp: Date | number): Date {
  return timestamp instanceof Date ? timestamp : new Date(timestamp);
}

/**
 * Strip delay-only fields from persisted snapshots.
 * Bigger picture: runner state stores the durable fields, not scheduling hints.
 */
function stripDelayFields<T extends Record<string, unknown>>(data: T): T {
  const { nextRetryDelayMs, wakeDelayMs, ...rest } = data as T & {
    nextRetryDelayMs?: unknown;
    wakeDelayMs?: unknown;
  };
  return rest as T;
}

/**
 * Treat both "complete" and "completed" as terminal step statuses.
 * Bigger picture: keeps runner compatible with existing persisted values.
 */
function isCompletedStatus(status?: string | null): boolean {
  return status === "completed" || status === "complete";
}

/**
 * Compute retry delay based on the configured backoff strategy.
 * Bigger picture: centralizes retry timing so scheduling is deterministic.
 */
function computeBackoffDelayMs(
  retries: NonNullable<WorkflowStepConfig["retries"]>,
  attempt: number,
): number {
  const baseDelay = parseDurationMs(retries.delay);
  switch (retries.backoff) {
    case "linear":
      return baseDelay * Math.max(attempt, 1);
    case "exponential":
      return baseDelay * Math.pow(2, Math.max(attempt - 1, 0));
    default:
      return baseDelay;
  }
}

function isSuspended(error: unknown): error is RunnerStepSuspended {
  return error instanceof RunnerStepSuspended;
}

function buildErrorFromSnapshot(snapshot: WorkflowStepSnapshot): Error {
  const error = new Error(snapshot.errorMessage ?? "STEP_FAILED");
  error.name = snapshot.errorName ?? "Error";
  return error;
}

export class RunnerStep implements WorkflowStep {
  #state: RunnerState;
  #taskKind: RunnerTaskKind;
  #stepOccurrences = new Map<string, number>();
  #scopeStorage = new AsyncLocalStorage<StepExecutionContext>();
  #workflowName: string;
  #instanceId: string;
  #handlerTx: DatabaseRequestContext["handlerTx"];
  #createEpoch: () => string;
  #stepEmissions: WorkflowStepLivePumpRegistry;

  constructor(options: RunnerStepOptions) {
    this.#state = options.state;
    this.#taskKind = options.taskKind;
    this.#workflowName = options.workflowName;
    this.#instanceId = options.instanceId;
    this.#handlerTx = options.handlerTx;
    this.#createEpoch = options.createEpoch;
    this.#stepEmissions = options.stepEmissions ?? new BufferedPumpRegistry<WorkflowStepLivePump>();
  }

  #runInStepContext<T>(identity: StepIdentity, execute: () => Promise<T> | T): Promise<T> {
    return this.#scopeStorage.run({ identity }, async () => await execute());
  }

  #createStepIdentity(type: string, name: string): StepIdentity {
    const parent = this.#scopeStorage.getStore()?.identity ?? null;
    const baseKey = buildStepKey(type, name);
    const scopeKey = parent?.stepKey ?? ROOT_STEP_SCOPE;
    const occurrenceKey = `${scopeKey}\u0000${baseKey}`;
    const occurrence = this.#stepOccurrences.get(occurrenceKey) ?? 0;
    this.#stepOccurrences.set(occurrenceKey, occurrence + 1);

    const localStepKey = buildStepKey(type, name, occurrence);
    const identity: StepIdentity = parent
      ? {
          stepKey: buildNestedStepKey(parent.stepKey, localStepKey),
          parentStepKey: parent.stepKey,
          depth: parent.depth + 1,
        }
      : {
          stepKey: localStepKey,
          parentStepKey: null,
          depth: 0,
        };

    return identity;
  }

  #prepareWaitingDraft(
    identity: StepIdentity,
    base: {
      name: string;
      attempts: number;
      maxAttempts: number;
      timeoutMs: number | null;
      errorName?: string | null;
      errorMessage?: string | null;
    },
    reason?: RunnerStepSuspendReason,
  ): WorkflowStepUpdateDraft {
    const draft: WorkflowStepUpdateDraft = {
      name: base.name,
      type: "do",
      status: "waiting",
      attempts: base.attempts,
      maxAttempts: base.maxAttempts,
      timeoutMs: base.timeoutMs,
      parentStepKey: identity.parentStepKey,
      depth: identity.depth,
      result: null,
      errorName: base.errorName ?? null,
      errorMessage: base.errorMessage ?? null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
    };

    if (!reason) {
      return draft;
    }

    if (reason.type === "retry") {
      return {
        ...draft,
        nextRetryDelayMs: reason.delayMs,
      };
    }

    if (reason.type === "sleep") {
      return {
        ...draft,
        ...(reason.runAt ? { wakeAt: reason.runAt } : { wakeDelayMs: reason.delayMs }),
      };
    }

    return {
      ...draft,
      waitEventType: reason.eventType,
      ...(reason.runAt ? { wakeAt: reason.runAt } : { wakeDelayMs: reason.delayMs }),
    };
  }

  async do<T>(name: string, callback: (tx: WorkflowStepTx) => Promise<T> | T): Promise<T>;
  async do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T>;
  async do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | ((tx: WorkflowStepTx) => Promise<T> | T),
    maybeCallback?: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T> {
    const config =
      typeof configOrCallback === "function" ? undefined : (configOrCallback as WorkflowStepConfig);
    const callback =
      typeof configOrCallback === "function"
        ? configOrCallback
        : (maybeCallback as typeof maybeCallback);

    if (!callback) {
      throw new Error("WORKFLOW_STEP_CALLBACK_REQUIRED");
    }

    const identity = this.#createStepIdentity("do", name);
    const { stepKey } = identity;
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (snapshot && isCompletedStatus(snapshot.status)) {
      return snapshot.result as T;
    }

    if (snapshot?.status === "errored") {
      throw buildErrorFromSnapshot(snapshot);
    }

    if (snapshot?.status === "waiting" && snapshot.nextRetryAt && this.#taskKind !== "retry") {
      throw new RunnerStepSuspended({ type: "retry", stepKey, delayMs: null });
    }

    const attempt = (snapshot?.attempts ?? 0) + 1;
    const maxAttempts = config?.retries ? config.retries.limit + 1 : 1;
    const timeoutMs = snapshot?.timeoutMs ?? null;
    const txQueue = this.#createStepTxQueue();
    const pendingEventConsumptions = new Map<string, WorkflowEventRecord>();
    const queueEventConsumption = (event: WorkflowEventRecord, consumedByStepKey: string) => {
      if (consumedByStepKey !== identity.stepKey) {
        return;
      }
      pendingEventConsumptions.set(event.id.toString(), event);
    };
    const isEventConsumptionQueued = (event: WorkflowEventRecord) =>
      Boolean(this.#state.mutations.eventUpdates.get(event.id.toString())?.data.consumedByStepKey);
    const livePumpHandle = this.#stepEmissions.getOrCreate(
      workflowStepLivePumpKey(this.#workflowName, this.#instanceId),
      () =>
        createWorkflowStepLivePump({
          handlerTx: this.#handlerTx,
          workflowName: this.#workflowName,
          instanceId: this.#instanceId,
        }),
    );
    livePumpHandle.pump.setHandlerTx(this.#handlerTx);
    const emissionScope = livePumpHandle.pump.openScope(identity.stepKey, {
      stepKey: identity.stepKey,
      epoch: this.#createEpoch(),
      queueEventConsumption,
      isEventConsumptionQueued,
    });
    const tx = {
      ...txQueue.tx,
      emit: (payload: unknown) => {
        WorkflowsLogger.debug("workflow tx.emit", () => ({
          workflowName: this.#workflowName,
          instanceId: this.#instanceId,
          stepKey: identity.stepKey,
        }));
        emissionScope.enqueueOutgoing(payload);
      },
      onEvent: (
        type: string,
        handler: (event: WorkflowStepEvent<unknown>) => void | Promise<void>,
      ) => {
        const nextCount = (emissionScope.meta.eventTypeCounts.get(type) ?? 0) + 1;
        emissionScope.meta.eventTypeCounts.set(type, nextCount);
        const unsubscribeDelivery = emissionScope.onDelivery((event) => {
          if (event.type === type) {
            return handler(event as WorkflowStepEvent<unknown>);
          }
        });
        return () => {
          unsubscribeDelivery();
          const count = emissionScope.meta.eventTypeCounts.get(type) ?? 0;
          if (count <= 1) {
            emissionScope.meta.eventTypeCounts.delete(type);
          } else {
            emissionScope.meta.eventTypeCounts.set(type, count - 1);
          }
        };
      },
    };

    this.#upsertStep(
      stepKey,
      this.#prepareWaitingDraft(identity, {
        name,
        attempts: attempt,
        maxAttempts,
        timeoutMs,
      }),
    );

    let callbackResult: T | undefined;
    let callbackError: unknown;
    let callbackThrew = false;

    try {
      callbackResult = await this.#runInStepContext(
        identity,
        async () => await callback(tx as WorkflowStepTx),
      );
    } catch (error) {
      callbackThrew = true;
      callbackError = error;
    } finally {
      await emissionScope.flushAndClose();
      await livePumpHandle.close();
      this.#queueStepEmissionCleanup({
        workflowName: this.#workflowName,
        instanceId: this.#instanceId,
        instanceRef: this.#state.instance.id.toString(),
        stepKey: identity.stepKey,
        epoch: emissionScope.meta.epoch,
      });
    }

    if (!callbackThrew) {
      txQueue.commitSuccess();
      for (const event of pendingEventConsumptions.values()) {
        this.#queueEventUpdate(event, { consumedByStepKey: identity.stepKey });
      }
      this.#upsertStep(stepKey, {
        name,
        type: "do",
        status: "completed",
        attempts: attempt,
        maxAttempts,
        timeoutMs,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        result: callbackResult,
        errorName: null,
        errorMessage: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
      });

      return callbackResult as T;
    }

    if (isSuspended(callbackError)) {
      this.#upsertStep(
        stepKey,
        this.#prepareWaitingDraft(
          identity,
          {
            name,
            attempts: attempt,
            maxAttempts,
            timeoutMs,
          },
          callbackError.reason,
        ),
      );
      throw callbackError;
    }

    const error = toError(callbackError);
    const nonRetryable = isNonRetryableError(error);
    const retries = config?.retries;
    const canRetry = !nonRetryable && Boolean(retries && attempt <= retries.limit);

    if (nonRetryable) {
      txQueue.commitTerminalError();
      this.#upsertStep(stepKey, {
        name,
        type: "do",
        status: "errored",
        attempts: attempt,
        maxAttempts,
        timeoutMs,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        errorName: error.name,
        errorMessage: error.message,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
      });
      throw error;
    }

    if (canRetry && retries) {
      const delayMs = computeBackoffDelayMs(retries, attempt);

      this.#upsertStep(
        stepKey,
        this.#prepareWaitingDraft(
          identity,
          {
            name,
            attempts: attempt,
            maxAttempts: retries.limit + 1,
            timeoutMs,
            errorName: error.name,
            errorMessage: error.message,
          },
          { type: "retry", stepKey, delayMs },
        ),
      );

      throw new RunnerStepSuspended({ type: "retry", stepKey, delayMs });
    }

    txQueue.commitTerminalError();
    this.#upsertStep(stepKey, {
      name,
      type: "do",
      status: "errored",
      attempts: attempt,
      maxAttempts,
      timeoutMs,
      parentStepKey: identity.parentStepKey,
      depth: identity.depth,
      errorName: error.name,
      errorMessage: error.message,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
    });

    throw error;
  }

  async sleep(name: string, duration: WorkflowDuration): Promise<void> {
    const identity = this.#createStepIdentity("sleep", name);
    const delayMs = parseDurationMs(duration);
    const { stepKey } = identity;
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (isCompletedStatus(snapshot?.status)) {
      return;
    }

    if (this.#taskKind === "wake" && snapshot?.status === "waiting") {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "completed",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        wakeAt: null,
        waitEventType: null,
        nextRetryAt: null,
      });
      return;
    }

    if (snapshot?.status === "waiting") {
      throw new RunnerStepSuspended({ type: "sleep", stepKey, delayMs: null });
    }

    if (!snapshot) {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        wakeDelayMs: delayMs,
        wakeAt: null,
        waitEventType: null,
        nextRetryAt: null,
      });
    }

    throw new RunnerStepSuspended({ type: "sleep", stepKey, delayMs });
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    const identity = this.#createStepIdentity("sleep", name);
    const { stepKey } = identity;
    const target = coerceTimestamp(timestamp);
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (isCompletedStatus(snapshot?.status)) {
      return;
    }

    if (this.#taskKind === "wake" && snapshot?.status === "waiting") {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "completed",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        wakeAt: null,
        waitEventType: null,
        nextRetryAt: null,
      });
      return;
    }

    if (snapshot?.status === "waiting") {
      throw new RunnerStepSuspended({ type: "sleep", stepKey, delayMs: null });
    }

    if (!snapshot) {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        wakeAt: target,
        waitEventType: null,
        nextRetryAt: null,
      });
    }

    throw new RunnerStepSuspended({ type: "sleep", stepKey, runAt: target });
  }

  async waitForEvent<T = unknown>(
    name: string,
    options: {
      type: string;
      timeout?: WorkflowDuration;
      onConsume?: (
        tx: WorkflowStepConsumeTx,
        event: { type: string; payload: Readonly<T>; timestamp: Date },
      ) => Promise<void> | void;
    },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }> {
    const identity = this.#createStepIdentity("waitForEvent", name);
    const { stepKey } = identity;
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (snapshot && isCompletedStatus(snapshot.status)) {
      return snapshot.result as {
        type: string;
        payload: Readonly<T>;
        timestamp: Date;
      };
    }

    const event = this.#findPendingEvent(options.type, snapshot?.wakeAt ?? null);
    if (event) {
      const result = {
        type: event.type,
        payload: (event.payload ?? null) as Readonly<T>,
        timestamp: event.createdAt,
      };
      const txQueue = this.#createStepTxQueue();
      const livePumpHandle = this.#stepEmissions.getOrCreate(
        workflowStepLivePumpKey(this.#workflowName, this.#instanceId),
        () =>
          createWorkflowStepLivePump({
            handlerTx: this.#handlerTx,
            workflowName: this.#workflowName,
            instanceId: this.#instanceId,
          }),
      );
      livePumpHandle.pump.setHandlerTx(this.#handlerTx);
      const emissionScope = livePumpHandle.pump.openScope(stepKey, {
        stepKey,
        epoch: this.#createEpoch(),
        queueEventConsumption: () => {},
        isEventConsumptionQueued: () => false,
      });

      const consumeTx: WorkflowStepConsumeTx = {
        serviceCalls: txQueue.tx.serviceCalls,
        mutate: txQueue.tx.mutate,
        emit: (payload: unknown) => {
          WorkflowsLogger.debug("workflow waitForEvent tx.emit", () => ({
            workflowName: this.#workflowName,
            instanceId: this.#instanceId,
            stepKey,
          }));
          emissionScope.enqueueOutgoing(payload);
        },
      };

      try {
        await options.onConsume?.(consumeTx, result);
      } catch (error) {
        const err = toError(error);
        this.#upsertStep(stepKey, {
          name,
          type: "waitForEvent",
          status: "errored",
          attempts: snapshot?.attempts ?? 0,
          maxAttempts: snapshot?.maxAttempts ?? 1,
          timeoutMs: snapshot?.timeoutMs ?? null,
          parentStepKey: identity.parentStepKey,
          depth: identity.depth,
          errorName: err.name,
          errorMessage: err.message,
          waitEventType: options.type,
          nextRetryAt: null,
          wakeAt: null,
        });
        throw err;
      } finally {
        await emissionScope.flushAndClose();
        await livePumpHandle.close();
        this.#queueStepEmissionCleanup({
          workflowName: this.#workflowName,
          instanceId: this.#instanceId,
          instanceRef: this.#state.instance.id.toString(),
          stepKey,
          epoch: emissionScope.meta.epoch,
        });
      }

      this.#queueEventUpdate(event, {
        consumedByStepKey: stepKey,
      });
      event.consumedByStepKey = stepKey;
      txQueue.commitSuccess();

      this.#upsertStep(stepKey, {
        name,
        type: "waitForEvent",
        status: "completed",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        result,
        waitEventType: options.type,
        errorName: null,
        errorMessage: null,
        nextRetryAt: null,
        wakeAt: null,
      });

      return result;
    }

    const timeoutMs = options.timeout ? parseDurationMs(options.timeout) : null;

    if (snapshot?.status === "waiting") {
      if (this.#taskKind !== "wake") {
        throw new RunnerStepSuspended({
          type: "waitForEvent",
          stepKey,
          eventType: options.type,
          delayMs: null,
        });
      }

      if (!snapshot.wakeAt) {
        throw new RunnerStepSuspended({
          type: "waitForEvent",
          stepKey,
          eventType: options.type,
          delayMs: null,
        });
      }

      const error = new WaitForEventTimeoutError();
      this.#upsertStep(stepKey, {
        name,
        type: "waitForEvent",
        status: "errored",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        errorName: error.name,
        errorMessage: error.message,
        waitEventType: options.type,
        nextRetryAt: null,
        wakeAt: null,
      });
      throw error;
    }

    if (!snapshot) {
      this.#upsertStep(stepKey, {
        name,
        type: "waitForEvent",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs,
        parentStepKey: identity.parentStepKey,
        depth: identity.depth,
        wakeDelayMs: timeoutMs ?? undefined,
        waitEventType: options.type,
        nextRetryAt: null,
        wakeAt: null,
      });
    }

    throw new RunnerStepSuspended({
      type: "waitForEvent",
      stepKey,
      eventType: options.type,
      delayMs: timeoutMs ?? null,
    });
  }

  #queueStepEmissionCleanup(request: WorkflowStepEmissionsCleanupHookPayload) {
    this.#state.mutations.stepEmissionCleanupRequests.push(request);
  }

  #createStepTxQueue(): StepTxQueue {
    const pendingMutations: Array<(ctx: HandlerTxContext<HooksMap>) => void> = [];
    const pendingServiceCalls: AnyTxResult[] = [];
    const pendingTerminalErrorMutations: Array<(ctx: HandlerTxContext<HooksMap>) => void> = [];

    const tx: WorkflowStepTx = {
      mutate: (fn) => {
        pendingMutations.push(fn);
      },
      onTerminalError: {
        mutate: (fn) => {
          pendingTerminalErrorMutations.push(fn);
        },
      },
      emit: () => {},
      onEvent: () => () => {},
      serviceCalls: (factory) => {
        let calls: readonly AnyTxResult[];
        try {
          calls = factory();
        } catch (error) {
          const err = toError(error);
          if (err.message.startsWith("Cannot add retrieval operation in state")) {
            throw new Error("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
          }
          throw err;
        }
        for (const call of calls) {
          if (!isMutateOnlyTx(call)) {
            throw new Error("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
          }
          pendingServiceCalls.push(call);
        }
      },
    };

    return {
      tx,
      commitSuccess: () => {
        this.#state.mutations.txMutations.push(...pendingMutations);
        this.#state.mutations.txServiceCalls.push(...pendingServiceCalls);
      },
      commitTerminalError: () => {
        this.#state.mutations.txMutations.push(...pendingTerminalErrorMutations);
      },
    };
  }

  #findPendingEvent(type: string, wakeAt?: Date | null): WorkflowEventRecord | undefined {
    return this.#state.events.find(
      (event) =>
        !isSystemEventActor(event.actor) &&
        event.type === type &&
        !event.consumedByStepKey &&
        (!wakeAt || event.createdAt <= wakeAt),
    );
  }

  #queueEventUpdate(event: WorkflowEventRecord, data: WorkflowEventUpdate) {
    const key = event.id.toString();
    const existing = this.#state.mutations.eventUpdates.get(key);
    if (existing) {
      this.#state.mutations.eventUpdates.set(key, {
        id: existing.id,
        data: { ...existing.data, ...data },
      });
      return;
    }

    this.#state.mutations.eventUpdates.set(key, { id: event.id, data });
  }

  #upsertStep(stepKey: string, data: WorkflowStepUpdateDraft) {
    const snapshot = this.#state.stepsByKey.get(stepKey);
    const existingCreate = this.#state.mutations.stepCreates.get(stepKey);

    if (existingCreate) {
      this.#state.mutations.stepCreates.set(stepKey, {
        ...existingCreate,
        ...data,
      });
    } else if (snapshot?.id) {
      const existingUpdate = this.#state.mutations.stepUpdates.get(stepKey);
      if (existingUpdate) {
        this.#state.mutations.stepUpdates.set(stepKey, {
          id: existingUpdate.id,
          data: { ...existingUpdate.data, ...data },
        });
      } else {
        this.#state.mutations.stepUpdates.set(stepKey, {
          id: snapshot.id,
          data,
        });
      }
    } else {
      const createBase = this.#buildStepCreateBase(stepKey, data);
      this.#state.mutations.stepCreates.set(stepKey, {
        ...createBase,
        ...data,
      });
    }

    const nextSnapshot = {
      ...snapshot,
      ...(existingCreate && stripDelayFields(existingCreate)),
      ...stripDelayFields(data),
    } as WorkflowStepSnapshot;

    this.#state.stepsByKey.set(stepKey, nextSnapshot);
  }

  #buildStepCreateBase(stepKey: string, data: WorkflowStepUpdateDraft): WorkflowStepCreateDraft {
    return {
      instanceRef: this.#state.instance.id,
      stepKey,
      parentStepKey: data.parentStepKey ?? null,
      depth: data.depth ?? 0,
      name: data.name ?? stepKey,
      type: data.type ?? "do",
      status: data.status ?? "waiting",
      attempts: data.attempts ?? 0,
      maxAttempts: data.maxAttempts ?? 1,
      timeoutMs: data.timeoutMs ?? null,
      nextRetryAt: data.nextRetryAt ?? null,
      wakeAt: data.wakeAt ?? null,
      waitEventType: data.waitEventType ?? null,
      result: data.result ?? null,
      errorName: data.errorName ?? null,
      errorMessage: data.errorMessage ?? null,
      nextRetryDelayMs: data.nextRetryDelayMs,
      wakeDelayMs: data.wakeDelayMs,
    };
  }
}
