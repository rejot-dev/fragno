import type {
  PersistedCollectionPersistence,
  PersistedTx,
  PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

type PersistenceCheckpointWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === "string" ? value : String(value));

/** Tracks exact checkpoint generations through the asynchronous persistence adapter boundary. */
export class PersistenceWriteTracker {
  readonly #pendingWrites = new Set<Promise<void>>();
  readonly #failures: Error[] = [];
  readonly #checkpointWaiters = new Map<string, PersistenceCheckpointWaiter>();
  readonly #checkpointGenerationFromTx: (tx: PersistedTx) => string | undefined;

  constructor(checkpointGenerationFromTx: (tx: PersistedTx) => string | undefined) {
    this.#checkpointGenerationFromTx = checkpointGenerationFromTx;
  }

  waitForCheckpointCommit(generation: string): Promise<void> {
    if (this.#checkpointWaiters.has(generation)) {
      throw new Error(`Persistence checkpoint ${generation} is already pending.`);
    }

    return new Promise<void>((resolve, reject) => {
      this.#checkpointWaiters.set(generation, { resolve, reject });
    });
  }

  rejectCheckpointCommit(generation: string, error: Error): void {
    const waiter = this.#checkpointWaiters.get(generation);
    if (!waiter) {
      return;
    }
    this.#checkpointWaiters.delete(generation);
    waiter.reject(error);
  }

  trackCommittedTransaction(tx: PersistedTx, write: Promise<void>): Promise<void> {
    const generation = this.#checkpointGenerationFromTx(tx);
    const trackedWrite = write
      .then(() => {
        if (!generation) {
          return;
        }
        const waiter = this.#checkpointWaiters.get(generation);
        this.#checkpointWaiters.delete(generation);
        waiter?.resolve();
      })
      .catch((error) => {
        const persistenceError = toError(error);
        this.#failures.push(persistenceError);
        if (generation) {
          const waiter = this.#checkpointWaiters.get(generation);
          this.#checkpointWaiters.delete(generation);
          waiter?.reject(persistenceError);
        }
        throw persistenceError;
      })
      .finally(() => {
        this.#pendingWrites.delete(trackedWrite);
      });
    this.#pendingWrites.add(trackedWrite);
    return trackedWrite;
  }

  rejectPendingCheckpointCommits(error: Error): void {
    for (const waiter of this.#checkpointWaiters.values()) {
      waiter.reject(error);
    }
    this.#checkpointWaiters.clear();
  }

  async waitForIdle(): Promise<void> {
    while (this.#pendingWrites.size > 0) {
      await Promise.allSettled(this.#pendingWrites);
    }

    if (this.#failures.length > 0) {
      throw new AggregateError(
        this.#failures.splice(0),
        "Failed to persist one or more Fragno stream transactions.",
      );
    }
  }
}

/** Wrap a persistence provider without changing its resolution behavior. */
export function trackPersistenceWrites(options: {
  persistence: PersistedCollectionPersistence;
  tracker: PersistenceWriteTracker;
}): PersistedCollectionPersistence {
  const { persistence, tracker } = options;
  const adapters = new WeakMap<PersistenceAdapter, PersistenceAdapter>();
  const providers = new WeakMap<object, PersistedCollectionPersistence>();

  const wrapAdapter = (adapter: PersistenceAdapter): PersistenceAdapter => {
    const existing = adapters.get(adapter);
    if (existing) {
      return existing;
    }

    const trackedAdapter: PersistenceAdapter = {
      loadSubset: (...args) => adapter.loadSubset(...args),
      applyCommittedTx: (collectionId, tx) =>
        tracker.trackCommittedTransaction(tx, adapter.applyCommittedTx(collectionId, tx)),
      ensureIndex: (...args) => adapter.ensureIndex(...args),
      ...(adapter.loadCollectionMetadata
        ? { loadCollectionMetadata: (...args) => adapter.loadCollectionMetadata!(...args) }
        : {}),
      ...(adapter.scanRows ? { scanRows: (...args) => adapter.scanRows!(...args) } : {}),
      ...(adapter.markIndexRemoved
        ? { markIndexRemoved: (...args) => adapter.markIndexRemoved!(...args) }
        : {}),
      ...(adapter.getStreamPosition
        ? { getStreamPosition: (...args) => adapter.getStreamPosition!(...args) }
        : {}),
    };
    adapters.set(adapter, trackedAdapter);
    return trackedAdapter;
  };

  const wrapProvider = (
    provider: PersistedCollectionPersistence,
  ): PersistedCollectionPersistence => {
    const existing = providers.get(provider);
    if (existing) {
      return existing;
    }

    const trackedProvider: PersistedCollectionPersistence = {
      adapter: wrapAdapter(provider.adapter),
      ...(provider.coordinator ? { coordinator: provider.coordinator } : {}),
    };
    providers.set(provider, trackedProvider);

    if (provider.resolvePersistenceForCollection) {
      trackedProvider.resolvePersistenceForCollection = (resolutionOptions) =>
        wrapProvider(provider.resolvePersistenceForCollection!.call(provider, resolutionOptions));
    }
    if (provider.resolvePersistenceForMode) {
      trackedProvider.resolvePersistenceForMode = (mode) =>
        wrapProvider(provider.resolvePersistenceForMode!.call(provider, mode));
    }

    return trackedProvider;
  };

  return wrapProvider(persistence);
}
