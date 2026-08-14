import { describe, expect, it, vi } from "vitest";

import Database from "better-sqlite3";

import {
  createNodeSQLitePersistence,
  type PersistedCollectionPersistence,
} from "@tanstack/node-db-sqlite-persistence";

import {
  FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY,
  FRAGNO_INTERNAL_COLLECTION_ID,
  FRAGNO_INTERNAL_STATUS_ID,
  FragnoInternalCollection,
} from "./fragno-internal-collection";
import { orderFragnoPersistenceWrites } from "./fragno-ordered-persistence";

async function openInternalCollection(persistence: PersistedCollectionPersistence) {
  const collection = new FragnoInternalCollection({ persistence });
  await collection.preload();
  return collection;
}

function createPersistenceWriteGate(persistence: PersistedCollectionPersistence) {
  let resolveWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    resolveWriteStarted = resolve;
  });
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let resolveWriteFinished!: () => void;
  const writeFinished = new Promise<void>((resolve) => {
    resolveWriteFinished = resolve;
  });
  let armed = false;
  const patchedAdapters: Array<{
    adapter: PersistedCollectionPersistence["adapter"];
    applyCommittedTx: PersistedCollectionPersistence["adapter"]["applyCommittedTx"];
  }> = [];

  const patchPersistence = (
    resolvedPersistence: PersistedCollectionPersistence,
  ): PersistedCollectionPersistence => {
    const adapter = resolvedPersistence.adapter;
    if (patchedAdapters.some((patched) => patched.adapter === adapter)) {
      return resolvedPersistence;
    }

    const applyCommittedTx = adapter.applyCommittedTx.bind(adapter);
    patchedAdapters.push({ adapter, applyCommittedTx });
    adapter.applyCommittedTx = async (...args) => {
      const isDeferredWrite = armed;
      if (isDeferredWrite) {
        armed = false;
        resolveWriteStarted();
        await writeReleased;
      }
      await applyCommittedTx(...args);
      if (isDeferredWrite) {
        resolveWriteFinished();
      }
    };
    return resolvedPersistence;
  };

  const resolveForCollection = persistence.resolvePersistenceForCollection?.bind(persistence);
  if (resolveForCollection) {
    persistence.resolvePersistenceForCollection = (options) =>
      patchPersistence(resolveForCollection(options));
  }
  const resolveForMode = persistence.resolvePersistenceForMode?.bind(persistence);
  if (resolveForMode) {
    persistence.resolvePersistenceForMode = (mode) => patchPersistence(resolveForMode(mode));
  }
  patchPersistence(persistence);

  return {
    writeStarted,
    writeFinished,
    arm() {
      armed = true;
    },
    releaseWrite,
    restore() {
      for (const patched of patchedAdapters) {
        patched.adapter.applyCommittedTx = patched.applyCommittedTx;
      }
    },
  };
}

describe("FragnoInternalCollection", () => {
  it("hydrates persisted checkpoint metadata", async () => {
    const database = new Database(":memory:");
    const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
    const first = await openInternalCollection(persistence);

    try {
      expect(first.collection.get(FRAGNO_INTERNAL_STATUS_ID)).toMatchObject({
        state: "opening",
        checkpoint: null,
        error: null,
      });
      first.setState("live");
      first.setCheckpoint({ versionstamp: "0000000000000002", uowId: "uow-2" });
      expect(first.collection.get(FRAGNO_INTERNAL_STATUS_ID)).toMatchObject({
        state: "live",
        checkpoint: { versionstamp: "0000000000000002", uowId: "uow-2" },
        error: null,
      });
      await vi.waitFor(async () => {
        const metadata = await persistence.adapter.loadCollectionMetadata?.(
          FRAGNO_INTERNAL_COLLECTION_ID,
        );
        expect(metadata).toContainEqual({
          key: FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY,
          value: { versionstamp: "0000000000000002", uowId: "uow-2" },
        });
      });
      await first.cleanup();

      const second = await openInternalCollection(persistence);
      try {
        expect(second.getCheckpoint()).toEqual({
          versionstamp: "0000000000000002",
          uowId: "uow-2",
        });
        expect(second.collection.get(FRAGNO_INTERNAL_STATUS_ID)).toMatchObject({
          state: "opening",
          checkpoint: { versionstamp: "0000000000000002", uowId: "uow-2" },
          error: null,
        });
      } finally {
        await second.cleanup();
      }
    } finally {
      await persistence.drain();
      database.close();
    }
  });

  it("returns from checkpoint writes before SQLite persistence completes", async () => {
    const database = new Database(":memory:");
    const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
    const deferredWrite = createPersistenceWriteGate(persistence);
    const internal = await openInternalCollection(persistence);
    const checkpoint = { versionstamp: "0000000000000002", uowId: "uow-2" };

    try {
      deferredWrite.arm();
      internal.setCheckpoint(checkpoint);

      expect(internal.getCheckpoint()).toEqual(checkpoint);
      await deferredWrite.writeStarted;

      const metadataBeforePersistence = await persistence.adapter.loadCollectionMetadata?.(
        FRAGNO_INTERNAL_COLLECTION_ID,
      );
      expect(metadataBeforePersistence).not.toContainEqual({
        key: FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY,
        value: checkpoint,
      });

      // Checkpoint metadata is immediately committed to TanStack state while SQLite persistence
      // continues in the background.
      deferredWrite.releaseWrite();
      await deferredWrite.writeFinished;

      const metadataAfterPersistence = await persistence.adapter.loadCollectionMetadata?.(
        FRAGNO_INTERNAL_COLLECTION_ID,
      );
      expect(metadataAfterPersistence).toContainEqual({
        key: FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY,
        value: checkpoint,
      });
    } finally {
      deferredWrite.releaseWrite();
      deferredWrite.restore();
      await internal.cleanup();
      await persistence.drain();
      database.close();
    }
  });
});
