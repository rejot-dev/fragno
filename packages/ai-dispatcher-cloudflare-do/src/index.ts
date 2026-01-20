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
  aiFragmentDefinition,
  aiRoutesFactory,
  aiSchema,
  createAiRunner,
  type AiDispatcher,
  type AiFragmentConfig,
  type AiRunnerTickOptions,
  type AiRunnerTickResult,
} from "@fragno-dev/fragment-ai";

export type AiDispatcherDurableObjectState = DispatcherDurableObjectState;
export type AiDispatcherDurableObjectHandler = DispatcherDurableObjectHandler;
export type AiDispatcherDurableObjectFactory<TEnv = unknown> = DispatcherDurableObjectFactory<TEnv>;

export type AiDispatcherDurableObjectOptions<TEnv = unknown> = {
  namespace?: string;
  runnerId?: string;
  tickOptions?: AiRunnerTickOptions;
  enableRunnerTick?: boolean;
  fragmentConfig?: Omit<AiFragmentConfig, "runner" | "dispatcher">;
  createAdapter?: (context: {
    state: AiDispatcherDurableObjectState;
    env: TEnv;
  }) => DatabaseAdapter<unknown>;
  migrateOnStartup?: boolean;
  onTickError?: (error: unknown) => void;
  onMigrationError?: (error: unknown) => void;
};

type AiRunNextAttempt = { nextAttemptAt: Date | null };

type AiWebhookEventAttempt = {
  nextAttemptAt: Date | null;
};

const getNextAiWakeAt = async (
  db: SimpleQueryInterface<typeof aiSchema, unknown>,
): Promise<Date | null> => {
  const now = new Date();
  const readyRun = await db.findFirst("ai_run", (b) =>
    b
      .whereIndex("idx_ai_run_status_nextAttemptAt_updatedAt", (eb) =>
        eb.and(
          eb("status", "=", "queued"),
          eb.or(eb.isNull("nextAttemptAt"), eb("nextAttemptAt", "<=", now)),
        ),
      )
      .orderByIndex("idx_ai_run_status_nextAttemptAt_updatedAt", "asc"),
  );

  if (readyRun) {
    return now;
  }

  const nextRun = await db.findFirst("ai_run", (b) =>
    b
      .whereIndex("idx_ai_run_status_nextAttemptAt_updatedAt", (eb) =>
        eb.and(eb("status", "=", "queued"), eb("nextAttemptAt", ">", now)),
      )
      .orderByIndex("idx_ai_run_status_nextAttemptAt_updatedAt", "asc"),
  );

  const nextRunAt = (nextRun as AiRunNextAttempt | null)?.nextAttemptAt ?? null;

  const webhookEvents = (await db.find("ai_openai_webhook_event", (b) =>
    b
      .whereIndex("idx_ai_openai_webhook_event_processedAt", (eb) => eb.isNull("processedAt"))
      .orderByIndex("idx_ai_openai_webhook_event_processedAt", "asc")
      .pageSize(50),
  )) as AiWebhookEventAttempt[];

  let nextWebhookAt: Date | null = null;
  for (const event of webhookEvents) {
    if (!event.nextAttemptAt || event.nextAttemptAt <= now) {
      return now;
    }

    if (!nextWebhookAt || event.nextAttemptAt < nextWebhookAt) {
      nextWebhookAt = event.nextAttemptAt;
    }
  }

  const nextWakeAt = [nextRunAt, nextWebhookAt].filter(
    (value): value is Date => value instanceof Date,
  );

  if (nextWakeAt.length === 0) {
    return null;
  }

  const minNextWakeAt = Math.min(...nextWakeAt.map((value) => value.getTime()));
  return new Date(minNextWakeAt);
};

export function createAiDispatcherDurableObject<TEnv = unknown>(
  options: AiDispatcherDurableObjectOptions<TEnv>,
): AiDispatcherDurableObjectFactory<TEnv> {
  return (state, env) => {
    const namespace = options.namespace ?? "ai";
    const createAdapter =
      options.createAdapter ??
      ((context: { state: AiDispatcherDurableObjectState }) => {
        const dialect = new DurableObjectDialect({
          ctx: context.state,
        });
        return new DrizzleAdapter({
          dialect,
          driverConfig: new CloudflareDurableObjectsDriverConfig(),
        }) as DatabaseAdapter<unknown>;
      });

    const adapter = createAdapter({ state, env });
    const db = adapter.createQueryEngine(aiSchema, namespace);

    const baseFragmentConfig: AiFragmentConfig = {
      ...options.fragmentConfig,
      sessionId: options.fragmentConfig?.sessionId ?? options.runnerId,
    };

    const runner = createAiRunner({ db, config: baseFragmentConfig });
    const defaultTickOptions = options.tickOptions ?? {};

    const runtime = new DispatcherDurableObjectRuntime<AiRunnerTickOptions, AiRunnerTickResult>({
      state,
      tick: (tickOptions) => runner.tick(tickOptions),
      tickOptions: defaultTickOptions,
      queuedResult: { processedRuns: 0, processedWebhookEvents: 0 },
      getNextWakeAt: () => getNextAiWakeAt(db),
      onTickError: options.onTickError,
    });

    const runnerFacade = {
      tick: (tickOptions?: AiRunnerTickOptions) => runtime.wake(tickOptions ?? defaultTickOptions),
    };

    const dispatcher: AiDispatcher = {
      wake: (_payload) => {
        void runtime.wake(defaultTickOptions);
      },
    };

    const fragmentConfig: AiFragmentConfig = {
      ...baseFragmentConfig,
      enableRunnerTick: options.enableRunnerTick ?? true,
      runner: {
        ...baseFragmentConfig.runner,
        tick: (tickOptions) => runnerFacade.tick(tickOptions),
      },
      dispatcher,
    };

    const fragment = instantiate(aiFragmentDefinition)
      .withConfig(fragmentConfig)
      .withRoutes([aiRoutesFactory])
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
          console.error("AI migration failed", error);
        });
      }
    }

    return {
      fetch: (request) => fragmentHandler(request),
      alarm: () => runtime.alarm(),
    };
  };
}
