import type { DurableHooksProcessor } from "../../hooks/durable-hooks-processor";

export type DurableHooksDispatcher = {
  wake: () => Promise<void>;
  drain: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
};

export type DurableHooksDispatcherOptions = {
  processor: DurableHooksProcessor;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export function createDurableHooksDispatcher(
  options: DurableHooksDispatcherOptions,
): DurableHooksDispatcher {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error("Durable hooks dispatcher error", error);
    });
  let timer: ReturnType<typeof setInterval> | undefined;
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
          await options.processor.process();
        } catch (error) {
          onError(error);
        }
      } while (queued);
      processing = false;
    })();

    return currentPromise;
  };

  const poll = async () => {
    try {
      const nextWakeAt = await options.processor.getNextWakeAt();
      if (!nextWakeAt) {
        return;
      }
      if (Date.now() >= nextWakeAt.getTime()) {
        await runProcess();
      }
    } catch (error) {
      onError(error);
    }
  };

  return {
    wake: async () => {
      await runProcess();
    },
    drain: async () => {
      try {
        await options.processor.drain();
      } catch (error) {
        onError(error);
      }
    },
    startPolling: () => {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        void poll();
      }, pollIntervalMs);
    },
    stopPolling: () => {
      if (!timer) {
        return;
      }

      clearInterval(timer);
      timer = undefined;
    },
  };
}
