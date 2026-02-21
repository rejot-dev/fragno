// Runner implementation of the WorkflowStep interface.

import type { HandlerTxContext, HooksMap } from "@fragno-dev/db";
import type {
  AnyTxResult,
  WorkflowDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepTx,
} from "../workflow";
import { parseDurationMs } from "../utils";
import type { RunnerState, WorkflowStepSnapshot } from "./state";
import type {
  RunnerTaskKind,
  WorkflowEventRecord,
  WorkflowEventUpdate,
  WorkflowStepCreateDraft,
  WorkflowStepUpdateDraft,
} from "./types";
import { isMutateOnlyTx, toError } from "./utils";

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
};

type StepTxQueue = {
  tx: WorkflowStepTx;
  commit: () => void;
};

/**
 * Build a deterministic step key from type and name.
 * Bigger picture: stable step keys are the identity for replayable workflow steps.
 */
function buildStepKey(type: string, name: string): string {
  return `${type}:${name}`;
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
 * Treat both \"complete\" and \"completed\" as terminal step statuses.
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

export class RunnerStep implements WorkflowStep {
  #state: RunnerState;
  #taskKind: RunnerTaskKind;

  constructor(options: RunnerStepOptions) {
    this.#state = options.state;
    this.#taskKind = options.taskKind;
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

    const stepKey = buildStepKey("do", name);
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (snapshot && isCompletedStatus(snapshot.status)) {
      return snapshot.result as T;
    }

    if (snapshot?.status === "errored") {
      const error = new Error(snapshot.errorMessage ?? "STEP_FAILED");
      error.name = snapshot.errorName ?? "Error";
      throw error;
    }

    if (snapshot?.status === "waiting" && snapshot.nextRetryAt) {
      if (this.#taskKind !== "retry") {
        throw new RunnerStepSuspended({ type: "retry", stepKey, delayMs: null });
      }
    }

    const attempt = (snapshot?.attempts ?? 0) + 1;
    const maxAttempts = config?.retries ? config.retries.limit + 1 : 1;
    const timeoutMs = snapshot?.timeoutMs ?? null;

    const txQueue = this.#createStepTxQueue();

    try {
      const result = await callback(txQueue.tx);
      txQueue.commit();

      this.#upsertStep(stepKey, {
        name,
        type: "do",
        status: "completed",
        attempts: attempt,
        maxAttempts,
        timeoutMs,
        result,
        errorName: null,
        errorMessage: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
      });

      return result;
    } catch (err) {
      const error = toError(err);
      const retries = config?.retries;
      const canRetry = retries && attempt <= retries.limit;

      if (canRetry) {
        const delayMs = computeBackoffDelayMs(retries, attempt);

        this.#upsertStep(stepKey, {
          name,
          type: "do",
          status: "waiting",
          attempts: attempt,
          maxAttempts: retries.limit + 1,
          timeoutMs,
          errorName: error.name,
          errorMessage: error.message,
          nextRetryDelayMs: delayMs,
          nextRetryAt: null,
          wakeAt: null,
          waitEventType: null,
        });

        throw new RunnerStepSuspended({ type: "retry", stepKey, delayMs });
      }

      this.#upsertStep(stepKey, {
        name,
        type: "do",
        status: "errored",
        attempts: attempt,
        maxAttempts,
        timeoutMs,
        errorName: error.name,
        errorMessage: error.message,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
      });

      throw error;
    }
  }

  async sleep(name: string, duration: WorkflowDuration): Promise<void> {
    const delayMs = parseDurationMs(duration);
    const stepKey = buildStepKey("sleep", name);
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (isCompletedStatus(snapshot?.status)) {
      return;
    }

    if (this.#taskKind === "wake") {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "completed",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
        wakeAt: null,
        waitEventType: null,
        nextRetryAt: null,
      });
      return;
    }

    if (!snapshot) {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        wakeDelayMs: delayMs,
        wakeAt: null,
        waitEventType: null,
        nextRetryAt: null,
      });
    }

    throw new RunnerStepSuspended({ type: "sleep", stepKey, delayMs });
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    const stepKey = buildStepKey("sleep", name);
    const target = coerceTimestamp(timestamp);
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (isCompletedStatus(snapshot?.status)) {
      return;
    }

    if (this.#taskKind === "wake") {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "completed",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
        wakeAt: null,
        waitEventType: null,
        nextRetryAt: null,
      });
      return;
    }

    if (!snapshot) {
      this.#upsertStep(stepKey, {
        name,
        type: "sleep",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
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
    const stepKey = buildStepKey("waitForEvent", name);
    const snapshot = this.#state.stepsByKey.get(stepKey);

    if (snapshot && isCompletedStatus(snapshot.status)) {
      return snapshot.result as { type: string; payload: Readonly<T>; timestamp: Date };
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

    if (this.#taskKind === "wake") {
      const error = new Error("WAIT_FOR_EVENT_TIMEOUT");
      this.#upsertStep(stepKey, {
        name,
        type: "waitForEvent",
        status: "errored",
        attempts: snapshot?.attempts ?? 0,
        maxAttempts: snapshot?.maxAttempts ?? 1,
        timeoutMs: snapshot?.timeoutMs ?? null,
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

  #createStepTxQueue(): StepTxQueue {
    const pendingMutations: Array<(ctx: HandlerTxContext<HooksMap>) => void> = [];
    const pendingServiceCalls: AnyTxResult[] = [];

    const tx: WorkflowStepTx = {
      mutate: (fn) => {
        pendingMutations.push(fn);
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
      commit: () => {
        this.#state.mutations.txMutations.push(...pendingMutations);
        this.#state.mutations.txServiceCalls.push(...pendingServiceCalls);
      },
    };
  }

  #findPendingEvent(type: string, wakeAt?: Date | null): WorkflowEventRecord | undefined {
    return this.#state.events.find(
      (event) =>
        event.type === type && !event.consumedByStepKey && (!wakeAt || event.createdAt <= wakeAt),
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
        this.#state.mutations.stepUpdates.set(stepKey, { id: snapshot.id, data });
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
      workflowName: this.#state.instance.workflowName,
      instanceId: this.#state.instance.instanceId,
      runNumber: this.#state.instance.runNumber,
      stepKey,
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
