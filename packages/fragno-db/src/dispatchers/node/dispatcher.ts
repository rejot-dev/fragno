import { DurableHooksLogger } from "../../hooks/durable-hooks-logger";
import type { DurableHooksProcessor } from "../../hooks/durable-hooks-processor";
import type { HookNotifyContext } from "../../hooks/hooks";

export type DurableHooksDispatcher = {
  notify: (context: HookNotifyContext) => void;
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
      DurableHooksLogger.error("Durable hooks dispatcher error", {
        namespace: options.processor.namespace,
        fields: { error: DurableHooksLogger.toErrorMessage(error) },
      });
    });
  let timer: ReturnType<typeof setInterval> | undefined;
  let processing = false;
  let queued = false;
  let continueAfterCompletionQueued = false;
  let notifyQueued = false;
  let currentPromise: Promise<void> | undefined;
  const activeCompletions = new Set<Promise<number>>();

  function observeCompletion(completion: Promise<number>, continueAfterCompletion: boolean): void {
    const trackedCompletion = completion.finally(() => {
      activeCompletions.delete(trackedCompletion);
      if (continueAfterCompletion) {
        void runProcess(true);
      }
    });
    activeCompletions.add(trackedCompletion);
    void trackedCompletion.catch(onError);
  }

  function runProcess(continueAfterCompletion = false): Promise<void> {
    if (continueAfterCompletion) {
      continueAfterCompletionQueued = true;
    }
    if (processing) {
      queued = true;
      return currentPromise ?? Promise.resolve();
    }

    processing = true;
    currentPromise = (async () => {
      do {
        queued = false;
        const shouldContinueAfterCompletion = continueAfterCompletionQueued;
        continueAfterCompletionQueued = false;
        try {
          const run = await options.processor.processDue();
          observeCompletion(run.completion, shouldContinueAfterCompletion && run.claimedCount > 0);
        } catch (error) {
          onError(error);
        }
      } while (queued);
      processing = false;
    })();

    return currentPromise;
  }

  const poll = async () => {
    try {
      const nextWakeAt = await options.processor.getNextWakeAt();
      if (!nextWakeAt) {
        return;
      }
      if (Date.now() >= nextWakeAt.getTime()) {
        await runProcess(true);
      }
    } catch (error) {
      onError(error);
    }
  };

  return {
    notify: (_context) => {
      if (notifyQueued) {
        return;
      }
      notifyQueued = true;
      setTimeout(() => {
        notifyQueued = false;
        void runProcess(true);
      }, 0);
    },
    wake: async () => {
      while (true) {
        await runProcess();
        if (activeCompletions.size === 0) {
          return;
        }
        await Promise.all(activeCompletions);
      }
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
