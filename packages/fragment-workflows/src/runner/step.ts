// Runner implementation of the WorkflowStep interface.

import { AsyncLocalStorage } from "node:async_hooks";

import type { HandlerTxContext, HooksMap } from "@fragno-dev/db";

import type { WorkflowLiveStateLease, WorkflowLiveStateStore } from "../live-state";
import { isSystemEventActor } from "../system-events";
import { parseDurationMs } from "../utils";
import type {
  AnyTxResult,
  WorkflowDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepLiveStateController,
  WorkflowStepTx,
} from "../workflow";
import { WaitForEventTimeoutError } from "../workflow";
import type { RunnerState, WorkflowStepSnapshot } from "./state";
import type {
  RunnerTaskKind,
  WorkflowEventRecord,
  WorkflowEventUpdate,
  WorkflowStepCreateDraft,
  WorkflowStepUpdateDraft,
} from "./types";
import { isMutateOnlyTx, isNonRetryableError, toError } from "./utils";

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
  liveState?: WorkflowLiveStateStore;
  workflowName?: string;
  instanceId?: string;
  runNumber?: number;
  timestamp?: Date;
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
const NESTED_STEP_SEPARATOR = ">";

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

function buildNestedStepKey(parentStepKey: string, childStepKey: string): string {
  return `${parentStepKey}${NESTED_STEP_SEPARATOR}${childStepKey}`;
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
  #liveState?: WorkflowLiveStateStore;
  #workflowName?: string;
  #instanceId?: string;
  #runNumber?: number;
  #timestamp?: Date;

  constructor(options: RunnerStepOptions) {
    this.#state = options.state;
    this.#taskKind = options.taskKind;
    this.#liveState = options.liveState;
    this.#workflowName = options.workflowName;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#timestamp = options.timestamp;
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
  async do<T, TLiveState extends Record<string, unknown>>(
    name: string,
    config: WorkflowStepConfig<TLiveState>,
    callback: (tx: WorkflowStepTx<TLiveState>) => Promise<T> | T,
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
    const liveLease = this.#createLiveStateLease(
      identity,
      name,
      config?.liveState as Record<string, unknown> | (() => Record<string, unknown>) | undefined,
    );
    const tx = liveLease ? { ...txQueue.tx, liveState: liveLease.controller } : txQueue.tx;

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
      liveLease?.lease.clear();
    }

    if (!callbackThrew) {
      txQueue.commitSuccess();
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
    options: { type: string; timeout?: WorkflowDuration },
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
      this.#queueEventUpdate(event, {
        consumedByStepKey: stepKey,
      });
      event.consumedByStepKey = stepKey;

      const result = {
        type: event.type,
        payload: (event.payload ?? null) as Readonly<T>,
        timestamp: event.createdAt,
      };

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

  #createLiveStateLease<TState extends Record<string, unknown>>(
    identity: StepIdentity,
    name: string,
    initialLiveState: TState | (() => TState) | undefined,
  ):
    | {
        lease: WorkflowLiveStateLease<TState>;
        controller: WorkflowStepLiveStateController<TState>;
      }
    | undefined {
    if (
      !initialLiveState ||
      !this.#liveState ||
      !this.#workflowName ||
      !this.#instanceId ||
      this.#runNumber === undefined
    ) {
      return undefined;
    }

    let state = typeof initialLiveState === "function" ? initialLiveState() : initialLiveState;
    const snapshot = () => ({
      workflowName: this.#workflowName!,
      instanceId: this.#instanceId!,
      runNumber: this.#runNumber!,
      stepKey: identity.stepKey,
      parentStepKey: identity.parentStepKey,
      depth: identity.depth,
      name,
      capturedAt: this.#timestamp ?? new Date(),
      state,
    });
    const lease = this.#liveState.begin(snapshot());
    return {
      lease,
      controller: {
        getState: () => state,
        setState: (patch) => {
          state = {
            ...state,
            ...(typeof patch === "function" ? patch(state) : patch),
          };
          lease.set(snapshot());
        },
      },
    };
  }

  #createStepTxQueue(): StepTxQueue {
    const pendingMutations: Array<(ctx: HandlerTxContext<HooksMap>) => void> = [];
    const pendingServiceCalls: AnyTxResult[] = [];
    const pendingTerminalErrorMutations: Array<(ctx: HandlerTxContext<HooksMap>) => void> = [];

    const tx: WorkflowStepTx = {
      liveState: undefined,
      mutate: (fn) => {
        pendingMutations.push(fn);
      },
      onTerminalError: {
        mutate: (fn) => {
          pendingTerminalErrorMutations.push(fn);
        },
      },
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
      runNumber: this.#state.instance.runNumber,
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
