// Workflow step executor with in-memory state, retries, and waiting semantics.

import type {
  WorkflowDuration,
  WorkflowLogger,
  WorkflowLogLevel,
  WorkflowLogOptions,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepTx,
} from "../workflow";
import { NonRetryableError } from "../workflow";
import type { WorkflowLogCreate, WorkflowRunAt, WorkflowStepRecord } from "./types";
import {
  computeRetryDelayMs,
  isUniqueConstraintError,
  normalizeRetryConfig,
  normalizeWaitTimeoutMs,
} from "./utils";
import { parseDurationMs } from "../utils";
import { isTerminalStatus } from "./status";
import {
  clearStepMutationBuffer,
  getStepSnapshot,
  getStepMutationBuffer,
  getStepMutationBufferIfExists,
  queueEventUpdate,
  queueLogCreate,
  queueStepCreate,
  queueStepUpdate,
  resetMutations,
} from "./state";
import type { RunnerState } from "./state";

class WorkflowSuspend extends Error {
  constructor(
    readonly kind: "wake" | "retry",
    readonly runAt: WorkflowRunAt,
  ) {
    super("WORKFLOW_SUSPEND");
  }
}

class WorkflowPause extends Error {
  constructor() {
    super("WORKFLOW_PAUSE");
  }
}

class WorkflowAbort extends Error {
  constructor() {
    super("WORKFLOW_ABORT");
  }
}

class WaitForEventTimeoutError extends Error {
  constructor() {
    super("WAIT_FOR_EVENT_TIMEOUT");
    this.name = "WaitForEventTimeoutError";
  }
}

const coerceDate = (timestamp: Date | number) =>
  timestamp instanceof Date ? timestamp : new Date(timestamp);

const coerceEventTimestamp = (timestamp: unknown) => {
  if (timestamp instanceof Date) {
    return timestamp;
  }
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    return new Date(timestamp);
  }
  return new Date(NaN);
};

export class RunnerStep implements WorkflowStep {
  log: WorkflowLogger;
  #state: RunnerState;
  #workflowName: string;
  #instanceRef: WorkflowStepRecord["instanceRef"];
  #instanceId: string;
  #runNumber: number;
  #inFlightSteps = new Set<string>();
  #maxSteps: number;
  #stepCount = 0;
  #taskRunAt: Date;
  #flushStepBoundary:
    | ((
        mutations: RunnerState["mutations"],
        stepMutations: ReturnType<typeof getStepMutationBufferIfExists>,
      ) => Promise<boolean>)
    | null = null;
  #activeStepKey: string | null = null;
  #activeAttempt: number | null = null;

  constructor(options: {
    state: RunnerState;
    workflowName: string;
    instanceRef: WorkflowStepRecord["instanceRef"];
    instanceId: string;
    runNumber: number;
    maxSteps: number;
    taskRunAt: Date;
    flushStepBoundary: (
      mutations: RunnerState["mutations"],
      stepMutations: ReturnType<typeof getStepMutationBufferIfExists>,
    ) => Promise<boolean>;
  }) {
    this.#state = options.state;
    this.#workflowName = options.workflowName;
    this.#instanceRef = options.instanceRef;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#maxSteps = options.maxSteps;
    this.#taskRunAt = options.taskRunAt;
    this.#flushStepBoundary = options.flushStepBoundary;
    this.log = {
      debug: (message, data, opts) => this.#writeLog("debug", message, data, opts),
      info: (message, data, opts) => this.#writeLog("info", message, data, opts),
      warn: (message, data, opts) => this.#writeLog("warn", message, data, opts),
      error: (message, data, opts) => this.#writeLog("error", message, data, opts),
    };
  }

  async do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | ((tx: WorkflowStepTx) => Promise<T> | T),
    maybeCallback?: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T> {
    const { config, callback } =
      typeof configOrCallback === "function"
        ? { config: undefined, callback: configOrCallback }
        : { config: configOrCallback, callback: maybeCallback };

    if (!callback) {
      throw new Error("Missing step callback");
    }

    this.#beginStep(name);

    try {
      const existing = getStepSnapshot(this.#state, name);
      if (existing && existing.type !== "do") {
        throw new Error("STEP_TYPE_MISMATCH");
      }

      if (existing?.status === "completed") {
        clearStepMutationBuffer(this.#state, name);
        await this.#throwIfPauseRequested();
        return existing.result as T;
      }

      if (existing?.status === "waiting" && existing.nextRetryAt) {
        const remainingMs = existing.nextRetryAt.getTime() - this.#taskRunAt.getTime();
        if (remainingMs > 0) {
          clearStepMutationBuffer(this.#state, name);
          await this.#throwIfPauseRequested();
          throw new WorkflowSuspend("retry", { delayMs: remainingMs });
        }
      }

      if (existing?.status === "errored") {
        clearStepMutationBuffer(this.#state, name);
        const err = new Error(existing.errorMessage ?? "STEP_FAILED");
        err.name = existing.errorName ?? "Error";
        throw err;
      }

      const { maxAttempts, delayMs, backoff } = normalizeRetryConfig(config);
      const timeoutMs = config?.timeout ? parseDurationMs(config.timeout) : null;

      if (existing && (existing.attempts ?? 0) >= maxAttempts) {
        if (existing.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "errored",
            errorName: "StepMaxAttemptsExceeded",
            errorMessage: "STEP_MAX_ATTEMPTS_EXCEEDED",
          });
        }
        throw new NonRetryableError("STEP_MAX_ATTEMPTS_EXCEEDED", "StepMaxAttemptsExceeded");
      }

      const attempt = (existing?.attempts ?? 0) + 1;

      const startUpdate = {
        status: "running",
        attempts: attempt,
        maxAttempts,
        timeoutMs,
        nextRetryDelayMs: null,
        errorName: null,
        errorMessage: null,
      };

      if (existing?.id) {
        queueStepUpdate(this.#state, name, existing.id, startUpdate);
      } else {
        queueStepCreate(this.#state, name, {
          instanceRef: this.#instanceRef,
          workflowName: this.#workflowName,
          instanceId: this.#instanceId,
          runNumber: this.#runNumber,
          stepKey: name,
          name,
          type: "do",
          status: "running",
          attempts: attempt,
          maxAttempts,
          timeoutMs,
          nextRetryAt: null,
          wakeAt: null,
          waitEventType: null,
          result: null,
          errorName: null,
          errorMessage: null,
        });
      }

      clearStepMutationBuffer(this.#state, name);
      this.#setStepContext(name, attempt);

      try {
        const result = await this.#runWithTimeout(() => callback(this.#createStepTx()), timeoutMs);
        const completionUpdate = {
          status: "completed",
          result,
        };
        const snapshot = getStepSnapshot(this.#state, name);
        queueStepUpdate(this.#state, name, snapshot?.id, completionUpdate);
        await this.#flushBoundary();
        await this.#throwIfPauseRequested();
        return result;
      } catch (err) {
        if (
          err instanceof WorkflowSuspend ||
          err instanceof WorkflowPause ||
          err instanceof WorkflowAbort
        ) {
          throw err;
        }

        const error = err as Error;
        const nonRetryable = error instanceof NonRetryableError;
        const shouldRetry = !nonRetryable && attempt < maxAttempts;

        const nextRetryDelayMs = shouldRetry
          ? computeRetryDelayMs(attempt, delayMs, backoff)
          : null;

        const failureUpdate = {
          status: shouldRetry ? "waiting" : "errored",
          errorName: error.name,
          errorMessage: error.message,
          nextRetryDelayMs,
        };
        const snapshot = getStepSnapshot(this.#state, name);
        queueStepUpdate(this.#state, name, snapshot?.id, failureUpdate);

        if (shouldRetry && nextRetryDelayMs !== null) {
          clearStepMutationBuffer(this.#state, name);
          await this.#throwIfPauseRequested();
          throw new WorkflowSuspend("retry", { delayMs: nextRetryDelayMs });
        }

        clearStepMutationBuffer(this.#state, name);
        throw error;
      }
    } finally {
      this.#endStep(name);
    }
  }

  #createStepTx(): WorkflowStepTx {
    return {
      serviceCalls: (factory) => {
        if (!this.#activeStepKey || this.#activeAttempt === null) {
          throw new Error("STEP_TX_UNAVAILABLE");
        }
        const buffer = getStepMutationBuffer(this.#state, this.#activeStepKey, this.#activeAttempt);
        buffer.serviceCalls.push(factory);
      },
      mutate: (fn) => {
        if (!this.#activeStepKey || this.#activeAttempt === null) {
          throw new Error("STEP_TX_UNAVAILABLE");
        }
        const buffer = getStepMutationBuffer(this.#state, this.#activeStepKey, this.#activeAttempt);
        buffer.mutations.push(fn);
      },
    };
  }

  async sleep(name: string, duration: WorkflowDuration): Promise<void> {
    return this.#sleepUntil(name, { delayMs: parseDurationMs(duration) });
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    return this.#sleepUntil(name, coerceDate(timestamp));
  }

  async waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }> {
    this.#beginStep(name);
    this.#setStepContext(name, null);

    try {
      const existing = getStepSnapshot(this.#state, name);
      if (existing && existing.type !== "waitForEvent") {
        throw new Error("STEP_TYPE_MISMATCH");
      }

      if (existing?.status === "completed" && existing.result) {
        await this.#throwIfPauseRequested();
        const result = existing.result as {
          type: string;
          payload: Readonly<T>;
          timestamp: Date | string | number;
        };
        return { ...result, timestamp: coerceEventTimestamp(result.timestamp) };
      }

      if (existing?.status === "errored") {
        throw new WaitForEventTimeoutError();
      }

      const timeoutMs = existing?.timeoutMs ?? normalizeWaitTimeoutMs(options.timeout);
      const wakeAt = existing?.wakeAt ?? null;

      const event = this.#state.events.find((candidate) => {
        if (candidate.type !== options.type || candidate.deliveredAt !== null) {
          return false;
        }
        const createdAt = coerceEventTimestamp(candidate.createdAt);
        if (Number.isNaN(createdAt.getTime())) {
          return false;
        }
        return wakeAt ? createdAt <= wakeAt : true;
      });

      if (event) {
        const eventTimestamp = coerceEventTimestamp(event.createdAt);
        const result = {
          type: event.type,
          payload: event.payload as Readonly<T>,
          timestamp: eventTimestamp,
        };

        queueEventUpdate(this.#state, event, {
          deliveredAt: this.#taskRunAt,
          consumedByStepKey: name,
        });

        if (existing?.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "completed",
            result,
          });
        } else {
          queueStepCreate(this.#state, name, {
            instanceRef: this.#instanceRef,
            workflowName: this.#workflowName,
            instanceId: this.#instanceId,
            runNumber: this.#runNumber,
            stepKey: name,
            name,
            type: "waitForEvent",
            status: "completed",
            attempts: 1,
            maxAttempts: 1,
            timeoutMs: normalizeWaitTimeoutMs(options.timeout),
            nextRetryAt: null,
            wakeAt: null,
            waitEventType: options.type,
            result,
            errorName: null,
            errorMessage: null,
          });
        }

        await this.#flushBoundary();
        await this.#throwIfPauseRequested();
        return { ...result, timestamp: coerceEventTimestamp(result.timestamp) };
      }

      if (wakeAt && this.#taskRunAt >= wakeAt) {
        if (existing?.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "errored",
            errorName: "WaitForEventTimeoutError",
            errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
          });
        }
        throw new WaitForEventTimeoutError();
      }

      if (existing?.id) {
        queueStepUpdate(this.#state, name, existing.id, {
          status: "waiting",
          ...(wakeAt ? { wakeAt } : { wakeDelayMs: timeoutMs }),
          waitEventType: options.type,
          timeoutMs,
        });
      } else {
        queueStepCreate(this.#state, name, {
          instanceRef: this.#instanceRef,
          workflowName: this.#workflowName,
          instanceId: this.#instanceId,
          runNumber: this.#runNumber,
          stepKey: name,
          name,
          type: "waitForEvent",
          status: "waiting",
          attempts: 0,
          maxAttempts: 1,
          timeoutMs,
          nextRetryAt: null,
          wakeAt: wakeAt ?? null,
          ...(wakeAt ? {} : { wakeDelayMs: timeoutMs }),
          waitEventType: options.type,
          result: null,
          errorName: null,
          errorMessage: null,
        });
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", wakeAt ?? { delayMs: timeoutMs });
    } finally {
      this.#endStep(name);
    }
  }

  async #sleepUntil(name: string, schedule: WorkflowRunAt): Promise<void> {
    this.#beginStep(name);
    this.#setStepContext(name, null);

    try {
      const existing = getStepSnapshot(this.#state, name);
      if (existing && existing.type !== "sleep") {
        throw new Error("STEP_TYPE_MISMATCH");
      }

      if (existing?.status === "completed") {
        await this.#throwIfPauseRequested();
        return;
      }

      if (existing?.wakeAt && existing.wakeAt <= this.#taskRunAt) {
        if (existing.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "completed",
          });
        }
        await this.#flushBoundary();
        await this.#throwIfPauseRequested();
        return;
      }

      const wakeAt = existing?.wakeAt ?? (schedule instanceof Date ? schedule : null);
      const wakeDelayMs =
        existing?.wakeAt || schedule instanceof Date ? undefined : schedule.delayMs;

      if (existing?.id) {
        queueStepUpdate(this.#state, name, existing.id, {
          status: "waiting",
          ...(wakeAt ? { wakeAt } : { wakeDelayMs }),
        });
      } else {
        queueStepCreate(this.#state, name, {
          instanceRef: this.#instanceRef,
          workflowName: this.#workflowName,
          instanceId: this.#instanceId,
          runNumber: this.#runNumber,
          stepKey: name,
          name,
          type: "sleep",
          status: "waiting",
          attempts: 0,
          maxAttempts: 1,
          timeoutMs: null,
          nextRetryAt: null,
          wakeAt: wakeAt ?? null,
          ...(wakeAt ? {} : { wakeDelayMs }),
          waitEventType: null,
          result: null,
          errorName: null,
          errorMessage: null,
        });
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", wakeAt ?? { delayMs: wakeDelayMs ?? 0 });
    } finally {
      this.#endStep(name);
    }
  }

  #beginStep(stepKey: string) {
    if (this.#inFlightSteps.has(stepKey)) {
      throw new Error("DUPLICATE_STEP_KEY");
    }
    this.#inFlightSteps.add(stepKey);
    this.#stepCount += 1;
    if (this.#stepCount > this.#maxSteps) {
      throw new Error("MAX_STEPS_EXCEEDED");
    }
  }

  #endStep(stepKey: string) {
    this.#inFlightSteps.delete(stepKey);
    if (this.#activeStepKey === stepKey) {
      this.#activeStepKey = null;
      this.#activeAttempt = null;
    }
  }

  #setStepContext(stepKey: string, attempt: number | null) {
    this.#activeStepKey = stepKey;
    this.#activeAttempt = attempt;
  }

  async #throwIfPauseRequested() {
    // Use the latest heartbeat snapshot to avoid extra database roundtrips per step.
    if (this.#state.remoteStateRefresh) {
      await this.#state.remoteStateRefresh();
    }

    const remote = this.#state.remoteState;
    if (remote.missing) {
      return;
    }

    if (remote.runNumber !== this.#runNumber || isTerminalStatus(remote.status)) {
      throw new WorkflowAbort();
    }

    if (
      remote.pauseRequested ||
      remote.status === "waitingForPause" ||
      remote.status === "paused"
    ) {
      throw new WorkflowPause();
    }
  }

  async #runWithTimeout<T>(callback: () => Promise<T> | T, timeoutMs: number | null): Promise<T> {
    if (!timeoutMs) {
      return await callback();
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        Promise.resolve().then(callback),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("STEP_TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async #writeLog(
    level: WorkflowLogLevel,
    message: string,
    data?: unknown,
    options?: WorkflowLogOptions,
  ): Promise<void> {
    const log: WorkflowLogCreate = {
      instanceRef: this.#instanceRef,
      workflowName: this.#workflowName,
      instanceId: this.#instanceId,
      runNumber: this.#runNumber,
      stepKey: this.#activeStepKey,
      attempt: this.#activeAttempt,
      level,
      category: options?.category ?? "workflow",
      message,
      data: data ?? null,
    };

    queueLogCreate(this.#state, log);
  }

  async #flushBoundary(): Promise<void> {
    if (!this.#flushStepBoundary) {
      return;
    }

    const stepMutations =
      this.#activeStepKey && this.#activeAttempt !== null
        ? getStepMutationBufferIfExists(this.#state, this.#activeStepKey, this.#activeAttempt)
        : null;
    const hasStepMutations =
      !!stepMutations &&
      (stepMutations.serviceCalls.length > 0 || stepMutations.mutations.length > 0);

    const { stepCreates, stepUpdates, eventUpdates, logs } = this.#state.mutations;
    if (
      !hasStepMutations &&
      stepCreates.size === 0 &&
      stepUpdates.size === 0 &&
      eventUpdates.size === 0 &&
      logs.length === 0
    ) {
      return;
    }

    try {
      const ok = await this.#flushStepBoundary(this.#state.mutations, stepMutations);
      if (!ok) {
        throw new WorkflowAbort();
      }
    } catch (err) {
      if (err instanceof WorkflowAbort) {
        throw err;
      }
      if (isUniqueConstraintError(err)) {
        throw new NonRetryableError("STEP_UNIQUE_CONSTRAINT_VIOLATION", "UniqueConstraintError");
      }
      throw err;
    }

    resetMutations(this.#state);
    if (this.#activeStepKey) {
      clearStepMutationBuffer(this.#state, this.#activeStepKey);
    }
  }
}

export { WorkflowSuspend, WorkflowPause, WorkflowAbort };
