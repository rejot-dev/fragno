import {
  createFragnoOutboxCoordinator,
  type FragnoOutboxBootstrap,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createPersistedFragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter/persistence";
import { createFetchFragnoOutboxStreamingTransport } from "@fragno-dev/tanstack-db-adapter/streaming-transport";

import type { FragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter";

export type BrowserCollectionSourceDescription<TCollectionTarget extends string> = {
  resourceKey: string;
  internalUrl: string;
  bootstrap?: FragnoOutboxBootstrap;
  collectionId: (target: TCollectionTarget) => string;
};

export type BrowserCollectionDatabase<TSource, TCollections> = {
  collectionsFor(source: TSource): TCollections;
};

export function createCollectionResourceRegistry<TSource, TResource>(options: {
  resourceKey(source: TSource): string;
  createResource(source: TSource): TResource;
}) {
  const resources = new Map<string, TResource>();

  return {
    resourceFor(source: TSource): TResource {
      const resourceKey = options.resourceKey(source);
      const existing = resources.get(resourceKey);
      if (existing) {
        return existing;
      }

      const resource = options.createResource(source);
      resources.set(resourceKey, resource);
      return resource;
    },
  };
}

export async function openBrowserCollectionDatabase<
  TSource,
  TCollections,
  TCollectionTarget extends string,
>(options: {
  databaseName: string;
  coordinatorName: string;
  schemaVersion: number;
  describeSource(source: TSource): BrowserCollectionSourceDescription<TCollectionTarget>;
  createCollections(context: {
    coordinator: FragnoOutboxCoordinator;
    collectionId: (target: TCollectionTarget) => string;
    createCollection: FragnoCollectionFactory;
  }): TCollections;
}): Promise<BrowserCollectionDatabase<TSource, TCollections>> {
  const {
    BrowserCollectionCoordinator,
    createBrowserWASQLitePersistence,
    openBrowserWASQLiteOPFSDatabase,
  } = await import("@tanstack/browser-db-sqlite-persistence");
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: options.databaseName,
  });
  const persistenceCoordinator = new BrowserCollectionCoordinator({
    dbName: options.coordinatorName,
  });
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator: persistenceCoordinator,
  });
  const createCollection = createPersistedFragnoCollectionFactory({
    persistence,
    schemaVersion: options.schemaVersion,
  });
  const resources = createCollectionResourceRegistry({
    resourceKey: (source: TSource) => options.describeSource(source).resourceKey,
    createResource: (source: TSource) => {
      const description = options.describeSource(source);
      const coordinator = createFragnoOutboxCoordinator({
        internalUrl: description.internalUrl,
        bootstrap: description.bootstrap,
        transport: createFetchFragnoOutboxStreamingTransport({
          internalUrl: description.internalUrl,
        }),
      });
      const collections = options.createCollections({
        coordinator,
        collectionId: description.collectionId,
        createCollection,
      });

      return { collections, coordinator };
    },
  });

  return {
    collectionsFor(source) {
      return resources.resourceFor(source).collections;
    },
  };
}

export function createBrowserCollectionDatabaseLoader<TDatabase>(options: {
  name: string;
  open(): Promise<TDatabase>;
}): () => Promise<TDatabase> {
  let databasePromise: Promise<TDatabase> | undefined;

  return () => {
    if (typeof window === "undefined") {
      throw new Error(`${options.name} is only available in the browser.`);
    }

    databasePromise ??= options.open().catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  };
}
