import type { AnySchema } from "@fragno-dev/db/schema";

import {
  createFragnoOutboxCoordinator,
  fetchFragnoOutboxDescription,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import type {
  PersistedCollectionPersistence,
  PersistenceAdapter,
  PersistedTx,
} from "@tanstack/db-sqlite-persistence-core";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";

type ScenarioCollections = Record<string, { cleanup(): Promise<void> }>;

export type ScenarioCollectionScope<TCollections extends ScenarioCollections> = {
  readonly collections: TCollections;
  sync(): Promise<void>;
  drain(): Promise<void>;
};

export type ScenarioCollectionDatabase<TCollections extends ScenarioCollections> = {
  forScope(scope: BackofficeContextScope): ScenarioCollectionScope<TCollections>;
  forOrg(orgId: string): ScenarioCollectionScope<TCollections>;
};

type ScenarioCollectionScopeRuntime<TCollections extends ScenarioCollections> =
  ScenarioCollectionScope<TCollections> & {
    cleanup(): Promise<void>;
  };

export type ScenarioCollectionDatabaseRuntime<TCollections extends ScenarioCollections> =
  ScenarioCollectionDatabase<TCollections> & {
    syncAll(): Promise<void>;
    cleanup(): Promise<void>;
  };

const scopeKey = (scope: BackofficeContextScope) => backofficeContextScopeSinglePathSegment(scope);

export function createScenarioCollectionDatabase<
  const TSchemas extends readonly AnySchema[],
  TCollections extends ScenarioCollections,
>(options: {
  name: string;
  schemas: TSchemas;
  drainRuntime(): Promise<void>;
  baseUrl(scope: BackofficeContextScope): string;
  createFetch(scope: BackofficeContextScope): typeof fetch;
  createCollections(coordinator: FragnoOutboxCoordinator<TSchemas>): TCollections;
}): ScenarioCollectionDatabaseRuntime<TCollections> {
  const scopes = new Map<string, ScenarioCollectionScopeRuntime<TCollections>>();

  const forScope = (scope: BackofficeContextScope): ScenarioCollectionScope<TCollections> => {
    const key = scopeKey(scope);
    const existing = scopes.get(key);
    if (existing) {
      return existing;
    }

    let collections: TCollections | undefined;
    const fetch = options.createFetch(scope);
    const baseUrl = options.baseUrl(scope);
    const persistence = createInMemoryPersistence();
    const resource = (async () => {
      const coordinator = await createFragnoOutboxCoordinator(
        { baseUrl, fetch, schemas: options.schemas },
        {
          async openPersistence() {
            return { persistence, async cleanup() {} };
          },
        },
      );
      collections = options.createCollections(coordinator);
      await coordinator.preload();
      return { coordinator, collections };
    })();

    const sync = async () => {
      const [initialized, description] = await Promise.all([
        resource,
        fetchFragnoOutboxDescription({ baseUrl, fetch }),
      ]);
      await waitForCheckpoint(
        initialized.coordinator,
        description.currentVersionstamp,
        options.name,
      );
    };

    const scopeRuntime: ScenarioCollectionScopeRuntime<TCollections> = {
      get collections() {
        if (!collections) {
          throw new Error(`Call sync() or drain() before reading ${options.name}.collections.`);
        }
        return collections;
      },
      sync,
      drain: async () => {
        await options.drainRuntime();
        await sync();
      },
      cleanup: async () => {
        const initialized = await resource;
        await initialized.coordinator.cleanup();
      },
    };

    void resource.catch(() => {});
    scopes.set(key, scopeRuntime);
    return scopeRuntime;
  };

  return {
    forScope,
    forOrg: (orgId) => forScope({ kind: "org", orgId }),
    syncAll: async () => {
      await Promise.all([...scopes.values()].map((scopeRuntime) => scopeRuntime.sync()));
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

async function waitForCheckpoint(
  coordinator: FragnoOutboxCoordinator<readonly AnySchema[]>,
  currentVersionstamp: string | null,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    currentVersionstamp === null
      ? coordinator.state !== "live"
      : coordinator.internal.getCheckpoint()?.versionstamp !== currentVersionstamp
  ) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for scenario ${name} to synchronize.`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function createInMemoryPersistence(): PersistedCollectionPersistence {
  const rowsByCollection = new Map<
    string,
    Map<string | number, { value: Record<string, unknown>; metadata?: unknown }>
  >();
  const metadataByCollection = new Map<string, Map<string, unknown>>();
  const streamPositions = new Map<
    string,
    { latestTerm: number; latestSeq: number; latestRowVersion: number }
  >();

  const adapter: PersistenceAdapter = {
    async loadSubset(collectionId) {
      const rows =
        rowsByCollection.get(collectionId) ??
        new Map<string | number, { value: Record<string, unknown>; metadata?: unknown }>();
      return [...rows.entries()].map(([key, row]) => ({ key, ...row }));
    },
    async applyCommittedTx(collectionId, transaction) {
      applyTransaction(rowsByCollection, metadataByCollection, collectionId, transaction);
      streamPositions.set(collectionId, {
        latestTerm: transaction.term,
        latestSeq: transaction.seq,
        latestRowVersion: transaction.rowVersion,
      });
    },
    async loadCollectionMetadata(collectionId) {
      const metadata = metadataByCollection.get(collectionId) ?? new Map<string, unknown>();
      return [...metadata.entries()].map(([key, value]) => ({ key, value }));
    },
    async scanRows(collectionId) {
      const rows =
        rowsByCollection.get(collectionId) ??
        new Map<string | number, { value: Record<string, unknown>; metadata?: unknown }>();
      return [...rows.entries()].map(([key, row]) => ({ key, ...row }));
    },
    async ensureIndex() {},
    async getStreamPosition(collectionId) {
      return (
        streamPositions.get(collectionId) ?? {
          latestTerm: 0,
          latestSeq: 0,
          latestRowVersion: 0,
        }
      );
    },
  };

  return { adapter };
}

function applyTransaction(
  rowsByCollection: Map<
    string,
    Map<string | number, { value: Record<string, unknown>; metadata?: unknown }>
  >,
  metadataByCollection: Map<string, Map<string, unknown>>,
  collectionId: string,
  transaction: PersistedTx,
): void {
  const rows =
    rowsByCollection.get(collectionId) ??
    new Map<string | number, { value: Record<string, unknown>; metadata?: unknown }>();
  const collectionMetadata = metadataByCollection.get(collectionId) ?? new Map<string, unknown>();
  rowsByCollection.set(collectionId, rows);
  metadataByCollection.set(collectionId, collectionMetadata);

  if (transaction.truncate) {
    rows.clear();
  }
  for (const mutation of transaction.mutations) {
    if (mutation.type === "delete") {
      rows.delete(mutation.key);
    } else {
      rows.set(mutation.key, {
        value: mutation.value,
        ...(mutation.metadataChanged ? { metadata: mutation.metadata } : {}),
      });
    }
  }
  for (const mutation of transaction.rowMetadataMutations ?? []) {
    const row = rows.get(mutation.key);
    if (!row) {
      continue;
    }
    if (mutation.type === "set") {
      row.metadata = mutation.value;
    } else {
      delete row.metadata;
    }
  }
  for (const mutation of transaction.collectionMetadataMutations ?? []) {
    if (mutation.type === "set") {
      collectionMetadata.set(mutation.key, mutation.value);
    } else {
      collectionMetadata.delete(mutation.key);
    }
  }
}
