import type { FragnoRuntime } from "@fragno-dev/core";
import { ConcurrencyConflictError, type DatabaseRequestContext } from "@fragno-dev/db";
import type { TableToColumnValues } from "@fragno-dev/db/query";
import { FragnoId } from "@fragno-dev/db/schema";
import { workflowsSchema } from "./schema";
import type {
  WorkflowDuration,
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowLogger,
  WorkflowLogLevel,
  WorkflowLogOptions,
  WorkflowsRegistry,
  WorkflowsRunner,
  RunnerTickOptions,
} from "./workflow";
import { NonRetryableError } from "./workflow";
import { createWorkflowsBindingsForRunner } from "./bindings-runner";
import { parseDurationMs } from "./utils";

const DEFAULT_MAX_INSTANCES = 10;
const DEFAULT_MAX_STEPS = 1024;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

const PRIORITY_BY_KIND: Record<string, number> = {
  wake: 0,
  retry: 1,
  resume: 2,
  run: 3,
  gc: 4,
};

type WorkflowTaskRecord = TableToColumnValues<(typeof workflowsSchema)["tables"]["workflow_task"]>;

type WorkflowInstanceRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_instance"]
>;

type WorkflowInstanceUpdate = Omit<WorkflowInstanceRecord, "id">;

type WorkflowStepRecord = TableToColumnValues<(typeof workflowsSchema)["tables"]["workflow_step"]>;

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

type WorkflowsRunnerOptions = {
  fragment: WorkflowsRunnerFragment;
  workflows: WorkflowsRegistry;
  runtime: FragnoRuntime;
  runnerId?: string;
  leaseMs?: number;
};

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

type RunHandlerTx = <T>(
  callback: (handlerTx: DatabaseRequestContext["handlerTx"]) => T | Promise<T>,
) => Promise<T>;

type WorkflowsRunnerFragment = {
  inContext: <T>(callback: (this: DatabaseRequestContext) => T | Promise<T>) => T | Promise<T>;
  services: Record<string, unknown>;
};

const runHandlerTx = async <T>(
  fragment: WorkflowsRunnerFragment,
  callback: (handlerTx: DatabaseRequestContext["handlerTx"]) => T | Promise<T>,
): Promise<T> => {
  return await fragment.inContext(function (this: DatabaseRequestContext) {
    const handlerTx: DatabaseRequestContext["handlerTx"] = (options) => this.handlerTx(options);
    return callback(handlerTx);
  });
};

const normalizeWaitTimeoutMs = (duration?: WorkflowDuration) => {
  const timeoutMs = duration ? parseDurationMs(duration) : DEFAULT_WAIT_TIMEOUT_MS;
  if (timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new Error("WAIT_FOR_EVENT_TIMEOUT_RANGE");
  }
  return timeoutMs;
};

const normalizeRetryConfig = (config?: WorkflowStepConfig) => {
  const retries = config?.retries;
  if (!retries) {
    return {
      maxAttempts: 1,
      delayMs: 0,
      backoff: "constant" as const,
    };
  }

  return {
    maxAttempts: retries.limit + 1,
    delayMs: parseDurationMs(retries.delay),
    backoff: retries.backoff ?? "constant",
  };
};

const computeRetryDelayMs = (attempt: number, delayMs: number, backoff: string) => {
  if (delayMs === 0) {
    return 0;
  }

  switch (backoff) {
    case "linear":
      return delayMs * attempt;
    case "exponential":
      return delayMs * Math.pow(2, attempt - 1);
    default:
      return delayMs;
  }
};

const isTerminalStatus = (status: string) =>
  status === "complete" || status === "terminated" || status === "errored";

const isPausedStatus = (status: string) => status === "paused" || status === "waitingForPause";

class RunnerStep implements WorkflowStep {
  log: WorkflowLogger;
  #runHandlerTx: RunHandlerTx;
  #workflowName: string;
  #instanceId: string;
  #runNumber: number;
  #inFlightSteps = new Set<string>();
  #maxSteps: number;
  #stepCount = 0;
  #time: FragnoRuntime["time"];
  #isReplay: boolean;
  #activeStepKey: string | null = null;
  #activeAttempt: number | null = null;

  constructor(options: {
    runHandlerTx: RunHandlerTx;
    workflowName: string;
    instanceId: string;
    runNumber: number;
    maxSteps: number;
    time: FragnoRuntime["time"];
    isReplay: boolean;
  }) {
    this.#runHandlerTx = options.runHandlerTx;
    this.#workflowName = options.workflowName;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#maxSteps = options.maxSteps;
    this.#time = options.time;
    this.#isReplay = options.isReplay;
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
            isReplay: this.#isReplay,
          });
        })
        .execute(),
    );
  }
}

export function createWorkflowsRunner(runnerOptions: WorkflowsRunnerOptions): WorkflowsRunner {
  const workflowsByName = new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>();
  for (const entry of Object.values(runnerOptions.workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const runtime = runnerOptions.runtime;
  const time = runtime.time;
  const runnerId = runnerOptions.runnerId ?? runtime.random.uuid();
  const leaseMs = runnerOptions.leaseMs ?? DEFAULT_LEASE_MS;
  const runHandlerTxForRunner: RunHandlerTx = (callback) =>
    runHandlerTx(runnerOptions.fragment, callback);
  const workflowBindings = createWorkflowsBindingsForRunner({
    workflows: runnerOptions.workflows,
    fragment: runnerOptions.fragment,
  });

  const claimTask = async (task: WorkflowTaskRecord, now: Date) => {
    if (!task) {
      return null;
    }

    const claimedAt = time.now();
    const lockedUntil = new Date(now.getTime() + leaseMs);

    let outcome;
    try {
      outcome = await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema)
              .findFirst("workflow_task", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
              )
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(
                    eb("workflowName", "=", task.workflowName),
                    eb("instanceId", "=", task.instanceId),
                  ),
                ),
              ),
          )
          .transformRetrieve(([currentTask, instance]) => {
            if (!currentTask) {
              return { kind: "noop" as const };
            }

            if (!instance || instance.runNumber !== currentTask.runNumber) {
              return { kind: "delete" as const, taskId: currentTask.id };
            }

            if (isTerminalStatus(instance.status)) {
              return { kind: "delete" as const, taskId: currentTask.id };
            }

            if (isPausedStatus(instance.status)) {
              return { kind: "noop" as const };
            }

            const hasActiveLease = currentTask.lockedUntil ? currentTask.lockedUntil > now : false;
            const canStealProcessing = currentTask.status === "processing" && !hasActiveLease;
            if (currentTask.status !== "pending" && !canStealProcessing) {
              return { kind: "noop" as const };
            }

            if (currentTask.status === "pending" && hasActiveLease) {
              return { kind: "noop" as const };
            }

            return {
              kind: "claim" as const,
              task: currentTask,
            };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult.kind === "delete") {
              const taskId = retrieveResult.taskId;
              forSchema(workflowsSchema).delete("workflow_task", taskId, (b) => {
                if (taskId instanceof FragnoId) {
                  return b.check();
                }
                return b;
              });
              return;
            }

            if (retrieveResult.kind === "claim") {
              const taskId = retrieveResult.task.id;
              forSchema(workflowsSchema).update("workflow_task", taskId, (b) => {
                const builder = b.set({
                  status: "processing",
                  lockOwner: runnerId,
                  lockedUntil,
                  updatedAt: claimedAt,
                });
                if (taskId instanceof FragnoId) {
                  builder.check();
                }
                return builder;
              });
            }
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        return null;
      }
      throw err;
    }

    if (outcome.kind !== "claim") {
      return null;
    }

    return {
      ...outcome.task,
      status: "processing",
      lockOwner: runnerId,
      lockedUntil,
      updatedAt: claimedAt,
    };
  };

  const setInstanceStatus = async (
    instance: WorkflowInstanceRecord,
    status: string,
    update: Partial<WorkflowInstanceUpdate>,
  ): Promise<boolean> => {
    const { id: _ignoredId, ...safeUpdate } = update as WorkflowInstanceRecord;

    try {
      const outcome = await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(
                  eb("workflowName", "=", instance.workflowName),
                  eb("instanceId", "=", instance.instanceId),
                ),
              ),
            ),
          )
          .transformRetrieve(([current]) => {
            if (!current) {
              return { kind: "noop" as const };
            }

            if (current.runNumber !== instance.runNumber) {
              return { kind: "noop" as const };
            }

            if (isTerminalStatus(current.status)) {
              return { kind: "noop" as const };
            }

            return { kind: "update" as const, id: current.id };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult.kind !== "update") {
              return;
            }
            const currentId = retrieveResult.id;
            forSchema(workflowsSchema).update("workflow_instance", currentId, (b) => {
              const builder = b.set({
                ...safeUpdate,
                status,
                updatedAt: time.now(),
              });
              if (currentId instanceof FragnoId) {
                builder.check();
              }
              return builder;
            });
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );
      return outcome.kind === "update";
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        return false;
      }
      throw err;
    }
  };

  const scheduleTask = async (
    task: WorkflowTaskRecord,
    kind: "wake" | "retry" | "run",
    runAt: Date,
  ) => {
    try {
      const outcome = await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
            ),
          )
          .transformRetrieve(([current]) => {
            if (!current) {
              return { kind: "noop" as const };
            }

            if (current.updatedAt.getTime() !== task.updatedAt.getTime()) {
              return { kind: "noop" as const };
            }

            return { kind: "update" as const, id: current.id };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult.kind !== "update") {
              return;
            }
            const currentId = retrieveResult.id;
            forSchema(workflowsSchema).update("workflow_task", currentId, (b) => {
              const builder = b.set({
                kind,
                runAt,
                status: "pending",
                attempts: 0,
                lastError: null,
                lockOwner: null,
                lockedUntil: null,
                updatedAt: time.now(),
              });
              if (currentId instanceof FragnoId) {
                builder.check();
              }
              return builder;
            });
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );
      return outcome.kind === "update";
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        return false;
      }
      throw err;
    }
  };

  const completeTask = async (task: WorkflowTaskRecord) => {
    try {
      await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
            ),
          )
          .transformRetrieve(([current]) => {
            if (!current) {
              return { kind: "noop" as const };
            }
            return { kind: "delete" as const, id: current.id };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult.kind !== "delete") {
              return;
            }
            const currentId = retrieveResult.id;
            forSchema(workflowsSchema).delete("workflow_task", currentId, (b) => {
              if (currentId instanceof FragnoId) {
                return b.check();
              }
              return b;
            });
          })
          .execute(),
      );
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        return;
      }
      throw err;
    }
  };

  const renewTaskLease = async (taskId: WorkflowTaskRecord["id"]) => {
    try {
      const outcome = await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).findFirst("workflow_task", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", taskId)),
            ),
          )
          .transformRetrieve(([current]) => {
            if (!current) {
              return { kind: "noop" as const };
            }

            if (current.status !== "processing" || current.lockOwner !== runnerId) {
              return { kind: "noop" as const };
            }

            return { kind: "update" as const, id: current.id };
          })
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult.kind !== "update") {
              return;
            }
            const currentId = retrieveResult.id;
            forSchema(workflowsSchema).update("workflow_task", currentId, (b) => {
              const builder = b.set({
                lockedUntil: new Date(time.now().getTime() + leaseMs),
                updatedAt: time.now(),
              });
              if (currentId instanceof FragnoId) {
                builder.check();
              }
              return builder;
            });
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .execute(),
      );
      return outcome.kind === "update";
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        return false;
      }
      throw err;
    }
  };

  const startTaskLeaseHeartbeat = (taskId: WorkflowTaskRecord["id"]) => {
    const intervalMs = Math.max(Math.floor(leaseMs / 2), 10);
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const heartbeat = async () => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const renewed = await renewTaskLease(taskId);
        if (!renewed) {
          stopped = true;
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      } finally {
        inFlight = false;
      }
    };

    timer = setInterval(() => {
      void heartbeat();
    }, intervalMs);

    return () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  };

  const processTask = async (task: WorkflowTaskRecord, maxSteps: number) => {
    if (!task) {
      return 0;
    }

    const instance = await runHandlerTxForRunner((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
            b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
              eb.and(
                eb("workflowName", "=", task.workflowName),
                eb("instanceId", "=", task.instanceId),
              ),
            ),
          ),
        )
        .transformRetrieve(([record]) => record)
        .execute(),
    );

    if (!instance) {
      await completeTask(task);
      return 0;
    }

    if (instance.runNumber !== task.runNumber) {
      await completeTask(task);
      return 0;
    }

    if (isTerminalStatus(instance.status)) {
      await completeTask(task);
      return 0;
    }

    if (isPausedStatus(instance.status)) {
      await scheduleTask(task, task.kind as "run" | "wake" | "retry", task.runAt);
      return 0;
    }

    const workflowEntry = workflowsByName.get(instance.workflowName);
    if (!workflowEntry) {
      const updated = await setInstanceStatus(instance, "errored", {
        errorName: "WorkflowNotFound",
        errorMessage: "WORKFLOW_NOT_FOUND",
        completedAt: time.now(),
      });
      if (!updated) {
        await completeTask(task);
        return 0;
      }
      await completeTask(task);
      return 0;
    }

    if (instance.status !== "running") {
      const updated = await setInstanceStatus(instance, "running", {
        startedAt: instance.startedAt ?? time.now(),
      });
      if (!updated) {
        await completeTask(task);
        return 0;
      }
    }

    const workflow = new workflowEntry.workflow() as WorkflowEntrypoint<unknown, unknown>;
    workflow.workflows = workflowBindings;

    const event: WorkflowEvent<unknown> = {
      payload: instance.params ?? {},
      timestamp: instance.createdAt,
      instanceId: instance.instanceId,
    };

    const existingStep = await runHandlerTxForRunner((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_step", (b) =>
            b.whereIndex("idx_workflow_step_history_createdAt", (eb) =>
              eb.and(
                eb("workflowName", "=", instance.workflowName),
                eb("instanceId", "=", instance.instanceId),
                eb("runNumber", "=", instance.runNumber),
              ),
            ),
          ),
        )
        .transformRetrieve(([record]) => record)
        .execute(),
    );

    const step = new RunnerStep({
      runHandlerTx: runHandlerTxForRunner,
      workflowName: instance.workflowName,
      instanceId: instance.instanceId,
      runNumber: instance.runNumber,
      maxSteps,
      time,
      isReplay: Boolean(existingStep),
    });

    const stopHeartbeat = startTaskLeaseHeartbeat(task.id);

    try {
      const output = await workflow.run(event, step);
      const updated = await setInstanceStatus(instance, "complete", {
        output: output ?? null,
        errorName: null,
        errorMessage: null,
        completedAt: time.now(),
        pauseRequested: false,
      });
      if (!updated) {
        await completeTask(task);
        return 0;
      }
      await completeTask(task);
      return 1;
    } catch (err) {
      if (err instanceof WorkflowAbort) {
        await completeTask(task);
        return 0;
      }

      if (err instanceof WorkflowPause) {
        const updated = await setInstanceStatus(instance, "paused", {
          pauseRequested: false,
        });
        if (!updated) {
          await completeTask(task);
          return 0;
        }
        await completeTask(task);
        return 1;
      }

      if (err instanceof WorkflowSuspend) {
        if (instance.pauseRequested) {
          const updated = await setInstanceStatus(instance, "paused", {
            pauseRequested: false,
          });
          if (!updated) {
            await completeTask(task);
            return 0;
          }
          await completeTask(task);
          return 1;
        }

        const updated = await setInstanceStatus(instance, "waiting", {});
        if (!updated) {
          await completeTask(task);
          return 0;
        }
        await scheduleTask(task, err.kind, err.runAt);
        return 1;
      }

      const error = err as Error;
      const updated = await setInstanceStatus(instance, "errored", {
        errorName: error.name ?? "Error",
        errorMessage: error.message ?? "",
        completedAt: time.now(),
        pauseRequested: false,
      });
      if (!updated) {
        await completeTask(task);
        return 0;
      }
      await completeTask(task);
      return 1;
    } finally {
      stopHeartbeat();
    }
  };

  return {
    async tick(tickOptions: RunnerTickOptions = {}) {
      const now = time.now();
      const maxInstances = tickOptions.maxInstances ?? DEFAULT_MAX_INSTANCES;
      const maxSteps = tickOptions.maxSteps ?? DEFAULT_MAX_STEPS;

      const [pendingTasks, expiredProcessingTasks] = await runHandlerTxForRunner((handlerTx) =>
        handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema)
              .find("workflow_task", (b) =>
                b
                  .whereIndex("idx_workflow_task_status_runAt", (eb) =>
                    eb.and(eb("status", "=", "pending"), eb("runAt", "<=", now)),
                  )
                  .orderByIndex("idx_workflow_task_status_runAt", "asc")
                  .pageSize(maxInstances * 3),
              )
              .find("workflow_task", (b) =>
                b
                  .whereIndex("idx_workflow_task_status_lockedUntil", (eb) =>
                    eb.and(eb("status", "=", "processing"), eb("lockedUntil", "<=", now)),
                  )
                  .orderByIndex("idx_workflow_task_status_lockedUntil", "asc")
                  .pageSize(maxInstances * 3),
              ),
          )
          .transformRetrieve(([pending, expired]) => [pending, expired])
          .execute(),
      );

      const tasksById = new Map<string, WorkflowTaskRecord>();
      for (const task of pendingTasks) {
        tasksById.set(String(task.id), task);
      }
      for (const task of expiredProcessingTasks) {
        tasksById.set(String(task.id), task);
      }
      const tasks = Array.from(tasksById.values());

      tasks.sort((a, b) => {
        const priorityA = PRIORITY_BY_KIND[a.kind] ?? 9;
        const priorityB = PRIORITY_BY_KIND[b.kind] ?? 9;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        return a.runAt.getTime() - b.runAt.getTime();
      });

      let processed = 0;
      for (const task of tasks) {
        if (processed >= maxInstances) {
          break;
        }
        const claimed = await claimTask(task, now);
        if (!claimed) {
          continue;
        }
        processed += await processTask(claimed, maxSteps);
      }

      return processed;
    },
  };
}
