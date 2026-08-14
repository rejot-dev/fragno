import { assert, describe, expect, it, vi } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";
import superjson from "superjson";

import { BTreeIndex } from "@tanstack/db";
import type {
  PersistedCollectionPersistence,
  PersistedTx,
} from "@tanstack/db-sqlite-persistence-core";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import { FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY } from "../checkpoint";
import type { FragnoOutboxEntry } from "../protocol";
import { orderFragnoPersistenceWrites } from "./fragno-ordered-persistence";
import { FragnoOutboxSynchronizer } from "./fragno-outbox-synchronizer";
import { FragnoTableCollection } from "./fragno-table-collection";

function createOutboxSynchronizer(
  entries: readonly FragnoOutboxEntry[] = [],
): FragnoOutboxSynchronizer {
  let deliveredEntries = false;
  return new FragnoOutboxSynchronizer({
    fetcher: {
      listOutbox: async () => {
        if (deliveredEntries) {
          return [];
        }
        deliveredEntries = true;
        return [...entries];
      },
      openOutboxStream: async () => new ReadableStream(),
    },
    checkpointStore: {
      getCheckpoint: () => undefined,
      setCheckpoint() {},
    },
  });
}

const blogSchema = schema("blog", (builder) =>
  builder.addTable("users", (table) =>
    table.addColumn("id", idColumn()).addColumn("name", column("string")),
  ),
);

const usersTarget = {
  key: "4:blog5:users",
  namespace: "blog",
  schema: blogSchema,
  tableName: "users",
};

describe("FragnoTableCollection", () => {
  it("applies shared outbox changes inside its own sync callback", async () => {
    const database = new Database(":memory:");
    const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
    const outbox = createOutboxSynchronizer();
    const tableCollection = new FragnoTableCollection({
      id: "fragno.outbox.table.v1:4:blog5:users",
      idColumnName: "id",
      persistence,
      schemaVersion: 1,
      outbox,
      rowUpdateMode: "partial",
      skipMissingTruncateDeletes: false,
      target: usersTarget,
    });

    try {
      const preload = tableCollection.collection.preload();
      await outbox.waitUntilRegistered([usersTarget.key]);

      assert.equal(tableCollection.collection.config.id, "fragno.outbox.table.v1:4:blog5:users");
      assert.equal(tableCollection.collection.config.getKey({ id: "user-1" }), "user-1");
      assert.equal(tableCollection.collection.config.syncMode, "eager");
      assert.equal(tableCollection.collection.config.gcTime, 0);
      assert.equal(tableCollection.collection.config.autoIndex, "eager");
      assert.equal(tableCollection.collection.config.defaultIndexType, BTreeIndex);
      assert.equal(tableCollection.collection.config.sync.rowUpdateMode, "partial");

      const checkpoint = { versionstamp: "0000000000000001", uowId: "uow-1" };
      outbox.applyChanges(usersTarget.key, {
        checkpoint,
        changes: [
          {
            type: "insert",
            key: "user-1",
            value: { id: "user-1", name: "Ada" },
          },
        ],
      });
      expect(tableCollection.collection.get("user-1")).toMatchObject({
        id: "user-1",
        name: "Ada",
      });

      outbox.markReady();
      await preload;
      await vi.waitFor(async () => {
        const rows = await persistence.adapter.scanRows?.(tableCollection.collection.id);
        const metadata = await persistence.adapter.loadCollectionMetadata?.(
          tableCollection.collection.id,
        );
        assert(rows?.some((row) => row.key === "user-1"));
        expect(metadata).toContainEqual({
          key: FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
          value: checkpoint,
        });
      });
    } finally {
      await tableCollection.collection.cleanup();
      outbox.dispose();
      await persistence.drain();
      database.close();
    }
  });

  it("retrieves persisted keys and skips missing truncate deletes during catch-up", async () => {
    const database = new Database(":memory:");
    const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
    const collectionId = "fragno.outbox.table.v1:4:blog5:users";
    const seedOutbox = createOutboxSynchronizer();
    const seedCollection = new FragnoTableCollection({
      id: collectionId,
      idColumnName: "id",
      persistence,
      schemaVersion: 1,
      outbox: seedOutbox,
      rowUpdateMode: "partial",
      skipMissingTruncateDeletes: false,
      target: usersTarget,
    });

    try {
      const seedPreload = seedCollection.collection.preload();
      await seedOutbox.waitUntilRegistered([usersTarget.key]);
      seedOutbox.applyChanges(usersTarget.key, {
        checkpoint: { versionstamp: "0000000000000001", uowId: "uow-1" },
        changes: [
          {
            type: "insert",
            key: "persisted-user",
            value: { id: "persisted-user", name: "Ada" },
          },
        ],
      });
      seedOutbox.markReady();
      await seedPreload;
      await vi.waitFor(async () => {
        const rows = await persistence.adapter.scanRows?.(collectionId);
        assert(rows?.some(({ key }) => key === "persisted-user"));
      });
      await seedCollection.collection.cleanup();
      seedOutbox.dispose();

      const truncateEntry: FragnoOutboxEntry = {
        versionstamp: "0000000000000002",
        uowId: "uow-2",
        payload: superjson.serialize({
          version: 2,
          operations: [
            {
              op: "truncate",
              schema: "blog",
              table: "users",
              match: { name: "Ada" },
              externalIds: ["persisted-user", "missing-user"],
              versionstamp: "0000000000000002",
            },
          ],
        }),
      };
      const catchUpOutbox = createOutboxSynchronizer([truncateEntry]);
      const appliedTransactions: PersistedTx[] = [];
      const scannedCollections: string[] = [];
      const trackedPersistence: PersistedCollectionPersistence = {
        ...persistence,
        resolvePersistenceForCollection(options) {
          const resolved = persistence.resolvePersistenceForCollection!(options);
          const adapter = resolved.adapter;
          const trackedAdapter = Object.create(adapter) as typeof adapter;
          trackedAdapter.scanRows = async (requestedCollectionId) => {
            scannedCollections.push(requestedCollectionId);
            return await adapter.scanRows!(requestedCollectionId);
          };
          trackedAdapter.applyCommittedTx = async (...args) => {
            appliedTransactions.push(args[1]);
            return await adapter.applyCommittedTx(...args);
          };
          return { ...resolved, adapter: trackedAdapter };
        },
      };
      const catchUpCollection = new FragnoTableCollection({
        id: collectionId,
        idColumnName: "id",
        persistence: trackedPersistence,
        schemaVersion: 1,
        outbox: catchUpOutbox,
        rowUpdateMode: "partial",
        skipMissingTruncateDeletes: true,
        target: usersTarget,
      });

      const catchUpPreload = catchUpCollection.collection.preload();
      await catchUpOutbox.waitUntilRegistered([usersTarget.key]);
      await catchUpOutbox.catchUp();
      await catchUpPreload;

      expect(scannedCollections).toContain(collectionId);
      await vi.waitFor(() => {
        expect(
          appliedTransactions.flatMap(({ mutations }) => mutations.map(({ key }) => key)),
        ).toContain("persisted-user");
      });
      expect(
        appliedTransactions.flatMap(({ mutations }) => mutations.map(({ key }) => key)),
      ).not.toContain("missing-user");

      await catchUpCollection.collection.cleanup();
      catchUpOutbox.dispose();
    } finally {
      await seedCollection.collection.cleanup().catch(() => {});
      seedOutbox.dispose();
      await persistence.drain();
      database.close();
    }
  });

  it("skips replayed and older entries and rejects a conflicting UOW", async () => {
    const database = new Database(":memory:");
    const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
    const outbox = createOutboxSynchronizer();
    const tableCollection = new FragnoTableCollection({
      id: "fragno.outbox.table.v1:4:blog5:users",
      idColumnName: "id",
      persistence,
      schemaVersion: 1,
      outbox,
      rowUpdateMode: "partial",
      skipMissingTruncateDeletes: false,
      target: usersTarget,
    });
    const checkpoint = { versionstamp: "0000000000000002", uowId: "uow-2" };

    try {
      const preload = tableCollection.collection.preload();
      await outbox.waitUntilRegistered([usersTarget.key]);

      outbox.applyChanges(usersTarget.key, {
        checkpoint,
        changes: [
          {
            type: "insert",
            key: "user-1",
            value: { id: "user-1", name: "Ada" },
          },
        ],
      });
      expect(tableCollection.collection.get("user-1")).toMatchObject({ name: "Ada" });
      await vi.waitFor(async () => {
        const metadata = await persistence.adapter.loadCollectionMetadata?.(
          tableCollection.collection.id,
        );
        expect(metadata).toContainEqual({
          key: FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
          value: checkpoint,
        });
      });
      const streamPositionBeforeReplay = await persistence.adapter.getStreamPosition?.(
        tableCollection.collection.id,
      );

      outbox.applyChanges(usersTarget.key, {
        checkpoint,
        changes: [
          {
            type: "update",
            key: "user-1",
            value: { name: "replayed" },
          },
        ],
      });
      outbox.applyChanges(usersTarget.key, {
        checkpoint: { versionstamp: "0000000000000001", uowId: "uow-1" },
        changes: [
          {
            type: "update",
            key: "user-1",
            value: { name: "older" },
          },
        ],
      });

      expect(tableCollection.collection.get("user-1")).toMatchObject({ name: "Ada" });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(await persistence.adapter.getStreamPosition?.(tableCollection.collection.id)).toEqual(
        streamPositionBeforeReplay,
      );
      expect(() =>
        outbox.applyChanges(usersTarget.key, {
          checkpoint: { versionstamp: checkpoint.versionstamp, uowId: "conflicting-uow" },
          changes: [],
        }),
      ).toThrow(`Outbox versionstamp ${checkpoint.versionstamp} changed from UOW`);

      outbox.markReady();
      await preload;
      await vi.waitFor(async () => {
        const metadata = await persistence.adapter.loadCollectionMetadata?.(
          tableCollection.collection.id,
        );
        expect(metadata).toContainEqual({
          key: FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
          value: checkpoint,
        });
      });
    } finally {
      await tableCollection.collection.cleanup();
      outbox.dispose();
      await persistence.drain();
      database.close();
    }
  });
});
