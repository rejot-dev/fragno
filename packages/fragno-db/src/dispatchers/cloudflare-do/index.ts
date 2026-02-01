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
            options.onProcessError?.(error);
          }
        } while (queued);
        processing = false;
      })();

      return currentPromise;
    };

    const scheduleNextAlarm = async () => {
      if (!state.storage.setAlarm) {
        return;
      }

      const nextWakeAt = await processor.getNextWakeAt();
      if (!nextWakeAt) {
        await state.storage.deleteAlarm?.();
        return;
      }

      const now = Date.now();
      const scheduledAt = new Date(Math.max(nextWakeAt.getTime(), now));
      await state.storage.setAlarm(scheduledAt);
    };

    void scheduleNextAlarm().catch((error) => {
      options.onProcessError?.(error);
    });

    return {
      alarm: async () => {
        try {
          await runProcess();
          await scheduleNextAlarm();
        } catch (error) {
          options.onProcessError?.(error);
        }
      },
    };
  };
}
