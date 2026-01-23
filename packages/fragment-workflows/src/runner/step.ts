// Workflow step executor with persistence, retries, and waiting semantics.

import type { FragnoRuntime } from "@fragno-dev/core";
import { FragnoId } from "@fragno-dev/db/schema";
import { workflowsSchema } from "../schema";
import type {
  WorkflowDuration,
  WorkflowLogger,
  WorkflowLogLevel,
  WorkflowLogOptions,
  WorkflowStep,
  WorkflowStepConfig,
} from "../workflow";
import { NonRetryableError } from "../workflow";
import type { RunHandlerTx, WorkflowStepRecord } from "./types";
import { computeRetryDelayMs, normalizeRetryConfig, normalizeWaitTimeoutMs } from "./utils";
import { parseDurationMs } from "../utils";
import { isTerminalStatus } from "./status";

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
  #runHandlerTx: RunHandlerTx;
  #workflowName: string;
  #instanceId: string;
  #runNumber: number;
  #inFlightSteps = new Set<string>();
  #maxSteps: number;
  #stepCount = 0;
  #time: FragnoRuntime["time"];
  #activeStepKey: string | null = null;
  #activeAttempt: number | null = null;

  constructor(options: {
    runHandlerTx: RunHandlerTx;
    workflowName: string;
    instanceId: string;
    runNumber: number;
    maxSteps: number;
    time: FragnoRuntime["time"];
  }) {
    this.#runHandlerTx = options.runHandlerTx;
    this.#workflowName = options.workflowName;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#maxSteps = options.maxSteps;
    this.#time = options.time;
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

    try {
      const outcome = await this.#runHandlerTx((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_step", (b) =>
              b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
                eb.and(
                  eb("workflowName", "=", this.#workflowName),
                  eb("instanceId", "=", this.#instanceId),
                  eb("runNumber", "=", this.#runNumber),
                  eb("stepKey", "=", name),
                ),
              ),
            ),
          )
          .transformRetrieve(([existing]) => {
            if (existing && existing.type !== "do") {
              throw new Error("STEP_TYPE_MISMATCH");
            }

            if (existing?.status === "completed") {
              return { kind: "return" as const, result: existing.result as T };
            }

            if (existing?.status === "waiting" && existing.nextRetryAt) {
              if (existing.nextRetryAt > now) {
                return { kind: "suspend" as const, runAt: existing.nextRetryAt };
              }
            }

            if (existing?.status === "errored") {
              const err = new Error(existing.errorMessage ?? "STEP_FAILED");
              err.name = existing.errorName ?? "Error";
              return { kind: "error" as const, error: err };
            }

            const { maxAttempts, delayMs, backoff } = normalizeRetryConfig(config);
            const timeoutMs = config?.timeout ? parseDurationMs(config.timeout) : null;
            const attempt = (existing?.attempts ?? 0) + 1;

            if (existing) {
              return {
                kind: "update" as const,
                stepId: existing.id,
                attempt,
                maxAttempts,
                delayMs,
                backoff,
                timeoutMs,
              };
            }

            return {
              kind: "create" as const,
              stepId: null,
              attempt,
              maxAttempts,
              delayMs,
              backoff,
              timeoutMs,
            };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult.kind === "update") {
              const stepId = retrieveResult.stepId;
              forSchema(workflowsSchema).update("workflow_step", stepId, (b) => {
                const builder = b.set({
                  status: "running",
                  attempts: retrieveResult.attempt,
                  maxAttempts: retrieveResult.maxAttempts,
                  timeoutMs: retrieveResult.timeoutMs,
                  nextRetryAt: null,
                  errorName: null,
                  errorMessage: null,
                  updatedAt: now,
                });
                if (stepId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
              return stepId;
            }

            if (retrieveResult.kind === "create") {
              return forSchema(workflowsSchema).create("workflow_step", {
                workflowName: this.#workflowName,
                instanceId: this.#instanceId,
                runNumber: this.#runNumber,
                stepKey: name,
                name,
                type: "do",
                status: "running",
                attempts: retrieveResult.attempt,
                maxAttempts: retrieveResult.maxAttempts,
                timeoutMs: retrieveResult.timeoutMs,
                nextRetryAt: null,
                wakeAt: null,
                waitEventType: null,
                result: null,
                errorName: null,
                errorMessage: null,
              });
            }

            return undefined;
          })
          .transform(({ retrieveResult, mutateResult }) => {
            if (retrieveResult.kind === "update") {
              return {
                kind: "run" as const,
                stepId: retrieveResult.stepId,
                attempt: retrieveResult.attempt,
                maxAttempts: retrieveResult.maxAttempts,
                delayMs: retrieveResult.delayMs,
                backoff: retrieveResult.backoff,
                timeoutMs: retrieveResult.timeoutMs,
              };
            }

            if (retrieveResult.kind === "create") {
              return {
                kind: "run" as const,
                stepId: mutateResult as WorkflowStepRecord["id"],
                attempt: retrieveResult.attempt,
                maxAttempts: retrieveResult.maxAttempts,
                delayMs: retrieveResult.delayMs,
                backoff: retrieveResult.backoff,
                timeoutMs: retrieveResult.timeoutMs,
              };
            }

            return retrieveResult;
          })
          .execute(),
      );

      if (outcome.kind === "return") {
        await this.#throwIfPauseRequested();
        return outcome.result as T;
      }

      if (outcome.kind === "suspend") {
        await this.#throwIfPauseRequested();
        throw new WorkflowSuspend("retry", outcome.runAt);
      }

      if (outcome.kind === "error") {
        throw outcome.error;
      }

      const { attempt, maxAttempts, delayMs, backoff, timeoutMs } = outcome;
      this.#setStepContext(name, attempt);

      try {
        const result = await this.#runWithTimeout(callback, timeoutMs);
        await this.#runHandlerTx((handlerTx) =>
          handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(workflowsSchema).findFirst("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
                  eb.and(
                    eb("workflowName", "=", this.#workflowName),
                    eb("instanceId", "=", this.#instanceId),
                    eb("runNumber", "=", this.#runNumber),
                    eb("stepKey", "=", name),
                  ),
                ),
              ),
            )
            .transformRetrieve(([current]) => {
              if (!current) {
                return { kind: "noop" as const };
              }
              return { kind: "update" as const, id: current.id };
            })
            .mutate(({ forSchema, retrieveResult }) => {
              if (retrieveResult.kind !== "update") {
                return;
              }
              const currentId = retrieveResult.id;
              forSchema(workflowsSchema).update("workflow_step", currentId, (b) => {
                const builder = b.set({
                  status: "completed",
                  result,
                  updatedAt: this.#time.now(),
                });
                if (currentId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
            })
            .execute(),
        );
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

        const nextRetryAt = shouldRetry
          ? new Date(this.#time.now().getTime() + computeRetryDelayMs(attempt, delayMs, backoff))
          : null;

        await this.#runHandlerTx((handlerTx) =>
          handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(workflowsSchema).findFirst("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
                  eb.and(
                    eb("workflowName", "=", this.#workflowName),
                    eb("instanceId", "=", this.#instanceId),
                    eb("runNumber", "=", this.#runNumber),
                    eb("stepKey", "=", name),
                  ),
                ),
              ),
            )
            .transformRetrieve(([current]) => {
              if (!current) {
                return { kind: "noop" as const };
              }
              return { kind: "update" as const, id: current.id };
            })
            .mutate(({ forSchema, retrieveResult }) => {
              if (retrieveResult.kind !== "update") {
                return;
              }
              const currentId = retrieveResult.id;
              forSchema(workflowsSchema).update("workflow_step", currentId, (b) => {
                const builder = b.set({
                  status: shouldRetry ? "waiting" : "errored",
                  errorName: error.name,
                  errorMessage: error.message,
                  nextRetryAt,
                  updatedAt: this.#time.now(),
                });
                if (currentId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
            })
            .execute(),
        );

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
    const wakeAt = new Date(this.#time.now().getTime() + parseDurationMs(duration));
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

    try {
      const outcome = await this.#runHandlerTx((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema)
              .findFirst("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
                  eb.and(
                    eb("workflowName", "=", this.#workflowName),
                    eb("instanceId", "=", this.#instanceId),
                    eb("runNumber", "=", this.#runNumber),
                    eb("stepKey", "=", name),
                  ),
                ),
              )
              .find("workflow_event", (b) =>
                b
                  .whereIndex("idx_workflow_event_history_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", this.#workflowName),
                      eb("instanceId", "=", this.#instanceId),
                      eb("runNumber", "=", this.#runNumber),
                    ),
                  )
                  .orderByIndex("idx_workflow_event_history_createdAt", "asc"),
              ),
          )
          .transformRetrieve(([existing, events]) => {
            if (existing && existing.type !== "waitForEvent") {
              throw new Error("STEP_TYPE_MISMATCH");
            }

            if (existing?.status === "completed" && existing.result) {
              const result = existing.result as {
                type: string;
                payload: Readonly<T>;
                timestamp: Date | string | number;
              };
              return { kind: "return" as const, result };
            }

            if (existing?.status === "errored") {
              return { kind: "timeout" as const };
            }

            const event = events.find(
              (candidate) => candidate.type === options.type && candidate.deliveredAt === null,
            );

            if (event) {
              const result = {
                type: event.type,
                payload: event.payload as Readonly<T>,
                timestamp: event.createdAt,
              };

              return {
                kind: "deliver" as const,
                event,
                existingStepId: existing?.id ?? null,
                result,
              };
            }

            const timeoutMs = existing?.timeoutMs ?? normalizeWaitTimeoutMs(options.timeout);
            const wakeAt = existing?.wakeAt ?? new Date(now.getTime() + timeoutMs);

            if (existing?.wakeAt && existing.wakeAt <= now) {
              return {
                kind: "timeoutUpdate" as const,
                stepId: existing.id,
              };
            }

            return {
              kind: "wait" as const,
              stepId: existing?.id ?? null,
              wakeAt,
              timeoutMs,
            };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            const typed = forSchema(workflowsSchema);

            if (retrieveResult.kind === "deliver") {
              typed.update("workflow_event", retrieveResult.event.id, (b) => {
                const builder = b.set({
                  deliveredAt: now,
                  consumedByStepKey: name,
                });
                if (retrieveResult.event.id instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });

              if (retrieveResult.existingStepId) {
                const stepId = retrieveResult.existingStepId;
                typed.update("workflow_step", stepId, (b) => {
                  const builder = b.set({
                    status: "completed",
                    result: retrieveResult.result,
                    updatedAt: now,
                  });
                  if (stepId instanceof FragnoId) {
                    builder.check();
                  }
                  return builder;
                });
              } else {
                typed.create("workflow_step", {
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
                  result: retrieveResult.result,
                  errorName: null,
                  errorMessage: null,
                });
              }
              return;
            }

            if (retrieveResult.kind === "timeoutUpdate") {
              const stepId = retrieveResult.stepId;
              typed.update("workflow_step", stepId, (b) => {
                const builder = b.set({
                  status: "errored",
                  errorName: "WaitForEventTimeoutError",
                  errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
                  updatedAt: now,
                });
                if (stepId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
              return;
            }

            if (retrieveResult.kind === "wait") {
              if (retrieveResult.stepId) {
                const stepId = retrieveResult.stepId;
                typed.update("workflow_step", stepId, (b) => {
                  const builder = b.set({
                    status: "waiting",
                    wakeAt: retrieveResult.wakeAt,
                    waitEventType: options.type,
                    timeoutMs: retrieveResult.timeoutMs,
                    updatedAt: now,
                  });
                  if (stepId instanceof FragnoId) {
                    builder.check();
                  }
                  return builder;
                });
              } else {
                typed.create("workflow_step", {
                  workflowName: this.#workflowName,
                  instanceId: this.#instanceId,
                  runNumber: this.#runNumber,
                  stepKey: name,
                  name,
                  type: "waitForEvent",
                  status: "waiting",
                  attempts: 0,
                  maxAttempts: 1,
                  timeoutMs: retrieveResult.timeoutMs,
                  nextRetryAt: null,
                  wakeAt: retrieveResult.wakeAt,
                  waitEventType: options.type,
                  result: null,
                  errorName: null,
                  errorMessage: null,
                });
              }
            }
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );

      if (outcome.kind === "return") {
        await this.#throwIfPauseRequested();
        return {
          ...outcome.result,
          timestamp: coerceEventTimestamp(outcome.result.timestamp),
        };
      }

      if (outcome.kind === "deliver") {
        await this.#throwIfPauseRequested();
        return {
          ...outcome.result,
          timestamp: coerceEventTimestamp(outcome.result.timestamp),
        };
      }

      if (outcome.kind === "timeout" || outcome.kind === "timeoutUpdate") {
        throw new WaitForEventTimeoutError();
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", outcome.wakeAt);
    } finally {
      this.#endStep(name);
    }
  }

  async #sleepUntil(name: string, wakeAt: Date): Promise<void> {
    this.#beginStep(name);
    this.#setStepContext(name, null);
    const now = this.#time.now();

    try {
      const outcome = await this.#runHandlerTx((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_step", (b) =>
              b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
                eb.and(
                  eb("workflowName", "=", this.#workflowName),
                  eb("instanceId", "=", this.#instanceId),
                  eb("runNumber", "=", this.#runNumber),
                  eb("stepKey", "=", name),
                ),
              ),
            ),
          )
          .transformRetrieve(([existing]) => {
            if (existing && existing.type !== "sleep") {
              throw new Error("STEP_TYPE_MISMATCH");
            }

            if (existing?.status === "completed") {
              return { kind: "return" as const };
            }

            if (existing?.wakeAt && existing.wakeAt <= now) {
              return { kind: "complete" as const, stepId: existing.id };
            }

            if (existing) {
              return {
                kind: "wait" as const,
                stepId: existing.id,
                wakeAt: existing.wakeAt ?? wakeAt,
              };
            }

            return { kind: "create" as const, wakeAt };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            const typed = forSchema(workflowsSchema);

            if (retrieveResult.kind === "complete") {
              const stepId = retrieveResult.stepId;
              typed.update("workflow_step", stepId, (b) => {
                const builder = b.set({ status: "completed", updatedAt: now });
                if (stepId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
              return;
            }

            if (retrieveResult.kind === "wait") {
              const stepId = retrieveResult.stepId;
              typed.update("workflow_step", stepId, (b) => {
                const builder = b.set({
                  status: "waiting",
                  wakeAt: retrieveResult.wakeAt,
                  updatedAt: now,
                });
                if (stepId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
              return;
            }

            if (retrieveResult.kind === "create") {
              typed.create("workflow_step", {
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
                wakeAt: retrieveResult.wakeAt,
                waitEventType: null,
                result: null,
                errorName: null,
                errorMessage: null,
              });
            }
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );

      if (outcome.kind === "return" || outcome.kind === "complete") {
        await this.#throwIfPauseRequested();
        return;
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", outcome.wakeAt);
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
    const instance = await this.#runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
            b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
              eb.and(
                eb("workflowName", "=", this.#workflowName),
                eb("instanceId", "=", this.#instanceId),
              ),
            ),
          ),
        )
        .transformRetrieve(([record]) => record)
        .execute(),
    );

    if (!instance) {
      return;
    }

    // Abort if the instance moved on or reached a terminal state.
    if (instance.runNumber !== this.#runNumber || isTerminalStatus(instance.status)) {
      throw new WorkflowAbort();
    }

    if (instance.pauseRequested || instance.status === "waitingForPause") {
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
    await this.#runHandlerTx((handlerTx) =>
      handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(workflowsSchema).create("workflow_log", {
            workflowName: this.#workflowName,
            instanceId: this.#instanceId,
            runNumber: this.#runNumber,
            stepKey: this.#activeStepKey,
            attempt: this.#activeAttempt,
            level,
            category: options?.category ?? "workflow",
            message,
            data: data ?? null,
          });
        })
        .execute(),
    );
  }
}

export { WorkflowSuspend, WorkflowPause, WorkflowAbort };
