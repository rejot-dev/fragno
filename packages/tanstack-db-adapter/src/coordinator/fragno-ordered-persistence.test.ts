import { describe, expect, it } from "vitest";

import {
  eagerStorageTarget,
  type PersistedCollectionPersistence,
  type PersistedStorageTarget,
  type PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

import { orderFragnoPersistenceWrites } from "./fragno-ordered-persistence";

const usersTarget = eagerStorageTarget("users");
const internalTarget = eagerStorageTarget("fragno.outbox.internal.v1");
const persistedTransaction = {} as Parameters<PersistenceAdapter["applyCommittedTx"]>[1];

function persistenceWithAdapter(adapter: PersistenceAdapter): PersistedCollectionPersistence {
  return { adapter };
}

function persistenceAdapter(
  applyCommittedTx: PersistenceAdapter["applyCommittedTx"],
): PersistenceAdapter {
  return {
    loadSubset: async () => [],
    loadResumeSnapshot: async () => ({
      rows: [],
      collectionMetadata: [],
      latestTerm: 0,
      latestSeq: 0,
      latestRowVersion: 0,
      resetEpoch: 0,
    }),
    applyCommittedTx,
    ensureIndex: async () => {},
  };
}

describe("orderFragnoPersistenceWrites", () => {
  it("allows the shared checkpoint to overtake a failed collection write without ordering", async () => {
    const durableWrites: PersistedStorageTarget[] = [];
    let releaseTableWrite: (() => void) | undefined;
    const tableWriteBlocked = new Promise<void>((resolve) => {
      releaseTableWrite = resolve;
    });
    const tablePersistence = persistenceWithAdapter(
      persistenceAdapter(async (target) => {
        await tableWriteBlocked;
        durableWrites.push(target);
        throw new Error("table persistence failed");
      }),
    );
    const internalPersistence = persistenceWithAdapter(
      persistenceAdapter(async (target) => {
        durableWrites.push(target);
      }),
    );

    const tableWrite = tablePersistence.adapter.applyCommittedTx(usersTarget, persistedTransaction);
    const checkpointWrite = internalPersistence.adapter.applyCommittedTx(
      internalTarget,
      persistedTransaction,
    );

    await checkpointWrite;
    expect(durableWrites).toEqual([internalTarget]);

    releaseTableWrite?.();
    await expect(tableWrite).rejects.toThrow("table persistence failed");
    expect(durableWrites).toEqual([internalTarget, usersTarget]);
  });

  it("prevents a shared checkpoint write after an earlier collection write fails", async () => {
    const durableWrites: PersistedStorageTarget[] = [];
    const tablePersistence = persistenceWithAdapter(
      persistenceAdapter(async (target) => {
        durableWrites.push(target);
        throw new Error("table persistence failed");
      }),
    );
    const internalPersistence = persistenceWithAdapter(
      persistenceAdapter(async (target) => {
        durableWrites.push(target);
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
      usersTarget,
      persistedTransaction,
    );
    const checkpointWrite = orderedInternalPersistence.adapter.applyCommittedTx(
      internalTarget,
      persistedTransaction,
    );

    await expect(tableWrite).rejects.toThrow("table persistence failed");
    await expect(checkpointWrite).rejects.toThrow("table persistence failed");
    expect(durableWrites).toEqual([usersTarget]);
  });
});
