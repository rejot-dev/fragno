import type { FragnoOutboxCheckpoint } from "./checkpoint";
import type { FragnoOutboxEntry } from "./protocol";
import {
  isFragnoOutboxStreamingTransport,
  type FragnoOutboxStreamingTransport,
} from "./streaming-transport";
import { createFetchFragnoOutboxTransport, type FragnoOutboxTransport } from "./transport";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_INTERVAL_MS = 60_000;
const RETRY_JITTER_RATIO = 0.2;

export type FragnoOutboxConsumer = {
  id: string;
  getCheckpoint(): FragnoOutboxCheckpoint | undefined;
  isInitialized(): boolean;
  prepareSource(adapterIdentity: string): void;
  applyEntry(entry: FragnoOutboxEntry): void;
  markLoading(): void;
  markReady(): void;
  markError(error: unknown): void;
};

export type FragnoOutboxCoordinator = {
  register(consumer: FragnoOutboxConsumer): () => void;
  syncOnce(): Promise<void>;
  dispose(): void;
};

/** Serializable adapter data that can be supplied by an SSR loader. */
export type FragnoOutboxBootstrap = {
  adapterIdentity: string;
};

export type FragnoOutboxCoordinatorOptions = {
  internalUrl: string | URL;
  bootstrap?: FragnoOutboxBootstrap;
  transport?: FragnoOutboxTransport;
  pageSize?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
};

type SynchronizeMode = "always" | "bootstrap";

export function createFragnoOutboxCoordinator(
  options: FragnoOutboxCoordinatorOptions,
): FragnoOutboxCoordinator {
  const transport =
    options.transport ??
    createFetchFragnoOutboxTransport({
      internalUrl: options.internalUrl,
    });
  const streamingTransport = isFragnoOutboxStreamingTransport(transport) ? transport : undefined;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const consumers = new Map<string, FragnoOutboxConsumer>();
  const abortController = new AbortController();
  let adapterIdentity = options.bootstrap?.adapterIdentity;
  let adapterIdentityRequest: Promise<string> | undefined;

  const resolveAdapterIdentity = async (): Promise<string> => {
    if (adapterIdentity !== undefined) {
      return adapterIdentity;
    }

    adapterIdentityRequest ??= transport.getAdapterIdentity({
      signal: abortController.signal,
    });

    try {
      adapterIdentity = await adapterIdentityRequest;
      return adapterIdentity;
    } finally {
      adapterIdentityRequest = undefined;
    }
  };

  const synchronize = serializeOperation(async (mode: SynchronizeMode) => {
    const synchronizedConsumers = [...consumers.values()];

    if (synchronizedConsumers.length === 0) {
      return;
    }

    try {
      for (const consumer of synchronizedConsumers) {
        if (consumers.get(consumer.id) === consumer) {
          consumer.markLoading();
        }
      }

      const resolvedAdapterIdentity = await resolveAdapterIdentity();
      for (const consumer of synchronizedConsumers) {
        if (consumers.get(consumer.id) === consumer) {
          consumer.prepareSource(resolvedAdapterIdentity);
        }
      }

      if (
        mode === "bootstrap" &&
        synchronizedConsumers.every(
          (consumer) => consumers.get(consumer.id) !== consumer || consumer.isInitialized(),
        )
      ) {
        markConsumersReady(synchronizedConsumers, consumers);
        return;
      }

      let afterVersionstamp = findOldestCheckpoint(synchronizedConsumers)?.versionstamp;

      while (
        !abortController.signal.aborted &&
        synchronizedConsumers.some((consumer) => consumers.get(consumer.id) === consumer)
      ) {
        const entries = await transport.list({
          afterVersionstamp,
          limit: pageSize,
          signal: abortController.signal,
        });

        for (const entry of entries) {
          applyEntryToConsumers(entry, synchronizedConsumers, consumers);
          afterVersionstamp = entry.versionstamp;
        }

        if (entries.length < pageSize) {
          markConsumersReady(synchronizedConsumers, consumers);
          return;
        }
      }
    } catch (error) {
      markConsumersError(synchronizedConsumers, consumers, error);
      throw error;
    }
  });

  if (streamingTransport) {
    return createStreamingCoordinator({
      transport: streamingTransport,
      consumers,
      synchronize,
      pageSize,
      pollIntervalMs,
      abortController,
      onError: options.onError,
    });
  }

  let pollTimeout: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;

  const syncOnce = async () => {
    await synchronize("always");
    consecutiveFailures = 0;
  };

  function schedulePoll(delayMs: number): void {
    if (abortController.signal.aborted || consumers.size === 0 || pollTimeout !== undefined) {
      return;
    }

    pollTimeout = setTimeout(() => {
      pollTimeout = undefined;
      synchronizeAndScheduleNextPoll("always");
    }, delayMs);
  }

  function synchronizeAndScheduleNextPoll(mode: SynchronizeMode): void {
    void synchronize(mode).then(
      () => {
        consecutiveFailures = 0;
        schedulePoll(pollIntervalMs);
      },
      (error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }

        consecutiveFailures += 1;
        schedulePoll(calculateRetryDelay(pollIntervalMs, consecutiveFailures));
        options.onError?.(error);
      },
    );
  }

  return {
    register(consumer) {
      assertCanRegister(abortController.signal, consumers, consumer);
      consumers.set(consumer.id, consumer);

      // Persisted collections can render their validated local snapshot before the first poll.
      // Collections without one still bootstrap from the oldest registered checkpoint.
      synchronizeAndScheduleNextPoll("bootstrap");

      return () => {
        if (consumers.get(consumer.id) === consumer) {
          consumers.delete(consumer.id);
        }

        if (consumers.size === 0 && pollTimeout !== undefined) {
          clearTimeout(pollTimeout);
          pollTimeout = undefined;
        }
      };
    },

    syncOnce,

    dispose() {
      abortController.abort();
      if (pollTimeout !== undefined) {
        clearTimeout(pollTimeout);
        pollTimeout = undefined;
      }
      consumers.clear();
    },
  };
}

function createStreamingCoordinator(options: {
  transport: FragnoOutboxStreamingTransport;
  consumers: Map<string, FragnoOutboxConsumer>;
  synchronize(mode: SynchronizeMode): Promise<void>;
  pageSize: number;
  pollIntervalMs: number;
  abortController: AbortController;
  onError?: (error: unknown) => void;
}): FragnoOutboxCoordinator {
  let requestedGeneration = 0;
  let streamLoopRunning = false;
  let activeStreamAbortController: AbortController | undefined;
  let wakeRetry: (() => void) | undefined;
  let consecutiveFailures = 0;
  const catchUpWaiters: Array<{
    generation: number;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];

  const requestRestart = (): number => {
    requestedGeneration += 1;
    activeStreamAbortController?.abort();
    wakeRetry?.();
    startStreamLoop();
    return requestedGeneration;
  };

  const syncOnce = (): Promise<void> => {
    if (options.abortController.signal.aborted) {
      return Promise.reject(new Error("Cannot synchronize a disposed Fragno outbox coordinator."));
    }
    if (options.consumers.size === 0) {
      return Promise.resolve();
    }

    const generation = requestedGeneration + 1;
    const synchronized = new Promise<void>((resolve, reject) => {
      catchUpWaiters.push({ generation, resolve, reject });
    });
    requestRestart();
    return synchronized;
  };

  function startStreamLoop(): void {
    if (
      streamLoopRunning ||
      options.abortController.signal.aborted ||
      options.consumers.size === 0
    ) {
      return;
    }

    streamLoopRunning = true;
    void runStreamLoop().finally(() => {
      streamLoopRunning = false;
      if (!options.abortController.signal.aborted && options.consumers.size > 0) {
        startStreamLoop();
      }
    });
  }

  async function runStreamLoop(): Promise<void> {
    while (!options.abortController.signal.aborted && options.consumers.size > 0) {
      const generation = requestedGeneration;

      try {
        const synchronizeMode = catchUpWaiters.some((waiter) => waiter.generation <= generation)
          ? "always"
          : "bootstrap";
        await options.synchronize(synchronizeMode);
        settleCatchUpWaiters(catchUpWaiters, generation);

        if (generation !== requestedGeneration || options.consumers.size === 0) {
          continue;
        }

        const streamAbortController = new AbortController();
        activeStreamAbortController = streamAbortController;
        const afterVersionstamp = findOldestCheckpoint([
          ...options.consumers.values(),
        ])?.versionstamp;

        try {
          await options.transport.stream({
            afterVersionstamp,
            limit: options.pageSize,
            signal: streamAbortController.signal,
            async onEntry(entry) {
              if (
                streamAbortController.signal.aborted ||
                generation !== requestedGeneration ||
                options.abortController.signal.aborted
              ) {
                return;
              }

              const synchronizedConsumers = [...options.consumers.values()];
              try {
                applyEntryToConsumers(entry, synchronizedConsumers, options.consumers);
                consecutiveFailures = 0;
              } catch (error) {
                markConsumersError(synchronizedConsumers, options.consumers, error);
                throw error;
              }
            },
          });
        } finally {
          if (activeStreamAbortController === streamAbortController) {
            activeStreamAbortController = undefined;
          }
        }

        if (
          options.abortController.signal.aborted ||
          options.consumers.size === 0 ||
          generation !== requestedGeneration
        ) {
          continue;
        }

        throw new Error("Fragno outbox stream closed unexpectedly.");
      } catch (error) {
        if (options.abortController.signal.aborted || options.consumers.size === 0) {
          return;
        }
        if (generation !== requestedGeneration) {
          continue;
        }

        rejectCatchUpWaiters(catchUpWaiters, generation, error);
        markConsumersError([...options.consumers.values()], options.consumers, error);
        options.onError?.(error);
        consecutiveFailures += 1;
        await waitForRetry(
          calculateRetryDelay(options.pollIntervalMs, consecutiveFailures),
          (wake) => {
            wakeRetry = wake;
          },
        );
        wakeRetry = undefined;
      }
    }
  }

  return {
    register(consumer) {
      assertCanRegister(options.abortController.signal, options.consumers, consumer);
      options.consumers.set(consumer.id, consumer);
      requestRestart();

      return () => {
        if (options.consumers.get(consumer.id) !== consumer) {
          return;
        }

        options.consumers.delete(consumer.id);
        requestRestart();
        if (options.consumers.size === 0) {
          rejectAllCatchUpWaiters(
            catchUpWaiters,
            new Error("Fragno outbox synchronization stopped because no consumers remain."),
          );
        }
      };
    },

    syncOnce,

    dispose() {
      options.abortController.abort();
      activeStreamAbortController?.abort();
      wakeRetry?.();
      rejectAllCatchUpWaiters(catchUpWaiters, new Error("Fragno outbox coordinator was disposed."));
      options.consumers.clear();
    },
  };
}

function assertCanRegister(
  signal: AbortSignal,
  consumers: Map<string, FragnoOutboxConsumer>,
  consumer: FragnoOutboxConsumer,
): void {
  if (signal.aborted) {
    throw new Error("Cannot register a consumer with a disposed Fragno outbox coordinator.");
  }
  if (consumers.has(consumer.id)) {
    throw new Error(`Outbox consumer ${consumer.id} is already registered.`);
  }
}

function applyEntryToConsumers(
  entry: FragnoOutboxEntry,
  synchronizedConsumers: FragnoOutboxConsumer[],
  consumers: Map<string, FragnoOutboxConsumer>,
): void {
  for (const consumer of synchronizedConsumers) {
    // A collection can be cleaned up while the transport request is pending.
    if (consumers.get(consumer.id) === consumer) {
      consumer.applyEntry(entry);
    }
  }
}

function markConsumersReady(
  synchronizedConsumers: FragnoOutboxConsumer[],
  consumers: Map<string, FragnoOutboxConsumer>,
): void {
  for (const consumer of synchronizedConsumers) {
    if (consumers.get(consumer.id) === consumer) {
      consumer.markReady();
    }
  }
}

function markConsumersError(
  synchronizedConsumers: FragnoOutboxConsumer[],
  consumers: Map<string, FragnoOutboxConsumer>,
  error: unknown,
): void {
  for (const consumer of synchronizedConsumers) {
    if (consumers.get(consumer.id) === consumer) {
      consumer.markError(error);
    }
  }
}

function settleCatchUpWaiters(
  waiters: Array<{ generation: number; resolve(): void; reject(error: unknown): void }>,
  generation: number,
): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    if (waiters[index].generation <= generation) {
      waiters[index].resolve();
      waiters.splice(index, 1);
    }
  }
}

function rejectCatchUpWaiters(
  waiters: Array<{ generation: number; resolve(): void; reject(error: unknown): void }>,
  generation: number,
  error: unknown,
): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    if (waiters[index].generation <= generation) {
      waiters[index].reject(error);
      waiters.splice(index, 1);
    }
  }
}

function rejectAllCatchUpWaiters(
  waiters: Array<{ generation: number; resolve(): void; reject(error: unknown): void }>,
  error: unknown,
): void {
  for (const waiter of waiters.splice(0)) {
    waiter.reject(error);
  }
}

function waitForRetry(delayMs: number, setWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    setWake(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function findOldestCheckpoint(
  consumers: FragnoOutboxConsumer[],
): FragnoOutboxCheckpoint | undefined {
  let oldest: FragnoOutboxCheckpoint | undefined;

  for (const consumer of consumers) {
    const checkpoint = consumer.getCheckpoint();

    if (!checkpoint) {
      return undefined;
    }

    if (!oldest || checkpoint.versionstamp < oldest.versionstamp) {
      oldest = checkpoint;
    }
  }

  return oldest;
}

function calculateRetryDelay(pollIntervalMs: number, consecutiveFailures: number): number {
  const maximumDelay = Math.max(pollIntervalMs, MAX_RETRY_INTERVAL_MS);
  const exponentialDelay = Math.min(pollIntervalMs * 2 ** (consecutiveFailures - 1), maximumDelay);
  const jitter = exponentialDelay * RETRY_JITTER_RATIO;
  return Math.min(maximumDelay, Math.round(exponentialDelay - jitter + Math.random() * jitter * 2));
}

function serializeOperation<TArgs extends unknown[]>(
  operation: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  let previous = Promise.resolve();

  return (...args) => {
    const current = previous.then(() => operation(...args));
    previous = current.catch(() => {});
    return current;
  };
}
