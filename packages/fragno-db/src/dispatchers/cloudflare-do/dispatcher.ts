import type { DurableHooksProcessor } from "../../hooks/durable-hooks-processor";
import { DurableHooksLogger } from "../../hooks/durable-hooks-logger";

type AlarmStorage = {
  setAlarm?: (timestamp: number | Date) => Promise<void>;
  deleteAlarm?: () => Promise<void>;
};

export type DurableHooksDispatcherDurableObjectState = {
  readonly storage: AlarmStorage;
};

export type DurableHooksDispatcherDurableObjectHandler = {
  fetch?: (request: Request) => Promise<Response>;
  alarm?: () => Promise<void>;
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
  onProcessError?: (error: unknown) => void;
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
    const rawSetAlarm = state.storage.setAlarm;
    const rawDeleteAlarm = state.storage.deleteAlarm;

    if (!rawSetAlarm) {
      throw new Error(
        "Durable hooks dispatcher requires state.storage.setAlarm to schedule alarms.",
      );
    }
    const setAlarm = rawSetAlarm.bind(state.storage);
    const deleteAlarm = rawDeleteAlarm?.bind(state.storage);

    let processing = false;
    let queued = false;
    let currentPromise: Promise<void> | undefined;

    const runProcess = () => {
      if (processing) {
        queued = true;
        return currentPromise ?? Promise.resolve();
      }

      processing = true;
      currentPromise = (async () => {
        do {
          queued = false;
          try {
            const startedAt = Date.now();
            DurableHooksLogger.debug("Durable hooks alarm start", {
              namespace: processor.namespace,
            });
            const processed = await processor.process();
            DurableHooksLogger.debug("Durable hooks alarm processed", {
              namespace: processor.namespace,
              fields: {
                processed,
                ms: Date.now() - startedAt,
              },
            });
          } catch (error) {
            DurableHooksLogger.error("Durable hooks alarm failed", {
              namespace: processor.namespace,
              fields: { error: DurableHooksLogger.toErrorMessage(error) },
            });
            onProcessError(error);
          }
        } while (queued);
        processing = false;
      })();

      return currentPromise;
    };

    const scheduleNextAlarm = async () => {
      const nextWakeAt = await processor.getNextWakeAt();
      if (!nextWakeAt) {
        await deleteAlarm?.();
        DurableHooksLogger.debug("Durable hooks alarm cleared", {
          namespace: processor.namespace,
        });
        return;
      }

      const now = Date.now();
      const scheduledAt = new Date(Math.max(nextWakeAt.getTime(), now));
      await setAlarm(scheduledAt);
      DurableHooksLogger.debug("Durable hooks alarm scheduled", {
        namespace: processor.namespace,
        fields: {
          nextWakeAt: nextWakeAt.toISOString(),
          scheduledAt: scheduledAt.toISOString(),
        },
      });
    };

    DurableHooksLogger.debug("Durable hooks dispatcher init", {
      namespace: processor.namespace,
    });
    void scheduleNextAlarm().catch((error) => {
      DurableHooksLogger.error("Durable hooks alarm schedule failed", {
        namespace: processor.namespace,
        fields: { error: DurableHooksLogger.toErrorMessage(error) },
      });
      onProcessError(error);
    });

    return {
      alarm: async () => {
        try {
          await runProcess();
          await scheduleNextAlarm();
        } catch (error) {
          onProcessError(error);
        }
      },
    };
  };
}
