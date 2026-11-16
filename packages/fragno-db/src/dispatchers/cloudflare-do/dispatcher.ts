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
    // The earliest due time announced by notifications that waited for a running refresh.
    let queuedDueAt: number | null = null;
    let alarmRefreshPromise: Promise<void> | undefined;
    let latestAlarmRefreshSource: HookNotifySource = "request";
    // When the next hook is due: read from the database, then moved earlier by each hook announced
    // since. Notifications compare the alarm against it instead of reading the hooks every request.
    // Processing changes hooks in ways only the database knows, so processing forgets it.
    let hookSchedule: { known: false } | { known: true; nextWakeAt: number | null } = {
      known: false,
    };
    // Counts processing starts and ends, so a read that overlapped one does not store what it read.
    let hookScheduleGeneration = 0;
    const forgetHookSchedule = () => {
      hookScheduleGeneration += 1;
      hookSchedule = { known: false };
    };
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

    const scheduleAlarmBy = async (nextWakeAt: number, source: HookNotifySource) => {
      const now = Date.now();
      const scheduledAt = new Date(Math.max(nextWakeAt, now));
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
          nextWakeAt: new Date(nextWakeAt).toISOString(),
          scheduledAt: scheduledAt.toISOString(),
        },
      });
    };

    const scheduleNextAlarm = async (source: HookNotifySource) => {
      DurableHooksLogger.debug("Durable hooks alarm schedule requested", {
        namespace: processor.namespace,
        fields: {
          source,
        },
      });
      const generation = hookScheduleGeneration;
      const { nextWakeAt, complete } = await processor.getNextWakeAt();
      // A fragment that failed its read may hold due hooks: the schedule becomes unknown, so the
      // next notification reads again, and the alarm stays, as those hooks may be what it is for.
      if (!complete) {
        forgetHookSchedule();
      } else if (generation === hookScheduleGeneration) {
        hookSchedule = { known: true, nextWakeAt: nextWakeAt?.getTime() ?? null };
      }
      if (!nextWakeAt) {
        if (!complete) {
          return;
        }
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

      await scheduleAlarmBy(nextWakeAt.getTime(), source);
    };

    // A known schedule wakes no later than a hook announced due at `dueAt`.
    const recordAnnouncedHook = (dueAt: number) => {
      if (hookSchedule.known) {
        const nextWakeAt = hookSchedule.nextWakeAt;
        hookSchedule = {
          known: true,
          nextWakeAt: nextWakeAt === null ? dueAt : Math.min(nextWakeAt, dueAt),
        };
      }
    };

    const checkAlarm = async (source: HookNotifySource, dueAt: Date | null) => {
      if (dueAt) {
        recordAnnouncedHook(dueAt.getTime());
      }
      if (!hookSchedule.known) {
        await scheduleNextAlarm(source);
        return;
      }
      // Without due hooks, the dispatcher needs no alarm; the read that found none deleted its own.
      if (hookSchedule.nextWakeAt !== null) {
        await scheduleAlarmBy(hookSchedule.nextWakeAt, source);
      }
    };

    const refreshAlarm = (source: HookNotifySource, dueAt: Date | null): Promise<void> => {
      latestAlarmRefreshSource = source;
      if (alarmRefreshPromise) {
        // The running refresh may have read the hooks before this notification's were committed.
        alarmRefreshQueued = true;
        if (dueAt) {
          queuedDueAt =
            queuedDueAt === null ? dueAt.getTime() : Math.min(queuedDueAt, dueAt.getTime());
        }
        return alarmRefreshPromise;
      }

      alarmRefreshPromise = (async () => {
        await checkAlarm(source, dueAt);
        while (alarmRefreshQueued) {
          alarmRefreshQueued = false;
          const announcedDueAt = queuedDueAt;
          queuedDueAt = null;
          // Before the read, which may fail or miss a fragment: the announced hooks wake regardless.
          if (announcedDueAt !== null) {
            recordAnnouncedHook(announcedDueAt);
            await scheduleAlarmBy(announcedDueAt, latestAlarmRefreshSource);
          }
          await scheduleNextAlarm(latestAlarmRefreshSource);
        }
      })().finally(() => {
        alarmRefreshPromise = undefined;
      });

      return alarmRefreshPromise;
    };

    const reconcileHookAlarm = async (
      source: HookNotifySource,
      dueAt: Date | null,
    ): Promise<void> => {
      try {
        await refreshAlarm(source, dueAt);
      } catch (error) {
        DurableHooksLogger.error("Durable hooks alarm schedule failed", {
          namespace: processor.namespace,
          fields: { error: DurableHooksLogger.toErrorMessage(error) },
        });
        await reportProcessError(error);
        throw error;
      }
    };

    const drain = async () => {
      forgetHookSchedule();
      try {
        await processor.drain();
      } finally {
        forgetHookSchedule();
      }
    };
    state.setBackgroundDrain?.(drain);

    return {
      initialize: async () => {
        DurableHooksLogger.debug("Durable hooks dispatcher init", {
          namespace: processor.namespace,
        });
        await reconcileHookAlarm("alarm", null);
      },
      notify: async (context) => {
        await reconcileHookAlarm(context.source, context.dueAt);
      },
      alarm: async () => {
        activeAlarmHandlers += 1;
        try {
          forgetHookSchedule();
          try {
            await runProcess();
          } finally {
            forgetHookSchedule();
          }
          await reconcileHookAlarm("alarm", null);
        } finally {
          activeAlarmHandlers -= 1;
        }
      },
      drain,
    };
  };
}
