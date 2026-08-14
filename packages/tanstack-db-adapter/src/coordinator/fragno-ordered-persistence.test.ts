import { describe, expect, it } from "vitest";

import type {
  PersistedCollectionPersistence,
  PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

import { orderFragnoPersistenceWrites } from "./fragno-ordered-persistence";

const persistedTransaction = {} as Parameters<PersistenceAdapter["applyCommittedTx"]>[1];

function persistenceWithAdapter(adapter: PersistenceAdapter): PersistedCollectionPersistence {
  return { adapter };
}

function persistenceAdapter(
  applyCommittedTx: PersistenceAdapter["applyCommittedTx"],
): PersistenceAdapter {
  return {
    loadSubset: async () => [],
    applyCommittedTx,
    ensureIndex: async () => {},
  };
}

describe("orderFragnoPersistenceWrites", () => {
  it("allows the shared checkpoint to overtake a failed collection write without ordering", async () => {
    const durableWrites: string[] = [];
    let releaseTableWrite: (() => void) | undefined;
    const tableWriteBlocked = new Promise<void>((resolve) => {
      releaseTableWrite = resolve;
    });
    const tablePersistence = persistenceWithAdapter(
      persistenceAdapter(async (collectionId) => {
        await tableWriteBlocked;
        durableWrites.push(collectionId);
        throw new Error("table persistence failed");
      }),
    );
    const internalPersistence = persistenceWithAdapter(
      persistenceAdapter(async (collectionId) => {
        durableWrites.push(collectionId);
      }),
    );

    const tableWrite = tablePersistence.adapter.applyCommittedTx("users", persistedTransaction);
    const checkpointWrite = internalPersistence.adapter.applyCommittedTx(
      "fragno.outbox.internal.v1",
      persistedTransaction,
    );

    await checkpointWrite;
    expect(durableWrites).toEqual(["fragno.outbox.internal.v1"]);

    releaseTableWrite?.();
    await expect(tableWrite).rejects.toThrow("table persistence failed");
    expect(durableWrites).toEqual(["fragno.outbox.internal.v1", "users"]);
  });

  it("prevents a shared checkpoint write after an earlier collection write fails", async () => {
    const durableWrites: string[] = [];
    const tablePersistence = persistenceWithAdapter(
      persistenceAdapter(async (collectionId) => {
        durableWrites.push(collectionId);
        throw new Error("table persistence failed");
      }),
    );
    const internalPersistence = persistenceWithAdapter(
      persistenceAdapter(async (collectionId) => {
        durableWrites.push(collectionId);
      }),
    );
    const rootPersistence: PersistedCollectionPersistence = {
      adapter: persistenceAdapter(async () => {}),
      resolvePersistenceForCollection: ({ collectionId }) =>
        collectionId === "fragno.outbox.internal.v1" ? internalPersistence : tablePersistence,
    };
    const orderedPersistence = orderFragnoPersistenceWrites(rootPersistence);
    const orderedTablePersistence = orderedPersistence.resolvePersistenceForCollection!({
      collectionId: "users",
      mode: "sync-present",
    });
    const orderedInternalPersistence = orderedPersistence.resolvePersistenceForCollection!({
      collectionId: "fragno.outbox.internal.v1",
      mode: "sync-present",
    });

    const tableWrite = orderedTablePersistence.adapter.applyCommittedTx(
      "users",
      persistedTransaction,
    );
    const checkpointWrite = orderedInternalPersistence.adapter.applyCommittedTx(
      "fragno.outbox.internal.v1",
      persistedTransaction,
    );

    await expect(tableWrite).rejects.toThrow("table persistence failed");
    await expect(checkpointWrite).rejects.toThrow("table persistence failed");
    expect(durableWrites).toEqual(["users"]);
  });
});
