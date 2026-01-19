export type DispatcherWake = () => Promise<void> | void;

export interface InProcessDispatcherOptions {
  wake: DispatcherWake;
  pollIntervalMs?: number;
}

export interface InProcessDispatcher {
  wake: DispatcherWake;
  startPolling: () => void;
  stopPolling: () => void;
}

export function createInProcessDispatcher(
  options: InProcessDispatcherOptions,
): InProcessDispatcher {
  let timer: ReturnType<typeof setInterval> | undefined;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;

  return {
    wake: options.wake,
    startPolling: () => {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        Promise.resolve(options.wake()).catch((error) => {
          console.error("Workflows dispatcher wake failed", error);
        });
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
