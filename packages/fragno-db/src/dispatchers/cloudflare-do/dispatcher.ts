import { DurableHooksLogger } from "../../hooks/durable-hooks-logger";
import type {
  DurableHooksErrorObserver,
  DurableHooksProcessor,
} from "../../hooks/durable-hooks-processor";
import type { HookNotifyContext, HookNotifySource } from "../../hooks/hooks";

/**
 * Cloudflare retries a failing alarm for about two and a half minutes. An alarm still reported this
 * long after its time is not going to fire, and keeping it would leave every hook of its object
 * pending, as an alarm that ran out of retries once did.
 */
const LOST_ALARM_AGE_MS = 5 * 60_000;

/**
 * An alarm the Durable Object still reported long after its time, which the dispatcher replaced. The
 * object has one alarm, so a lost alarm stalls every fragment whose hooks it hosts.
 */
export type DurableHooksLostAlarm = {
  /** When the lost alarm was due. */
  scheduledAt: Date;
};

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
  /** Called after the dispatcher replaced an alarm that never fired. */
  onLostAlarm?: (alarm: DurableHooksLostAlarm) => void;
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
    const reportLostAlarm = (scheduledAt: Date) => {
      DurableHooksLogger.warn("Durable hooks replaced a lost alarm", {
        namespace: processor.namespace,
        fields: { scheduledAt: scheduledAt.toISOString() },
      });
      try {
        options.onLostAlarm?.({ scheduledAt });
      } catch (callbackError) {
        DurableHooksLogger.error("Durable hooks dispatcher onLostAlarm callback failed", {
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
    // Cloudflare runs one alarm handler at a time and holds back alarms set during it, so while this
    // handler runs, an overdue alarm is waiting rather than lost.
    let activeAlarmHandlers = 0;

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
      const lostAlarm =
        activeAlarmHandlers === 0 &&
        existingAlarm !== undefined &&
        existingAlarm !== null &&
        existingAlarm <= now - LOST_ALARM_AGE_MS;
      if (
        existingAlarm === undefined ||
        existingAlarm === null ||
        existingAlarm > scheduledAt.getTime() ||
        lostAlarm
      ) {
        await setAlarm(scheduledAt);
        // The object shares its alarm with other work, such as an outbox retry. A lost alarm this
        // dispatcher did not schedule is replaced but not claimed, so going idle never deletes it:
        // an extra alarm finds nothing to do, while a deleted one strands its owner's work.
        scheduledHookAlarm =
          lostAlarm && existingAlarm !== scheduledHookAlarm ? null : scheduledAt.getTime();
      }
      if (lostAlarm) {
        reportLostAlarm(new Date(existingAlarm));
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
        activeAlarmHandlers += 1;
        try {
          await runProcess();
          await reconcileHookAlarm("alarm");
        } finally {
          activeAlarmHandlers -= 1;
        }
      },
      drain: async () => {
        await processor.drain();
      },
    };
  };
}
