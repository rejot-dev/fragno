import type { SimpleQueryInterface, TableToColumnValues } from "@fragno-dev/db/query";
import { FragnoId } from "@fragno-dev/db/schema";
import { workflowsSchema } from "./schema";
import type {
  WorkflowDuration,
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowsRegistry,
  WorkflowsRunner,
  RunnerTickOptions,
} from "./workflow";
import { NonRetryableError } from "./workflow";

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
};

const coerceDate = (timestamp: Date | number) =>
  timestamp instanceof Date ? timestamp : new Date(timestamp);

const parseDurationMs = (duration: WorkflowDuration): number => {
  if (typeof duration === "number") {
    return duration;
  }

  const trimmed = duration.trim();
  if (!trimmed) {
    throw new Error("Invalid duration");
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(\w+)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();

  switch (unit) {
    case "ms":
    case "millisecond":
    case "milliseconds":
      return value;
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
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
  #db: SimpleQueryInterface<typeof workflowsSchema>;
  #workflowName: string;
  #instanceId: string;
  #runNumber: number;
  #inFlightSteps = new Set<string>();
  #maxSteps: number;
  #stepCount = 0;

  constructor(options: {
    db: SimpleQueryInterface<typeof workflowsSchema>;
    workflowName: string;
    instanceId: string;
    runNumber: number;
    maxSteps: number;
  }) {
    this.#db = options.db;
    this.#workflowName = options.workflowName;
    this.#instanceId = options.instanceId;
    this.#runNumber = options.runNumber;
    this.#maxSteps = options.maxSteps;
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
          return existing.result as T;
        }
        if (existing.status === "waiting" && existing.nextRetryAt) {
          if (existing.nextRetryAt > new Date()) {
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
            updatedAt: new Date(),
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

      try {
        const result = await this.#runWithTimeout(callback, timeoutMs);
        if (stepId) {
          await this.#db.update("workflow_step", stepId, (b) =>
            b.set({
              status: "completed",
              result,
              updatedAt: new Date(),
            }),
          );
        }
        return result;
      } catch (err) {
        if (err instanceof WorkflowSuspend) {
          throw err;
        }

        const error = err as Error;
        const nonRetryable = error instanceof NonRetryableError;
        const shouldRetry = !nonRetryable && attempt < maxAttempts;

        const nextRetryAt = shouldRetry
          ? new Date(Date.now() + computeRetryDelayMs(attempt, delayMs, backoff))
          : null;

        if (stepId) {
          await this.#db.update("workflow_step", stepId, (b) =>
            b.set({
              status: shouldRetry ? "waiting" : "errored",
              errorName: error.name,
              errorMessage: error.message,
              nextRetryAt,
              updatedAt: new Date(),
            }),
          );
        }

        if (shouldRetry && nextRetryAt) {
          throw new WorkflowSuspend("retry", nextRetryAt);
        }

        throw error;
      }
    } finally {
      this.#endStep(name);
    }
  }

  async sleep(name: string, duration: WorkflowDuration): Promise<void> {
    const wakeAt = new Date(Date.now() + parseDurationMs(duration));
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
          return existing.result as { type: string; payload: Readonly<T>; timestamp: Date };
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
            deliveredAt: new Date(),
            consumedByStepKey: name,
          }),
        );

        if (existing) {
          await this.#db.update("workflow_step", existing.id, (b) =>
            b.set({
              status: "completed",
              result,
              updatedAt: new Date(),
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

        return result;
      }

      const timeoutMs = normalizeWaitTimeoutMs(options.timeout);
      const wakeAt = new Date(Date.now() + timeoutMs);

      if (existing) {
        if (existing.wakeAt && existing.wakeAt <= new Date()) {
          await this.#db.update("workflow_step", existing.id, (b) =>
            b.set({
              status: "errored",
              errorName: "WaitForEventTimeoutError",
              errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
              updatedAt: new Date(),
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
            updatedAt: new Date(),
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

      throw new WorkflowSuspend("wake", wakeAt);
    } finally {
      this.#endStep(name);
    }
  }

  async #sleepUntil(name: string, wakeAt: Date): Promise<void> {
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
        if (existing.type !== "sleep") {
          throw new Error("STEP_TYPE_MISMATCH");
        }
        if (existing.status === "completed") {
          return;
        }
        if (existing.wakeAt && existing.wakeAt <= new Date()) {
          await this.#db.update("workflow_step", existing.id, (b) =>
            b.set({ status: "completed", updatedAt: new Date() }),
          );
          return;
        }
        await this.#db.update("workflow_step", existing.id, (b) =>
          b.set({
            status: "waiting",
            wakeAt,
            updatedAt: new Date(),
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
  }

  async #runWithTimeout<T>(callback: () => Promise<T> | T, timeoutMs: number | null): Promise<T> {
    if (!timeoutMs) {
      return await callback();
    }

    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise<T>((_, reject) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          reject(new Error("STEP_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  }
}

export function createWorkflowsRunner(runnerOptions: WorkflowsRunnerOptions): WorkflowsRunner {
  const workflowsByName = new Map<string, WorkflowsRegistry[keyof WorkflowsRegistry]>();
  for (const entry of Object.values(runnerOptions.workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const runnerId = runnerOptions.runnerId ?? crypto.randomUUID();
  const leaseMs = runnerOptions.leaseMs ?? DEFAULT_LEASE_MS;

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
      return null;
    }

    if (instance.runNumber !== task.runNumber) {
      return null;
    }

    if (isTerminalStatus(instance.status) || isPausedStatus(instance.status)) {
      return null;
    }

    if (task.status !== "pending") {
      return null;
    }

    if (task.lockedUntil && task.lockedUntil > now) {
      return null;
    }

    const uow = runnerOptions.db.createUnitOfWork("workflow-task-claim");
    const typed = uow.forSchema(workflowsSchema);
    typed.update("workflow_task", task.id, (b) => {
      const builder = b.set({
        status: "processing",
        lockOwner: runnerId,
        lockedUntil: new Date(now.getTime() + leaseMs),
        updatedAt: new Date(),
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
  ) => {
    const current = await runnerOptions.db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(
          eb("workflowName", "=", instance.workflowName),
          eb("instanceId", "=", instance.instanceId),
        ),
      ),
    );

    if (!current) {
      return;
    }

    const { id: _ignoredId, ...safeUpdate } = update as WorkflowInstanceRecord;

    const uow = runnerOptions.db.createUnitOfWork("workflow-instance-update");
    const typed = uow.forSchema(workflowsSchema);
    typed.update("workflow_instance", current.id, (b) => {
      const builder = b.set({
        ...safeUpdate,
        status,
        updatedAt: new Date(),
      });
      if (current.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });
    await uow.executeMutations();
  };

  const scheduleTask = async (
    task: WorkflowTaskRecord,
    kind: "wake" | "retry" | "run",
    runAt: Date,
  ) => {
    await runnerOptions.db.update("workflow_task", task.id, (b) =>
      b.set({
        kind,
        runAt,
        status: "pending",
        attempts: 0,
        lastError: null,
        lockOwner: null,
        lockedUntil: null,
        updatedAt: new Date(),
      }),
    );
  };

  const completeTask = async (task: WorkflowTaskRecord) => {
    await runnerOptions.db.delete("workflow_task", task.id);
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
      await setInstanceStatus(instance, "errored", {
        errorName: "WorkflowNotFound",
        errorMessage: "WORKFLOW_NOT_FOUND",
        completedAt: new Date(),
      });
      await completeTask(task);
      return 0;
    }

    if (instance.status !== "running") {
      await setInstanceStatus(instance, "running", {
        startedAt: instance.startedAt ?? new Date(),
      });
    }

    const workflow = new workflowEntry.workflow() as WorkflowEntrypoint<unknown, unknown>;
    workflow.workflows = {};

    const event: WorkflowEvent<unknown> = {
      payload: instance.params ?? {},
      timestamp: instance.createdAt,
      instanceId: instance.instanceId,
    };

    const step = new RunnerStep({
      db: runnerOptions.db,
      workflowName: instance.workflowName,
      instanceId: instance.instanceId,
      runNumber: instance.runNumber,
      maxSteps,
    });

    try {
      const output = await workflow.run(event, step);
      await setInstanceStatus(instance, "complete", {
        output: output ?? null,
        errorName: null,
        errorMessage: null,
        completedAt: new Date(),
        pauseRequested: false,
      });
      await completeTask(task);
      return 1;
    } catch (err) {
      if (err instanceof WorkflowSuspend) {
        await setInstanceStatus(instance, "waiting", {
          pauseRequested: false,
        });
        await scheduleTask(task, err.kind, err.runAt);
        return 1;
      }

      const error = err as Error;
      await setInstanceStatus(instance, "errored", {
        errorName: error.name ?? "Error",
        errorMessage: error.message ?? "",
        completedAt: new Date(),
        pauseRequested: false,
      });
      await completeTask(task);
      return 1;
    }
  };

  return {
    async tick(tickOptions: RunnerTickOptions = {}) {
      const now = new Date();
      const maxInstances = tickOptions.maxInstances ?? DEFAULT_MAX_INSTANCES;
      const maxSteps = tickOptions.maxSteps ?? DEFAULT_MAX_STEPS;

      const tasks = await runnerOptions.db.find("workflow_task", (b) =>
        b
          .whereIndex("idx_workflow_task_status_runAt", (eb) =>
            eb.and(eb("status", "=", "pending"), eb("runAt", "<=", now)),
          )
          .orderByIndex("idx_workflow_task_status_runAt", "asc")
          .pageSize(maxInstances * 3),
      );

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
