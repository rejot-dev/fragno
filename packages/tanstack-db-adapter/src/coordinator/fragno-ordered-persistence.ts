import type {
  PersistedCollectionPersistence,
  PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

export type OrderedFragnoPersistence = PersistedCollectionPersistence & {
  drain(): Promise<void>;
  waitForCollectionMetadata(collectionId: string, key: string, value: unknown): Promise<void>;
};

/** Orders every collection write before later writes to the shared Fragno persistence database. */
export function orderFragnoPersistenceWrites(
  persistence: PersistedCollectionPersistence,
): OrderedFragnoPersistence {
  const queue = new FragnoPersistenceWriteQueue();
  const persistenceCache = new WeakMap<
    PersistedCollectionPersistence,
    PersistedCollectionPersistence
  >();
  const adapterCache = new WeakMap<PersistenceAdapter, PersistenceAdapter>();
  const metadataWaiters: Array<{
    collectionId: string;
    key: string;
    value: unknown;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];

  const wrapAdapter = (adapter: PersistenceAdapter): PersistenceAdapter => {
    const cached = adapterCache.get(adapter);
    if (cached) {
      return cached;
    }

    const wrapped: PersistenceAdapter = {
      loadSubset: (...args) => adapter.loadSubset(...args),
      applyCommittedTx: (...args) => {
        const [collectionId, transaction] = args;
        const matchingWaiters = metadataWaiters.filter(
          (waiter) =>
            waiter.collectionId === collectionId &&
            transaction.collectionMetadataMutations?.some(
              (mutation) =>
                mutation.type === "set" &&
                mutation.key === waiter.key &&
                mutation.value === waiter.value,
            ),
        );
        const queuedWrite = queue.enqueue(() => adapter.applyCommittedTx(...args));
        for (const waiter of matchingWaiters) {
          metadataWaiters.splice(metadataWaiters.indexOf(waiter), 1);
          void queuedWrite.then(
            () => {
              waiter.resolve();
            },
            (error: unknown) => {
              waiter.reject(error);
            },
          );
        }
        return queuedWrite;
      },
      ensureIndex: (...args) => adapter.ensureIndex(...args),
    };
    if (adapter.loadCollectionMetadata) {
      wrapped.loadCollectionMetadata = (...args) => adapter.loadCollectionMetadata!(...args);
    }
    if (adapter.scanRows) {
      wrapped.scanRows = (...args) => adapter.scanRows!(...args);
    }
    if (adapter.markIndexRemoved) {
      wrapped.markIndexRemoved = (...args) => adapter.markIndexRemoved!(...args);
    }
    if (adapter.getStreamPosition) {
      wrapped.getStreamPosition = (...args) => adapter.getStreamPosition!(...args);
    }

    adapterCache.set(adapter, wrapped);
    return wrapped;
  };

  const wrapPersistence = (
    resolvedPersistence: PersistedCollectionPersistence,
  ): PersistedCollectionPersistence => {
    const cached = persistenceCache.get(resolvedPersistence);
    if (cached) {
      return cached;
    }

    const wrapped: PersistedCollectionPersistence = {
      adapter: wrapAdapter(resolvedPersistence.adapter),
    };
    persistenceCache.set(resolvedPersistence, wrapped);

    if (resolvedPersistence.coordinator) {
      wrapped.coordinator = resolvedPersistence.coordinator;
    }
    if (resolvedPersistence.resolvePersistenceForCollection) {
      wrapped.resolvePersistenceForCollection = (options) =>
        wrapPersistence(resolvedPersistence.resolvePersistenceForCollection!(options));
    }
    if (resolvedPersistence.resolvePersistenceForMode) {
      wrapped.resolvePersistenceForMode = (mode) =>
        wrapPersistence(resolvedPersistence.resolvePersistenceForMode!(mode));
    }

    return wrapped;
  };

  return Object.assign(wrapPersistence(persistence), {
    drain: () => queue.drain(),
    waitForCollectionMetadata(collectionId: string, key: string, value: unknown) {
      return new Promise<void>((resolve, reject) => {
        metadataWaiters.push({ collectionId, key, value, resolve, reject });
      });
    },
  });
}

class FragnoPersistenceWriteQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue(write: () => Promise<void>): Promise<void> {
    const queuedWrite = this.#tail.then(write);
    // Keep a rejection in the chain so a later shared checkpoint can never pass a failed table
    // write and become the durable resume position.
    this.#tail = queuedWrite;
    return queuedWrite;
  }

  drain(): Promise<void> {
    return this.#tail;
  }
}
