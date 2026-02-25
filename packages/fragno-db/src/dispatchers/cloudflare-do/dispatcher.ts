import type { DurableHooksProcessor } from "../../hooks/durable-hooks-processor";

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
        console.error("Durable hooks dispatcher error", error);
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
            await processor.process();
          } catch (error) {
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
        return;
      }

      const now = Date.now();
      const scheduledAt = new Date(Math.max(nextWakeAt.getTime(), now));
      await setAlarm(scheduledAt);
    };

    void scheduleNextAlarm().catch((error) => {
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
