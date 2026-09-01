import { DurableHooksLogger } from "../../hooks/durable-hooks-logger";
import type {
  DurableHooksErrorObserver,
  DurableHooksProcessor,
} from "../../hooks/durable-hooks-processor";
import type { HookNotifyContext, HookNotifySource } from "../../hooks/hooks";

type AlarmStorage = {
  getAlarm?: () => Promise<number | null>;
  setAlarm?: (timestamp: number | Date) => Promise<void>;
  deleteAlarm?: () => Promise<void>;
};

export type DurableHooksDispatcherDurableObjectState = {
  readonly storage: AlarmStorage;
  /** Allows in-memory runtimes to drain hook work that intentionally outlives an alarm. */
  setBackgroundDrain?: (drain: (() => Promise<void>) | null) => void;
};

export type DurableHooksDispatcherDurableObjectHandler = {
  fetch?: (request: Request) => Promise<Response>;
  /** Reconciles the initial durable hook alarm before the hosted runtime is exposed. */
  initialize?: () => Promise<void>;
  /** Resolves after the durable hook alarm has been reconciled for newly committed work. */
  notify?: (context: HookNotifyContext) => Promise<void>;
  /** Owns claimed durable hook processing and follow-up alarm reconciliation. */
  alarm?: () => Promise<void>;
  drain?: () => Promise<void>;
};

export type DurableHooksDispatcherDurableObjectFactory<TEnv = unknown> = (
  state: DurableHooksDispatcherDurableObjectState,
  env: TEnv,
) => DurableHooksDispatcherDurableObjectHandler;

export type DurableHooksDispatcherDurableObjectOptions<TEnv = unknown> = {
  createProcessor: (context: {
    state: DurableHooksDispatcherDurableObjectState;
    env: TEnv;
  }) => DurableHooksProcessor;
  onProcessError?: DurableHooksErrorObserver;
};

export function createDurableHooksDispatcherDurableObject<TEnv>(
  options: DurableHooksDispatcherDurableObjectOptions<TEnv>,
): DurableHooksDispatcherDurableObjectFactory<TEnv> {
  return (state, env) => {
    const processor = options.createProcessor({ state, env });
    const onProcessError =
      options.onProcessError ??
      ((error: unknown) => {
        DurableHooksLogger.error("Durable hooks dispatcher error", {
          namespace: processor.namespace,
          fields: { error: DurableHooksLogger.toErrorMessage(error) },
        });
      });
    state.setBackgroundDrain?.(async () => {
      await processor.drain();
    });

    const reportProcessError = async (error: unknown): Promise<void> => {
      try {
        await onProcessError(error);
      } catch (callbackError) {
        DurableHooksLogger.error("Durable hooks dispatcher onProcessError callback failed", {
          namespace: processor.namespace,
          fields: { error: DurableHooksLogger.toErrorMessage(callbackError) },
        });
      }
    };
    const rawGetAlarm = state.storage.getAlarm;
    const rawSetAlarm = state.storage.setAlarm;
    const rawDeleteAlarm = state.storage.deleteAlarm;

    if (!rawSetAlarm) {
      throw new Error(
        "Durable hooks dispatcher requires state.storage.setAlarm to schedule alarms.",
      );
    }
    const getAlarm = rawGetAlarm?.bind(state.storage);
    const setAlarm = rawSetAlarm.bind(state.storage);
    const deleteAlarm = rawDeleteAlarm?.bind(state.storage);

    let processing = false;
    let queued = false;
    let currentPromise: Promise<void> | undefined;
    let alarmRefreshQueued = false;
    let alarmRefreshPromise: Promise<void> | undefined;
    let latestAlarmRefreshSource: HookNotifySource = "request";
    let scheduledHookAlarm: number | null = null;

    const runProcess = () => {
      if (processing) {
        queued = true;
        return currentPromise ?? Promise.resolve();
      }

      processing = true;
      currentPromise = (async () => {
        try {
          do {
            queued = false;
            try {
              const startedAt = Date.now();
              DurableHooksLogger.debug("Durable hooks alarm start", {
                namespace: processor.namespace,
              });
              const run = await processor.processDue();
              try {
                await run.completion;
              } catch (error) {
                DurableHooksLogger.error("Durable hooks run failed", {
                  namespace: processor.namespace,
                  fields: { error: DurableHooksLogger.toErrorMessage(error) },
                });
                await reportProcessError(error);
              }
              DurableHooksLogger.debug("Durable hooks alarm processed", {
                namespace: processor.namespace,
                fields: {
                  claimed: run.claimedCount,
                  ms: Date.now() - startedAt,
                },
              });
            } catch (error) {
              DurableHooksLogger.error("Durable hooks alarm failed", {
                namespace: processor.namespace,
                fields: { error: DurableHooksLogger.toErrorMessage(error) },
              });
              await reportProcessError(error);
            }
          } while (queued);
        } finally {
          processing = false;
          currentPromise = undefined;
        }
      })();

      return currentPromise;
    };

    const scheduleNextAlarm = async (source: HookNotifySource) => {
      DurableHooksLogger.debug("Durable hooks alarm schedule requested", {
        namespace: processor.namespace,
        fields: {
          source,
        },
      });
      const nextWakeAt = await processor.getNextWakeAt();
      if (!nextWakeAt) {
        const existingAlarm = await getAlarm?.();
        if (existingAlarm !== null && existingAlarm === scheduledHookAlarm) {
          await deleteAlarm?.();
          scheduledHookAlarm = null;
        }
        DurableHooksLogger.debug("Durable hooks alarm idle", {
          namespace: processor.namespace,
          fields: {
            source,
          },
        });
        return;
      }

      const now = Date.now();
      const scheduledAt = new Date(Math.max(nextWakeAt.getTime(), now));
      const existingAlarm = await getAlarm?.();
      if (
        existingAlarm === undefined ||
        existingAlarm === null ||
        existingAlarm > scheduledAt.getTime()
      ) {
        await setAlarm(scheduledAt);
        scheduledHookAlarm = scheduledAt.getTime();
      }
      DurableHooksLogger.debug("Durable hooks alarm scheduled", {
        namespace: processor.namespace,
        fields: {
          source,
          nextWakeAt: nextWakeAt.toISOString(),
          scheduledAt: scheduledAt.toISOString(),
        },
      });
    };

    const refreshAlarm = (source: HookNotifySource): Promise<void> => {
      latestAlarmRefreshSource = source;
      if (alarmRefreshPromise) {
        alarmRefreshQueued = true;
        return alarmRefreshPromise;
      }

      alarmRefreshPromise = (async () => {
        do {
          alarmRefreshQueued = false;
          await scheduleNextAlarm(latestAlarmRefreshSource);
        } while (alarmRefreshQueued);
      })().finally(() => {
        alarmRefreshPromise = undefined;
      });

      return alarmRefreshPromise;
    };

    const reconcileHookAlarm = async (source: HookNotifySource): Promise<void> => {
      try {
        await refreshAlarm(source);
      } catch (error) {
        DurableHooksLogger.error("Durable hooks alarm schedule failed", {
          namespace: processor.namespace,
          fields: { error: DurableHooksLogger.toErrorMessage(error) },
        });
        await reportProcessError(error);
        throw error;
      }
    };

    return {
      initialize: async () => {
        DurableHooksLogger.debug("Durable hooks dispatcher init", {
          namespace: processor.namespace,
        });
        await reconcileHookAlarm("alarm");
      },
      notify: async (context) => {
        await reconcileHookAlarm(context.source);
      },
      alarm: async () => {
        await runProcess();
        await reconcileHookAlarm("alarm");
      },
      drain: async () => {
        await processor.drain();
      },
    };
  };
}
