import { instantiate } from "@fragno-dev/core";
import {
  DispatcherDurableObjectRuntime,
  type DispatcherDurableObjectFactory,
  type DispatcherDurableObjectHandler,
  type DispatcherDurableObjectState,
} from "@fragno-dev/dispatcher-cloudflare-do";
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

export type WorkflowsDispatcherDurableObjectState = DispatcherDurableObjectState;
export type WorkflowsDispatcherDurableObjectHandler = DispatcherDurableObjectHandler;
export type WorkflowsDispatcherDurableObjectFactory<TEnv = unknown> =
  DispatcherDurableObjectFactory<TEnv>;

export type WorkflowsDispatcherDurableObjectOptions<TEnv = unknown> = {
  workflows: WorkflowsRegistry;
  namespace?: string;
  runnerId?: string;
  leaseMs?: number;
  tickOptions?: RunnerTickOptions;
  enableRunnerTick?: boolean;
  fragmentConfig?: Omit<WorkflowsFragmentConfig, "workflows" | "runner" | "dispatcher">;
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

const getNextWorkflowsWakeAt = async (
  db: SimpleQueryInterface<typeof workflowsSchema, unknown>,
): Promise<Date | null> => {
  const nextPending = await db.findFirst("workflow_task", (b) =>
    b
      .whereIndex("idx_workflow_task_status_runAt", (eb) =>
        eb.and(eb("status", "=", "pending"), eb("runAt", ">=", new Date(0))),
      )
      .orderByIndex("idx_workflow_task_status_runAt", "asc"),
  );
  const nextLocked = await db.findFirst("workflow_task", (b) =>
    b
      .whereIndex("idx_workflow_task_status_lockedUntil", (eb) =>
        eb.and(eb("status", "=", "processing"), eb("lockedUntil", ">=", new Date(0))),
      )
      .orderByIndex("idx_workflow_task_status_lockedUntil", "asc"),
  );

  const nextRunAt = (nextPending as WorkflowTaskRunAt | null)?.runAt ?? null;
  const nextLockedUntil = (nextLocked as WorkflowTaskLocked | null)?.lockedUntil ?? null;
  const nextWake = [nextRunAt, nextLockedUntil].filter(
    (value): value is Date => value instanceof Date,
  );

  if (nextWake.length === 0) {
    return null;
  }

  const minNextWake = Math.min(...nextWake.map((value) => value.getTime()));
  return new Date(minNextWake);
};

export function createWorkflowsDispatcherDurableObject<TEnv = unknown>(
  options: WorkflowsDispatcherDurableObjectOptions<TEnv>,
): WorkflowsDispatcherDurableObjectFactory<TEnv> {
  return (state, env) => {
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

    const adapter = createAdapter({ state, env });
    const db = adapter.createQueryEngine(workflowsSchema, namespace);

    const runner = createWorkflowsRunner({
      db,
      workflows: options.workflows,
      runnerId: options.runnerId ?? state.id.toString(),
      leaseMs: options.leaseMs,
    });

    const defaultTickOptions = options.tickOptions ?? {};

    const runtime = new DispatcherDurableObjectRuntime<RunnerTickOptions, number>({
      state,
      tick: (tickOptions) => runner.tick(tickOptions),
      tickOptions: defaultTickOptions,
      queuedResult: 0,
      getNextWakeAt: () => getNextWorkflowsWakeAt(db),
      onTickError: options.onTickError,
    });

    const runnerFacade: WorkflowsRunner = {
      tick: (tickOptions) => runtime.wake(tickOptions ?? defaultTickOptions),
    };

    const dispatcher = {
      wake: (_payload: WorkflowEnqueuedHookPayload) => {
        void runtime.wake(defaultTickOptions);
      },
    };

    const fragment = instantiate(workflowsFragmentDefinition)
      .withConfig({
        workflows: options.workflows,
        runner: runnerFacade,
        dispatcher,
        enableRunnerTick: options.enableRunnerTick ?? true,
        ...options.fragmentConfig,
      })
      .withRoutes([workflowsRoutesFactory])
      .withOptions({ databaseAdapter: adapter })
      .build();

    const fragmentHandler = (request: Request) => fragment.handler(request);

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

      if (state.blockConcurrencyWhile) {
        state.blockConcurrencyWhile(migrateTask);
      } else {
        void migrateTask().catch((error) => {
          console.error("Workflows migration failed", error);
        });
      }
    }

    return {
      fetch: (request) => fragmentHandler(request),
      alarm: () => runtime.alarm(),
    };
  };
}
