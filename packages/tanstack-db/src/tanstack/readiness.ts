import type { Collection } from "@tanstack/db";

type ReadinessCollection<T extends object> = Collection<T, string>;

type SourceReadinessHandler = {
  markReady(): void;
};

type PublicCollectionReadiness = {
  collection: Collection<Record<string, unknown>, string>;
  preloadCollection: () => Promise<void>;
};

const waitForTanStackCollectionReady = <T extends object>(
  collection: ReadinessCollection<T>,
): Promise<void> => {
  if (collection.status === "ready") {
    return Promise.resolve();
  }
  if (collection.status === "error") {
    return Promise.reject(
      new Error(`TanStack DB collection ${collection.id} entered error state.`),
    );
  }

  return new Promise((resolve, reject) => {
    const unsubscribe = collection.on("status:change", ({ status }) => {
      if (status === "ready") {
        unsubscribe();
        resolve();
      } else if (status === "error" || status === "cleaned-up") {
        unsubscribe();
        reject(new Error(`TanStack DB collection ${collection.id} entered ${status} state.`));
      }
    });
  });
};

/** Bridges authoritative stream readiness into TanStack source and derived collection lifecycles. */
export class TanStackReadinessBridge<TSource extends object> {
  readonly #sourceCollection: ReadinessCollection<TSource>;
  readonly #publicCollections: readonly PublicCollectionReadiness[];
  readonly #getSourceHandler: () => SourceReadinessHandler | undefined;
  readonly #waitForStreamReady: () => Promise<void>;
  #sourceMarkedReady = false;
  #tablePreloads: Promise<void>[] | undefined;
  #readyPromise: Promise<void> | undefined;

  constructor(options: {
    sourceCollection: ReadinessCollection<TSource>;
    publicCollections: readonly PublicCollectionReadiness[];
    getSourceHandler: () => SourceReadinessHandler | undefined;
    waitForStreamReady: () => Promise<void>;
  }) {
    this.#sourceCollection = options.sourceCollection;
    this.#publicCollections = options.publicCollections;
    this.#getSourceHandler = options.getSourceHandler;
    this.#waitForStreamReady = options.waitForStreamReady;
  }

  startTableCollections(): Promise<void>[] {
    this.#tablePreloads ??= this.#publicCollections.map(({ preloadCollection }) => {
      const preload = preloadCollection();
      void preload.catch(() => undefined);
      return preload;
    });
    return this.#tablePreloads;
  }

  markReady(): Promise<void> {
    this.#readyPromise ??= (async () => {
      const handler = this.#getSourceHandler();
      if (!handler) {
        throw new Error("TanStack DB source sync handler is not ready.");
      }

      const sourceReady = waitForTanStackCollectionReady(this.#sourceCollection);
      const tablePreloads = this.startTableCollections();
      if (!this.#sourceMarkedReady) {
        this.#sourceMarkedReady = true;
        handler.markReady();
      }
      await sourceReady;
      await Promise.all(tablePreloads);
    })();
    return this.#readyPromise;
  }

  markTerminalError(): void {
    // SyncConfig currently has no asynchronous markError primitive. Keep internal lifecycle access
    // isolated in this adapter until TanStack exposes a public equivalent. Mark public views first
    // so downstream live queries observe the failing dependency while their preload is still active.
    for (const { collection } of this.#publicCollections) {
      if (collection.status !== "error" && collection.status !== "cleaned-up") {
        collection._lifecycle.setStatus("error");
      }
    }
    if (
      this.#sourceCollection.status !== "error" &&
      this.#sourceCollection.status !== "cleaned-up"
    ) {
      this.#sourceCollection._lifecycle.setStatus("error");
    }
  }

  installPublicCollectionReadiness(): void {
    for (const { collection, preloadCollection } of this.#publicCollections) {
      collection.preload = async () => {
        await Promise.all([preloadCollection(), this.#waitForStreamReady()]);
      };
      collection.stateWhenReady = async () => {
        await collection.preload();
        return collection.state;
      };
      collection.toArrayWhenReady = async () => {
        await collection.preload();
        return collection.toArray;
      };
    }
  }
}
