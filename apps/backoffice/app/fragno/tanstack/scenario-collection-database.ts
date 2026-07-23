import {
  createFragnoOutboxCoordinator,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createFetchFragnoOutboxTransport } from "@fragno-dev/tanstack-db-adapter/transport";

import type { FragnoCollectionUtils } from "@fragno-dev/tanstack-db-adapter";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";

const MAX_SYNCHRONIZATION_ATTEMPTS = 20;

type ScenarioCollection = {
  preload(): Promise<void>;
  cleanup(): Promise<void>;
  subscribeChanges(callback: () => void): { unsubscribe(): void };
  utils: Pick<FragnoCollectionUtils, "getCheckpoint" | "initialSync">;
};

type ScenarioCollections = Record<string, ScenarioCollection>;

export type ScenarioCollectionScope<TCollections extends ScenarioCollections> = {
  collections: TCollections;
  sync(): Promise<void>;
  drain(): Promise<void>;
};

export type ScenarioCollectionDatabase<TCollections extends ScenarioCollections> = {
  forScope(scope: BackofficeContextScope): ScenarioCollectionScope<TCollections>;
  forOrg(orgId: string): ScenarioCollectionScope<TCollections>;
};

type ScenarioCollectionScopeRuntime<TCollections extends ScenarioCollections> =
  ScenarioCollectionScope<TCollections> & {
    coordinator: FragnoOutboxCoordinator;
    start(): Promise<void>;
    cleanup(): Promise<void>;
  };

export type ScenarioCollectionDatabaseRuntime<TCollections extends ScenarioCollections> =
  ScenarioCollectionDatabase<TCollections> & {
    syncAll(): Promise<void>;
    cleanup(): Promise<void>;
  };

const scopeKey = (scope: BackofficeContextScope) => backofficeContextScopeSinglePathSegment(scope);

const checkpointSignature = (collections: readonly ScenarioCollection[]): string =>
  JSON.stringify(collections.map((collection) => collection.utils.getCheckpoint()));

export function createScenarioCollectionDatabase<
  TCollections extends ScenarioCollections,
>(options: {
  name: string;
  drainRuntime(): Promise<void>;
  internalUrl(scope: BackofficeContextScope): string;
  createFetch(scope: BackofficeContextScope): typeof fetch;
  createCollections(context: {
    coordinator: FragnoOutboxCoordinator;
    scopeKey: string;
  }): TCollections;
}): ScenarioCollectionDatabaseRuntime<TCollections> {
  const scopes = new Map<string, ScenarioCollectionScopeRuntime<TCollections>>();

  const syncScope = async (scopeRuntime: ScenarioCollectionScopeRuntime<TCollections>) => {
    await scopeRuntime.start();
    const collections = Object.values(scopeRuntime.collections);

    const syncUntilCurrent = async (remainingAttempts: number): Promise<void> => {
      if (remainingAttempts === 0) {
        throw new Error(`Timed out waiting for scenario ${options.name} to synchronize.`);
      }

      const checkpointBeforeSync = checkpointSignature(collections);
      await scopeRuntime.coordinator.syncOnce();
      const checkpointAfterSync = checkpointSignature(collections);
      if (checkpointAfterSync !== checkpointBeforeSync) {
        await syncUntilCurrent(remainingAttempts - 1);
      }
    };

    await syncUntilCurrent(MAX_SYNCHRONIZATION_ATTEMPTS);
  };

  const forScope = (scope: BackofficeContextScope): ScenarioCollectionScope<TCollections> => {
    const key = scopeKey(scope);
    const existing = scopes.get(key);
    if (existing) {
      return existing;
    }

    const internalUrl = options.internalUrl(scope);
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl,
      transport: createFetchFragnoOutboxTransport({
        internalUrl,
        fetch: options.createFetch(scope),
      }),
      // Scenarios synchronize explicitly so background polling cannot race their assertions.
      pollIntervalMs: 60_000,
    });
    const collections = options.createCollections({ coordinator, scopeKey: key });
    const collectionList = Object.values(collections);
    // Keep every target registered so one coordinator sync advances the complete frontend view.
    const subscriptions = collectionList.map((collection) => collection.subscribeChanges(() => {}));
    let startPromise: Promise<void> | undefined;
    const scopeRuntime: ScenarioCollectionScopeRuntime<TCollections> = {
      collections,
      coordinator,
      start: () => {
        startPromise ??= Promise.all(
          collectionList.map((collection) =>
            Promise.all([collection.preload(), collection.utils.initialSync()]),
          ),
        ).then(() => undefined);
        return startPromise;
      },
      sync: () => syncScope(scopeRuntime),
      drain: async () => {
        await options.drainRuntime();
        await syncScope(scopeRuntime);
      },
      cleanup: async () => {
        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }
        try {
          await Promise.all(collectionList.map((collection) => collection.cleanup()));
        } finally {
          coordinator.dispose();
        }
      },
    };

    scopes.set(key, scopeRuntime);
    return scopeRuntime;
  };

  return {
    forScope,
    forOrg: (orgId) => forScope({ kind: "org", orgId }),
    syncAll: async () => {
      await Promise.all([...scopes.values()].map((scopeRuntime) => syncScope(scopeRuntime)));
    },
    cleanup: async () => {
      try {
        await Promise.all([...scopes.values()].map((scopeRuntime) => scopeRuntime.cleanup()));
      } finally {
        scopes.clear();
      }
    },
  };
}
