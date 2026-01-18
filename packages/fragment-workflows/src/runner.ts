import type { SimpleQueryInterface, TableToColumnValues } from "@fragno-dev/db/query";
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
  WorkflowEnqueuedHookPayload,
  WorkflowsClock,
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
  db: SimpleQueryInterface<typeof workflowsSchema>;
  workflows: WorkflowsRegistry;
  runnerId?: string;
  leaseMs?: number;
  onWorkflowEnqueued?: (payload: WorkflowEnqueuedHookPayload) => Promise<void> | void;
  clock?: WorkflowsClock;
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
  #db: SimpleQueryInterface<typeof workflowsSchema>;
  #workflowName: string;
  #instanceId: string;
  #runNumber: number;
  #inFlightSteps = new Set<string>();
  #maxSteps: number;
  #stepCount = 0;
  #clock: WorkflowsClock;
  #isReplay: boolean;
  #activeStepKey: string | null = null;
  #activeAttempt: number | null = null;

  constructor(options: {
    db: SimpleQueryInterface<typeof workflowsSchema>;
    workflowName: string;
    instanceId: string;
    runNumber: number;
    maxSteps: number;
    clock: WorkflowsClock;
    isReplay: boolean;
  }) {
    this.#db = options.db;
    this.#workflowName = options.workflowName;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#maxSteps = options.maxSteps;
    this.#clock = options.clock;
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

    try {
      const existing = await this.#db.findFirst("workflow_step", (b) =>
        b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
          eb.and(
            eb("workflowName", "=", this.#workflowName),
            eb("instanceId", "=", this.#instanceId),
            eb("runNumber", "=", this.#runNumber),
            eb("stepKey", "=", name),
          ),
        ),
      );

      if (existing) {
        if (existing.type !== "do") {
          throw new Error("STEP_TYPE_MISMATCH");
        }
        if (existing.status === "completed") {
          await this.#throwIfPauseRequested();
          return existing.result as T;
        }
        if (existing.status === "waiting" && existing.nextRetryAt) {
          if (existing.nextRetryAt > this.#clock.now()) {
            await this.#throwIfPauseRequested();
            throw new WorkflowSuspend("retry", existing.nextRetryAt);
          }
        }
        if (existing.status === "errored") {
          const err = new Error(existing.errorMessage ?? "STEP_FAILED");
          err.name = existing.errorName ?? "Error";
          throw err;
        }
      }

      const { maxAttempts, delayMs, backoff } = normalizeRetryConfig(config);
      const timeoutMs = config?.timeout ? parseDurationMs(config.timeout) : null;
      const attempt = (existing?.attempts ?? 0) + 1;

      let stepId = existing?.id;

      if (stepId) {
        await this.#db.update("workflow_step", stepId, (b) =>
          b.set({
            status: "running",
            attempts: attempt,
            maxAttempts,
            timeoutMs,
            nextRetryAt: null,
            errorName: null,
            errorMessage: null,
            updatedAt: this.#clock.now(),
          }),
        );
      } else {
        stepId = await this.#db.create("workflow_step", {
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

      this.#setStepContext(name, attempt);

      try {
        const result = await this.#runWithTimeout(callback, timeoutMs);
        if (stepId) {
          await this.#db.update("workflow_step", stepId, (b) =>
            b.set({
              status: "completed",
              result,
              updatedAt: this.#clock.now(),
            }),
          );
        }
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
          ? new Date(this.#clock.now().getTime() + computeRetryDelayMs(attempt, delayMs, backoff))
          : null;

        if (stepId) {
          await this.#db.update("workflow_step", stepId, (b) =>
            b.set({
              status: shouldRetry ? "waiting" : "errored",
              errorName: error.name,
              errorMessage: error.message,
              nextRetryAt,
              updatedAt: this.#clock.now(),
            }),
          );
        }

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
    const wakeAt = new Date(this.#clock.now().getTime() + parseDurationMs(duration));
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

    try {
      const existing = await this.#db.findFirst("workflow_step", (b) =>
        b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
          eb.and(
            eb("workflowName", "=", this.#workflowName),
            eb("instanceId", "=", this.#instanceId),
            eb("runNumber", "=", this.#runNumber),
            eb("stepKey", "=", name),
          ),
        ),
      );

      if (existing) {
        if (existing.type !== "waitForEvent") {
          throw new Error("STEP_TYPE_MISMATCH");
        }
        if (existing.status === "completed" && existing.result) {
          await this.#throwIfPauseRequested();
          const result = existing.result as {
            type: string;
            payload: Readonly<T>;
            timestamp: Date | string | number;
          };
          return {
            ...result,
            timestamp: coerceEventTimestamp(result.timestamp),
          };
        }
        if (existing.status === "errored") {
          throw new WaitForEventTimeoutError();
        }
      }

      const events = await this.#db.find("workflow_event", (b) =>
        b
          .whereIndex("idx_workflow_event_history_createdAt", (eb) =>
            eb.and(
              eb("workflowName", "=", this.#workflowName),
              eb("instanceId", "=", this.#instanceId),
              eb("runNumber", "=", this.#runNumber),
            ),
          )
          .orderByIndex("idx_workflow_event_history_createdAt", "asc"),
      );

      const event = events.find(
        (candidate) => candidate.type === options.type && candidate.deliveredAt === null,
      );

      if (event) {
        const result = {
          type: event.type,
          payload: event.payload as Readonly<T>,
          timestamp: event.createdAt,
        };

        await this.#db.update("workflow_event", event.id, (b) =>
          b.set({
            deliveredAt: this.#clock.now(),
            consumedByStepKey: name,
          }),
        );

        if (existing) {
          await this.#db.update("workflow_step", existing.id, (b) =>
            b.set({
              status: "completed",
              result,
              updatedAt: this.#clock.now(),
            }),
          );
        } else {
          await this.#db.create("workflow_step", {
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

        await this.#throwIfPauseRequested();
        return result;
      }

      const timeoutMs = existing?.timeoutMs ?? normalizeWaitTimeoutMs(options.timeout);
      const wakeAt = existing?.wakeAt ?? new Date(this.#clock.now().getTime() + timeoutMs);

      if (existing) {
        if (existing.wakeAt && existing.wakeAt <= this.#clock.now()) {
          await this.#db.update("workflow_step", existing.id, (b) =>
            b.set({
              status: "errored",
              errorName: "WaitForEventTimeoutError",
              errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
              updatedAt: this.#clock.now(),
            }),
          );
          throw new WaitForEventTimeoutError();
        }

        await this.#db.update("workflow_step", existing.id, (b) =>
          b.set({
            status: "waiting",
            wakeAt,
            waitEventType: options.type,
            timeoutMs,
            updatedAt: this.#clock.now(),
          }),
        );
      } else {
        await this.#db.create("workflow_step", {
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

    try {
      const existing = await this.#db.findFirst("workflow_step", (b) =>
        b.whereIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey", (eb) =>
          eb.and(
            eb("workflowName", "=", this.#workflowName),
            eb("instanceId", "=", this.#instanceId),
            eb("runNumber", "=", this.#runNumber),
            eb("stepKey", "=", name),
          ),
        ),
      );

      if (existing) {
        if (existing.type !== "sleep") {
          throw new Error("STEP_TYPE_MISMATCH");
        }
        if (existing.status === "completed") {
          await this.#throwIfPauseRequested();
          return;
        }
        if (existing.wakeAt && existing.wakeAt <= this.#clock.now()) {
          await this.#db.update("workflow_step", existing.id, (b) =>
            b.set({ status: "completed", updatedAt: this.#clock.now() }),
          );
          await this.#throwIfPauseRequested();
          return;
        }
        await this.#db.update("workflow_step", existing.id, (b) =>
          b.set({
            status: "waiting",
            wakeAt: existing.wakeAt ?? wakeAt,
            updatedAt: this.#clock.now(),
          }),
        );
      } else {
        await this.#db.create("workflow_step", {
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
        });
      }

      await this.#throwIfPauseRequested();
      throw new WorkflowSuspend("wake", existing?.wakeAt ?? wakeAt);
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
    const instance = await this.#db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(
          eb("workflowName", "=", this.#workflowName),
          eb("instanceId", "=", this.#instanceId),
        ),
      ),
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
    await this.#db.create("workflow_log", {
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
  }
}

export function createWorkflowsRunner(runnerOptions: WorkflowsRunnerOptions): WorkflowsRunner {
  const workflowsByName = new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>();
  for (const entry of Object.values(runnerOptions.workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const clock = runnerOptions.clock ?? { now: () => new Date() };
  const runnerId = runnerOptions.runnerId ?? crypto.randomUUID();
  const leaseMs = runnerOptions.leaseMs ?? DEFAULT_LEASE_MS;
  const workflowBindings = createWorkflowsBindingsForRunner({
    db: runnerOptions.db,
    workflows: runnerOptions.workflows,
    onWorkflowEnqueued: runnerOptions.onWorkflowEnqueued,
    clock,
  });

  const claimTask = async (task: WorkflowTaskRecord, now: Date) => {
    if (!task) {
      return null;
    }

    const instance = await runnerOptions.db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", task.workflowName), eb("instanceId", "=", task.instanceId)),
      ),
    );

    if (!instance) {
      await completeTask(task);
      return null;
    }

    if (instance.runNumber !== task.runNumber) {
      await completeTask(task);
      return null;
    }

    if (isTerminalStatus(instance.status)) {
      await completeTask(task);
      return null;
    }

    if (isPausedStatus(instance.status)) {
      return null;
    }

    const hasActiveLease = task.lockedUntil ? task.lockedUntil > now : false;
    const canStealProcessing = task.status === "processing" && !hasActiveLease;
    if (task.status !== "pending" && !canStealProcessing) {
      return null;
    }

    if (task.status === "pending" && hasActiveLease) {
      return null;
    }

    const uow = runnerOptions.db.createUnitOfWork("workflow-task-claim");
    const typed = uow.forSchema(workflowsSchema);
    typed.update("workflow_task", task.id, (b) => {
      const builder = b.set({
        status: "processing",
        lockOwner: runnerId,
        lockedUntil: new Date(now.getTime() + leaseMs),
        updatedAt: clock.now(),
      });
      if (task.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });

    const { success } = await uow.executeMutations();
    if (!success) {
      return null;
    }

    return task;
  };

  const setInstanceStatus = async (
    instance: WorkflowInstanceRecord,
    status: string,
    update: Partial<WorkflowInstanceUpdate>,
  ): Promise<boolean> => {
    const current = await runnerOptions.db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(
          eb("workflowName", "=", instance.workflowName),
          eb("instanceId", "=", instance.instanceId),
        ),
      ),
    );

    if (!current) {
      return false;
    }

    if (current.runNumber !== instance.runNumber) {
      return false;
    }

    if (isTerminalStatus(current.status)) {
      return false;
    }

    const { id: _ignoredId, ...safeUpdate } = update as WorkflowInstanceRecord;

    const uow = runnerOptions.db.createUnitOfWork("workflow-instance-update");
    const typed = uow.forSchema(workflowsSchema);
    typed.update("workflow_instance", current.id, (b) => {
      const builder = b.set({
        ...safeUpdate,
        status,
        updatedAt: clock.now(),
      });
      if (current.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });
    const { success } = await uow.executeMutations();
    return success;
  };

  const scheduleTask = async (
    task: WorkflowTaskRecord,
    kind: "wake" | "retry" | "run",
    runAt: Date,
  ) => {
    const current = await runnerOptions.db.findFirst("workflow_task", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", task.id)),
    );

    if (!current) {
      return false;
    }

    if (current.updatedAt.getTime() !== task.updatedAt.getTime()) {
      return false;
    }

    const uow = runnerOptions.db.createUnitOfWork("workflow-task-schedule");
    const typed = uow.forSchema(workflowsSchema);
    typed.update("workflow_task", current.id, (b) => {
      const builder = b.set({
        kind,
        runAt,
        status: "pending",
        attempts: 0,
        lastError: null,
        lockOwner: null,
        lockedUntil: null,
        updatedAt: clock.now(),
      });
      if (current.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });
    const { success } = await uow.executeMutations();
    return success;
  };

  const completeTask = async (task: WorkflowTaskRecord) => {
    await runnerOptions.db.delete("workflow_task", task.id);
  };

  const renewTaskLease = async (taskId: WorkflowTaskRecord["id"]) => {
    const current = await runnerOptions.db.findFirst("workflow_task", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", taskId)),
    );

    if (!current) {
      return false;
    }

    if (current.status !== "processing" || current.lockOwner !== runnerId) {
      return false;
    }

    const uow = runnerOptions.db.createUnitOfWork("workflow-task-renew");
    const typed = uow.forSchema(workflowsSchema);
    typed.update("workflow_task", current.id, (b) => {
      const builder = b.set({
        lockedUntil: new Date(clock.now().getTime() + leaseMs),
        updatedAt: clock.now(),
      });
      if (current.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });

    const { success } = await uow.executeMutations();
    return success;
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

    const instance = await runnerOptions.db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", task.workflowName), eb("instanceId", "=", task.instanceId)),
      ),
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
        completedAt: clock.now(),
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
        startedAt: instance.startedAt ?? clock.now(),
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

    const existingStep = await runnerOptions.db.findFirst("workflow_step", (b) =>
      b.whereIndex("idx_workflow_step_history_createdAt", (eb) =>
        eb.and(
          eb("workflowName", "=", instance.workflowName),
          eb("instanceId", "=", instance.instanceId),
          eb("runNumber", "=", instance.runNumber),
        ),
      ),
    );

    const step = new RunnerStep({
      db: runnerOptions.db,
      workflowName: instance.workflowName,
      instanceId: instance.instanceId,
      runNumber: instance.runNumber,
      maxSteps,
      clock,
      isReplay: Boolean(existingStep),
    });

    const stopHeartbeat = startTaskLeaseHeartbeat(task.id);

    try {
      const output = await workflow.run(event, step);
      const updated = await setInstanceStatus(instance, "complete", {
        output: output ?? null,
        errorName: null,
        errorMessage: null,
        completedAt: clock.now(),
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
        completedAt: clock.now(),
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
      const now = clock.now();
      const maxInstances = tickOptions.maxInstances ?? DEFAULT_MAX_INSTANCES;
      const maxSteps = tickOptions.maxSteps ?? DEFAULT_MAX_STEPS;

      const [pendingTasks, expiredProcessingTasks] = await Promise.all([
        runnerOptions.db.find("workflow_task", (b) =>
          b
            .whereIndex("idx_workflow_task_status_runAt", (eb) =>
              eb.and(eb("status", "=", "pending"), eb("runAt", "<=", now)),
            )
            .orderByIndex("idx_workflow_task_status_runAt", "asc")
            .pageSize(maxInstances * 3),
        ),
        runnerOptions.db.find("workflow_task", (b) =>
          b
            .whereIndex("idx_workflow_task_status_lockedUntil", (eb) =>
              eb.and(eb("status", "=", "processing"), eb("lockedUntil", "<=", now)),
            )
            .orderByIndex("idx_workflow_task_status_lockedUntil", "asc")
            .pageSize(maxInstances * 3),
        ),
      ]);

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
