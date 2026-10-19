import type {
  PersistedCollectionPersistence,
  PersistedStorageTarget,
  PersistedTx,
  PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

/**
 * A hydration scope hands TanStack an unscheduled inner adapter whose writes would bypass the
 * queue, and queueing them would wait on writes blocked behind that same scope. Hiding the scope
 * makes TanStack run hydration through the wrapped adapter.
 */
const HIDDEN_ADAPTER_PROPERTIES: ReadonlySet<PropertyKey> = new Set([
  "runInHydrationScope",
  "runInRegularScope",
  "isHydrationScopeScheduled",
]);

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

    const enqueueTransaction = <TResult>(
      target: PersistedStorageTarget,
      transaction: PersistedTx,
      write: () => Promise<TResult>,
    ): Promise<TResult> => {
      const matchingWaiters = metadataWaiters.filter(
        (waiter) =>
          target.kind === "eager" &&
          waiter.collectionId === target.collectionId &&
          transaction.collectionMetadataMutations?.some(
            (mutation) =>
              mutation.type === "set" &&
              mutation.key === waiter.key &&
              mutation.value === waiter.value,
          ),
      );
      const queuedWrite = queue.enqueue(write);
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
    };

    const wrapped = forwardAdapterCapabilities(adapter);
    wrapped.applyCommittedTx = (target, transaction) =>
      enqueueTransaction(target, transaction, () => adapter.applyCommittedTx(target, transaction));
    const { reconcileCommittedTx } = adapter;
    if (reconcileCommittedTx) {
      wrapped.reconcileCommittedTx = (target, transaction, anchor) =>
        enqueueTransaction(target, transaction, () =>
          reconcileCommittedTx.call(adapter, target, transaction, anchor),
        );
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

/**
 * Binds every adapter method, including class methods, so coordinators keep the capabilities they
 * require, such as the browser coordinator's `reserveLeadershipTerm`.
 */
function forwardAdapterCapabilities(adapter: PersistenceAdapter): PersistenceAdapter {
  const forwarded: Record<PropertyKey, unknown> = {};
  for (
    let source: object | null = adapter;
    source && source !== Object.prototype;
    source = Object.getPrototypeOf(source) as object | null
  ) {
    for (const property of Reflect.ownKeys(source)) {
      if (
        property === "constructor" ||
        HIDDEN_ADAPTER_PROPERTIES.has(property) ||
        Object.hasOwn(forwarded, property)
      ) {
        continue;
      }
      const value: unknown = Object.getOwnPropertyDescriptor(source, property)?.value;
      if (typeof value === "function") {
        forwarded[property] = value.bind(adapter);
      }
    }
  }
  return forwarded as unknown as PersistenceAdapter;
}

class FragnoPersistenceWriteQueue {
  #tail: Promise<unknown> = Promise.resolve();

  enqueue<TResult>(write: () => Promise<TResult>): Promise<TResult> {
    const queuedWrite = this.#tail.then(write);
    // Keep a rejection in the chain so a later shared checkpoint can never pass a failed table
    // write and become the durable resume position.
    this.#tail = queuedWrite;
    return queuedWrite;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}
