import type { FragnoOutboxCheckpoint } from "./checkpoint";
import type { FragnoOutboxEntry } from "./protocol";
import { createFetchFragnoOutboxTransport, type FragnoOutboxTransport } from "./transport";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_INTERVAL_MS = 60_000;
const RETRY_JITTER_RATIO = 0.2;

export type FragnoOutboxConsumer = {
  id: string;
  getCheckpoint(): FragnoOutboxCheckpoint | undefined;
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

export type FragnoOutboxCoordinatorOptions = {
  internalUrl: string | URL;
  transport?: FragnoOutboxTransport;
  pageSize?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export function createFragnoOutboxCoordinator(
  options: FragnoOutboxCoordinatorOptions,
): FragnoOutboxCoordinator {
  const transport =
    options.transport ??
    createFetchFragnoOutboxTransport({
      internalUrl: options.internalUrl,
    });
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const consumers = new Map<string, FragnoOutboxConsumer>();
  const abortController = new AbortController();
  let pollTimeout: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;

  const synchronize = serializeOperation(async () => {
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

      const adapterIdentity = await transport.getAdapterIdentity({
        signal: abortController.signal,
      });
      for (const consumer of synchronizedConsumers) {
        if (consumers.get(consumer.id) === consumer) {
          consumer.prepareSource(adapterIdentity);
        }
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
          for (const consumer of synchronizedConsumers) {
            // A collection can be cleaned up while the transport request is pending.
            if (consumers.get(consumer.id) !== consumer) {
              continue;
            }

            consumer.applyEntry(entry);
          }

          afterVersionstamp = entry.versionstamp;
        }

        if (entries.length < pageSize) {
          for (const consumer of synchronizedConsumers) {
            if (consumers.get(consumer.id) === consumer) {
              consumer.markReady();
            }
          }

          return;
        }
      }
    } catch (error) {
      for (const consumer of synchronizedConsumers) {
        if (consumers.get(consumer.id) === consumer) {
          consumer.markError(error);
        }
      }

      throw error;
    }
  });

  const syncOnce = async () => {
    await synchronize();
    consecutiveFailures = 0;
  };

  function schedulePoll(delayMs: number): void {
    if (abortController.signal.aborted || consumers.size === 0 || pollTimeout !== undefined) {
      return;
    }

    pollTimeout = setTimeout(() => {
      pollTimeout = undefined;
      synchronizeAndScheduleNextPoll();
    }, delayMs);
  }

  function synchronizeAndScheduleNextPoll(): void {
    void syncOnce().then(
      () => {
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
      if (abortController.signal.aborted) {
        throw new Error("Cannot register a consumer with a disposed Fragno outbox coordinator.");
      }

      if (consumers.has(consumer.id)) {
        throw new Error(`Outbox consumer ${consumer.id} is already registered.`);
      }

      consumers.set(consumer.id, consumer);

      // A newly registered collection might have an older or empty checkpoint. Re-draining from
      // the oldest checkpoint catches it up while existing collections skip committed entries.
      synchronizeAndScheduleNextPoll();

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

function serializeOperation(operation: () => Promise<void>): () => Promise<void> {
  let previous = Promise.resolve();

  return () => {
    const current = previous.then(operation);
    previous = current.catch(() => {});
    return current;
  };
}
