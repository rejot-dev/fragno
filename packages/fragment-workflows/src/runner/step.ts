// Workflow step executor with in-memory state, retries, and waiting semantics.

import type { FragnoRuntime } from "@fragno-dev/core";
import type {
  WorkflowDuration,
  WorkflowLogger,
  WorkflowLogLevel,
  WorkflowLogOptions,
  WorkflowStep,
  WorkflowStepConfig,
} from "../workflow";
import { NonRetryableError } from "../workflow";
import type { WorkflowLogCreate, WorkflowStepRecord } from "./types";
import { computeRetryDelayMs, normalizeRetryConfig, normalizeWaitTimeoutMs } from "./utils";
import { parseDurationMs } from "../utils";
import { isTerminalStatus } from "./status";
import type { RunnerState } from "./state";
import {
  getStepSnapshot,
  queueEventUpdate,
  queueLogCreate,
  queueStepCreate,
  queueStepUpdate,
} from "./state";

class WorkflowSuspend extends Error {
  constructor(
    readonly kind: "wake" | "retry",
    readonly runAt: Date,
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
  #time: FragnoRuntime["time"];
  #getDbNow: () => Promise<Date>;
  #activeStepKey: string | null = null;
  #activeAttempt: number | null = null;

  constructor(options: {
    state: RunnerState;
    workflowName: string;
    instanceRef: WorkflowStepRecord["instanceRef"];
    instanceId: string;
    runNumber: number;
    maxSteps: number;
    time: FragnoRuntime["time"];
    getDbNow: () => Promise<Date>;
  }) {
    this.#state = options.state;
    this.#workflowName = options.workflowName;
    this.#instanceRef = options.instanceRef;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#maxSteps = options.maxSteps;
    this.#time = options.time;
    this.#getDbNow = options.getDbNow;
    this.log = {
      debug: (message, data, opts) => this.#writeLog("debug", message, data, opts),
      info: (message, data, opts) => this.#writeLog("info", message, data, opts),
      warn: (message, data, opts) => this.#writeLog("warn", message, data, opts),
      error: (message, data, opts) => this.#writeLog("error", message, data, opts),
    };
  }

  async do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | (() => Promise<T> | T),
    maybeCallback?: () => Promise<T> | T,
  ): Promise<T> {
    const { config, callback } =
      typeof configOrCallback === "function"
        ? { config: undefined, callback: configOrCallback }
        : { config: configOrCallback, callback: maybeCallback };

    if (!callback) {
      throw new Error("Missing step callback");
    }

    this.#beginStep(name);
    const now = this.#time.now();
    const dbNow = await this.#getDbNow();

    try {
      const existing = getStepSnapshot(this.#state, name);
      if (existing && existing.type !== "do") {
        throw new Error("STEP_TYPE_MISMATCH");
      }

      if (existing?.status === "completed") {
        await this.#throwIfPauseRequested();
        return existing.result as T;
      }

      if (existing?.status === "waiting" && existing.nextRetryAt) {
        if (existing.nextRetryAt > dbNow) {
          await this.#throwIfPauseRequested();
          throw new WorkflowSuspend("retry", existing.nextRetryAt);
        }
      }

      if (existing?.status === "errored") {
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
            updatedAt: now,
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
        nextRetryAt: null,
        errorName: null,
        errorMessage: null,
        updatedAt: now,
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
          createdAt: now,
          updatedAt: now,
        });
      }

      this.#setStepContext(name, attempt);

      try {
        const result = await this.#runWithTimeout(callback, timeoutMs);
        const completionUpdate = {
          status: "completed",
          result,
          updatedAt: this.#time.now(),
        };
        const snapshot = getStepSnapshot(this.#state, name);
        queueStepUpdate(this.#state, name, snapshot?.id, completionUpdate);
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

        let nextRetryAt: Date | null = null;
        if (shouldRetry) {
          let retryBase: Date;
          try {
            retryBase = await this.#getDbNow();
          } catch {
            retryBase = this.#time.now();
          }
          nextRetryAt = new Date(
            retryBase.getTime() + computeRetryDelayMs(attempt, delayMs, backoff),
          );
        }

        const failureUpdate = {
          status: shouldRetry ? "waiting" : "errored",
          errorName: error.name,
          errorMessage: error.message,
          nextRetryAt,
          updatedAt: this.#time.now(),
        };
        const snapshot = getStepSnapshot(this.#state, name);
        queueStepUpdate(this.#state, name, snapshot?.id, failureUpdate);

        if (shouldRetry && nextRetryAt) {
          await this.#throwIfPauseRequested();
          throw new WorkflowSuspend("retry", nextRetryAt);
        }

        throw error;
      }
    } finally {
      this.#endStep(name);
    }
  }

  async sleep(name: string, duration: WorkflowDuration): Promise<void> {
    const dbNow = await this.#getDbNow();
    const wakeAt = new Date(dbNow.getTime() + parseDurationMs(duration));
    return this.#sleepUntil(name, wakeAt);
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    const wakeAt = coerceDate(timestamp);
    return this.#sleepUntil(name, wakeAt);
  }

  async waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }> {
    this.#beginStep(name);
    this.#setStepContext(name, null);
    const now = this.#time.now();
    const dbNow = await this.#getDbNow();

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
      const wakeAt = existing?.wakeAt ?? new Date(dbNow.getTime() + timeoutMs);

      const event = this.#state.events.find((candidate) => {
        if (candidate.type !== options.type || candidate.deliveredAt !== null) {
          return false;
        }
        const createdAt = coerceEventTimestamp(candidate.createdAt);
        if (Number.isNaN(createdAt.getTime())) {
          return false;
        }
        return createdAt <= wakeAt;
      });

      if (event) {
        const eventTimestamp = coerceEventTimestamp(event.createdAt);
        const result = {
          type: event.type,
          payload: event.payload as Readonly<T>,
          timestamp: eventTimestamp,
        };

        queueEventUpdate(this.#state, event, {
          deliveredAt: now,
          consumedByStepKey: name,
        });

        if (existing?.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "completed",
            result,
            updatedAt: now,
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
            createdAt: now,
            updatedAt: now,
          });
        }

        await this.#throwIfPauseRequested();
        return { ...result, timestamp: coerceEventTimestamp(result.timestamp) };
      }

      if (wakeAt <= dbNow) {
        if (existing?.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "errored",
            errorName: "WaitForEventTimeoutError",
            errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
            updatedAt: now,
          });
        }
        throw new WaitForEventTimeoutError();
      }

      if (existing?.id) {
        queueStepUpdate(this.#state, name, existing.id, {
          status: "waiting",
          wakeAt,
          waitEventType: options.type,
          timeoutMs,
          updatedAt: now,
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
          wakeAt,
          waitEventType: options.type,
          result: null,
          errorName: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", wakeAt);
    } finally {
      this.#endStep(name);
    }
  }

  async #sleepUntil(name: string, wakeAt: Date): Promise<void> {
    this.#beginStep(name);
    this.#setStepContext(name, null);
    const now = this.#time.now();
    const dbNow = await this.#getDbNow();

    try {
      const existing = getStepSnapshot(this.#state, name);
      if (existing && existing.type !== "sleep") {
        throw new Error("STEP_TYPE_MISMATCH");
      }

      if (existing?.status === "completed") {
        await this.#throwIfPauseRequested();
        return;
      }

      if (existing?.wakeAt && existing.wakeAt <= dbNow) {
        if (existing.id) {
          queueStepUpdate(this.#state, name, existing.id, {
            status: "completed",
            updatedAt: now,
          });
        }
        await this.#throwIfPauseRequested();
        return;
      }

      if (existing?.id) {
        queueStepUpdate(this.#state, name, existing.id, {
          status: "waiting",
          wakeAt: existing.wakeAt ?? wakeAt,
          updatedAt: now,
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
          wakeAt,
          waitEventType: null,
          result: null,
          errorName: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", wakeAt);
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
      createdAt: this.#time.now(),
    };

    queueLogCreate(this.#state, log);
  }
}

export { WorkflowSuspend, WorkflowPause, WorkflowAbort };
