import { defaultFragnoRuntime, instantiate, type FragnoRuntime } from "@fragno-dev/core";
import type { DatabaseAdapter } from "@fragno-dev/db/adapters";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { migrate } from "@fragno-dev/db";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  workflowsSchema,
  type RunnerTickOptions,
  type WorkflowEnqueuedHookPayload,
  type WorkflowsFragmentConfig,
  type WorkflowsRegistry,
  type WorkflowsRunner,
} from "@fragno-dev/fragment-workflows";

type AlarmStorage = {
  setAlarm?: (timestamp: number | Date) => Promise<void>;
  getAlarm?: () => Promise<number | null>;
  deleteAlarm?: () => Promise<void>;
};

type DurableObjectSqlStorageValue = ArrayBuffer | string | number | null;

declare abstract class DurableObjectSqlStorageCursor<
  T extends Record<string, DurableObjectSqlStorageValue>,
> {
  next():
    | {
        done?: false;
        value: T;
      }
    | {
        done: true;
        value?: never;
      };
  toArray(): T[];
  one(): T;
  raw<U extends DurableObjectSqlStorageValue[]>(): IterableIterator<U>;
  columnNames: string[];
  get rowsRead(): number;
  get rowsWritten(): number;
  [Symbol.iterator](): IterableIterator<T>;
}

declare abstract class DurableObjectSqlStorageStatement {}

type DurableObjectSqlStorage = {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    // oxlint-disable-next-line no-explicit-any
    ...bindings: any[]
  ): DurableObjectSqlStorageCursor<T>;
  Cursor: typeof DurableObjectSqlStorageCursor;
  Statement: typeof DurableObjectSqlStorageStatement;
};

type DurableObjectStorage = AlarmStorage & {
  transaction<T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T>;
  readonly sql: DurableObjectSqlStorage;
};

export type WorkflowsDispatcherDurableObjectState = {
  readonly id: {
    toString(): string;
    equals(other: { toString(): string }): boolean;
    name?: string;
  };
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile?: (callback: () => Promise<void>) => void;
};

export type WorkflowsDispatcherDurableObjectHandler = {
  fetch: (request: Request) => Promise<Response>;
  alarm?: () => Promise<void>;
};

export type WorkflowsDispatcherDurableObjectFactory<TEnv = unknown> = (
  state: WorkflowsDispatcherDurableObjectState,
  env: TEnv,
) => WorkflowsDispatcherDurableObjectHandler;

export type WorkflowsDispatcherDurableObjectOptions<TEnv = unknown> = {
  workflows: WorkflowsRegistry;
  runtime?: FragnoRuntime;
  namespace?: string;
  runnerId?: string;
  leaseMs?: number;
  tickOptions?: RunnerTickOptions;
  enableRunnerTick?: boolean;
  fragmentConfig?: Omit<WorkflowsFragmentConfig, "workflows" | "runner" | "dispatcher" | "runtime">;
  createAdapter?: (context: {
    state: WorkflowsDispatcherDurableObjectState;
    env: TEnv;
  }) => DatabaseAdapter<unknown>;
  migrateOnStartup?: boolean;
  onTickError?: (error: unknown) => void;
  onMigrationError?: (error: unknown) => void;
};

type WorkflowTaskRunAt = { runAt: Date };
type WorkflowTaskLocked = { lockedUntil: Date | null };

type WorkflowsDispatcherDurableObjectRuntimeOptions<TEnv> =
  WorkflowsDispatcherDurableObjectOptions<TEnv> & {
    state: WorkflowsDispatcherDurableObjectState;
    env: TEnv;
  };

class WorkflowsDispatcherDurableObjectRuntime<TEnv> {
  #state: WorkflowsDispatcherDurableObjectState;
  #env: TEnv;
  #runner: WorkflowsRunner;
  #adapter: DatabaseAdapter<unknown>;
  #tickOptions: RunnerTickOptions;
  #tickInFlight = false;
  #tickQueued = false;
  #onTickError?: (error: unknown) => void;
  #fragmentHandler: (request: Request) => Promise<Response>;
  #db: SimpleQueryInterface<typeof workflowsSchema, unknown>;

  constructor(options: WorkflowsDispatcherDurableObjectRuntimeOptions<TEnv>) {
    this.#state = options.state;
    this.#env = options.env;
    this.#tickOptions = options.tickOptions ?? {};
    this.#onTickError = options.onTickError;

    const namespace = options.namespace ?? "workflows";
    const createAdapter =
      options.createAdapter ??
      ((context: { state: WorkflowsDispatcherDurableObjectState }) => {
        const dialect = new DurableObjectDialect({
          ctx: context.state,
        });
        return new DrizzleAdapter({
          dialect,
          driverConfig: new CloudflareDurableObjectsDriverConfig(),
        }) as DatabaseAdapter<unknown>;
      });

    this.#adapter = createAdapter({ state: this.#state, env: this.#env });
    this.#db = this.#adapter.createQueryEngine(workflowsSchema, namespace);
    const runtime = options.runtime ?? defaultFragnoRuntime;

    this.#runner = createWorkflowsRunner({
      db: this.#db,
      workflows: options.workflows,
      runtime,
      runnerId: options.runnerId ?? this.#state.id.toString(),
      leaseMs: options.leaseMs,
    });

    const runnerFacade: WorkflowsRunner = {
      tick: (tickOptions) => this.#queueTick(tickOptions),
    };

    const dispatcher = {
      wake: (payload: WorkflowEnqueuedHookPayload) => this.#wake(payload),
    };

    const fragment = instantiate(workflowsFragmentDefinition)
      .withConfig({
        workflows: options.workflows,
        runner: runnerFacade,
        dispatcher,
        enableRunnerTick: options.enableRunnerTick ?? true,
        runtime,
        ...options.fragmentConfig,
      })
      .withRoutes([workflowsRoutesFactory])
      .withOptions({ databaseAdapter: this.#adapter })
      .build();

    this.#fragmentHandler = (request: Request) => fragment.handler(request);

    if (options.migrateOnStartup ?? true) {
      const migrateTask = async () => {
        try {
          await migrate(fragment);
        } catch (error) {
          options.onMigrationError?.(error);
          if (!options.onMigrationError) {
            throw error;
          }
        }
      };

      if (this.#state.blockConcurrencyWhile) {
        this.#state.blockConcurrencyWhile(migrateTask);
      } else {
        void migrateTask().catch((error) => {
          console.error("Workflows migration failed", error);
        });
      }
    }
  }

  async #wake(_payload: WorkflowEnqueuedHookPayload) {
    await this.#queueTick();
  }

  async #queueTick(tickOptions?: RunnerTickOptions): Promise<number> {
    if (this.#tickInFlight) {
      this.#tickQueued = true;
      return 0;
    }

    this.#tickInFlight = true;
    let processed = 0;

    try {
      processed = await this.#runner.tick(tickOptions ?? this.#tickOptions);
    } catch (error) {
      this.#onTickError?.(error);
    } finally {
      await this.#scheduleNextAlarm();
      this.#tickInFlight = false;
    }

    if (this.#tickQueued) {
      this.#tickQueued = false;
      void this.#queueTick(tickOptions);
    }

    return processed;
  }

  async #scheduleNextAlarm() {
    if (!this.#state.storage.setAlarm) {
      return;
    }

    const nextPending = await this.#db.findFirst("workflow_task", (b) =>
      b
        .whereIndex("idx_workflow_task_status_runAt", (eb) =>
          eb.and(eb("status", "=", "pending"), eb("runAt", ">=", new Date(0))),
        )
        .orderByIndex("idx_workflow_task_status_runAt", "asc"),
    );
    const nextLocked = await this.#db.findFirst("workflow_task", (b) =>
      b
        .whereIndex("idx_workflow_task_status_lockedUntil", (eb) =>
          eb.and(eb("status", "=", "processing"), eb("lockedUntil", ">=", new Date(0))),
        )
        .orderByIndex("idx_workflow_task_status_lockedUntil", "asc"),
    );

    const nextRunAt = (nextPending as WorkflowTaskRunAt | null)?.runAt;
    const nextLockedUntil = (nextLocked as WorkflowTaskLocked | null)?.lockedUntil ?? null;
    const nextWake = [nextRunAt, nextLockedUntil].filter(
      (value): value is Date => value instanceof Date,
    );

    if (nextWake.length === 0) {
      if (this.#state.storage.deleteAlarm) {
        await this.#state.storage.deleteAlarm();
      }
      return;
    }

    const minNextWake = Math.min(...nextWake.map((value) => value.getTime()));
    const timestamp = Math.max(minNextWake, Date.now());

    await this.#state.storage.setAlarm(timestamp);
  }

  fetch(request: Request) {
    return this.#fragmentHandler(request);
  }

  async alarm(): Promise<void> {
    await this.#queueTick();
  }
}

export function createWorkflowsDispatcherDurableObject<TEnv = unknown>(
  options: WorkflowsDispatcherDurableObjectOptions<TEnv>,
): WorkflowsDispatcherDurableObjectFactory<TEnv> {
  return (state, env) => {
    const runtime = new WorkflowsDispatcherDurableObjectRuntime({
      ...options,
      state,
      env,
    });

    return {
      fetch: (request) => runtime.fetch(request),
      alarm: () => runtime.alarm(),
    };
  };
}
