import { assert, describe, expect, it, vi } from "vitest";

import { encodeVersionstamp, versionstampToHex, type OutboxOperation } from "@fragno-dev/db/outbox";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";
import superjson from "superjson";

import { BTreeIndex } from "@tanstack/db";
import type {
  PersistedCollectionPersistence,
  PersistedTx,
} from "@tanstack/db-sqlite-persistence-core";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import {
  FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
  type FragnoOutboxCheckpoint,
} from "../checkpoint";
import { createOutboxTestStream } from "../outbox-stream-test-fixture";
import { FragnoOutboxTransportError } from "../outbox-transport-error";
import type { FragnoOutboxEntry } from "../protocol";
import { orderFragnoPersistenceWrites } from "./fragno-ordered-persistence";
import { FragnoOutboxSynchronizer } from "./fragno-outbox-synchronizer";
import { FragnoTableCollection } from "./fragno-table-collection";

function createOutboxSynchronizer(
  entries: readonly FragnoOutboxEntry[] = [],
): FragnoOutboxSynchronizer {
  return new FragnoOutboxSynchronizer({
    adapterIdentity: "test-adapter",
    fetcher: { openOutboxStream: async () => createOutboxTestStream(entries) },
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

type UserOutboxChange =
  | { type: "create" | "update"; id: string; name: string }
  | { type: "delete"; id: string }
  | { type: "truncate"; ids: string[] };

function userOutboxEntry(version: number, ...changes: UserOutboxChange[]): FragnoOutboxEntry {
  const versionstamp = versionstampToHex(encodeVersionstamp(BigInt(version), 0));
  return {
    versionstamp,
    uowId: `uow-${version}`,
    payload: superjson.serialize({
      version: 2,
      operations: changes.map((change): OutboxOperation => {
        const target = { schema: "blog", table: "users", versionstamp };
        if (change.type === "truncate") {
          return { ...target, op: "truncate", match: {}, externalIds: change.ids };
        }
        if (change.type === "delete") {
          return { ...target, op: "delete", externalId: change.id };
        }
        return change.type === "create"
          ? { ...target, op: "create", externalId: change.id, values: { name: change.name } }
          : { ...target, op: "update", externalId: change.id, set: { name: change.name } };
      }),
    }),
  };
}

async function createKeyTrackingScenario(rowUpdateMode: "partial" | "full" = "partial") {
  const database = new Database(":memory:");
  const persistence = orderFragnoPersistenceWrites(createNodeSQLitePersistence({ database }));
  const collectionId = "fragno.outbox.table.v1:4:blog5:users";
  const scannedCollections: string[] = [];
  const transactions: PersistedTx[] = [];
  const trackedPersistence: PersistedCollectionPersistence = {
    ...persistence,
    resolvePersistenceForCollection(options) {
      const resolved = persistence.resolvePersistenceForCollection!(options);
      const adapter = resolved.adapter;
      const trackedAdapter = Object.create(adapter) as typeof adapter;
      trackedAdapter.scanRows = async (id) => {
        scannedCollections.push(id);
        return await adapter.scanRows!(id);
      };
      trackedAdapter.applyCommittedTx = async (...args) => {
        await adapter.applyCommittedTx(...args);
        transactions.push(args[1]);
      };
      return { ...resolved, adapter: trackedAdapter };
    },
  };
  let checkpoint: FragnoOutboxCheckpoint | undefined;
  let body = createOutboxTestStream([]);
  function openCollection() {
    const outbox = new FragnoOutboxSynchronizer({
      adapterIdentity: "test-adapter",
      fetcher: { openOutboxStream: async () => body },
      checkpointStore: {
        getCheckpoint: () => checkpoint,
        setCheckpoint(value) {
          checkpoint = value;
        },
      },
    });
    const table = new FragnoTableCollection({
      id: collectionId,
      idColumnName: "id",
      persistence: trackedPersistence,
      schemaVersion: 1,
      outbox,
      rowUpdateMode,
      skipMissingTruncateDeletes: true,
      target: usersTarget,
    });
    const ready = table.collection.preload();
    return { outbox, table, ready };
  }
  let frontend = openCollection();
  await frontend.outbox.waitUntilRegistered([usersTarget.key]);
  return {
    scannedCollections,
    transactions,
    get collection() {
      return frontend.table.collection;
    },
    get checkpoint() {
      return checkpoint;
    },
    async session(
      entries: FragnoOutboxEntry[],
      liveEntries: FragnoOutboxEntry[] = [],
      completion: "rotate" | "interrupt" = "rotate",
    ) {
      body = createOutboxTestStream(entries, liveEntries, completion);
      await frontend.outbox.streamSession({ onStarted() {}, onCaughtUp() {} });
      await frontend.ready;
    },
    truncate() {
      frontend.outbox.truncate(usersTarget.key);
    },
    async reopen() {
      await frontend.table.collection.cleanup();
      frontend.outbox.dispose();
      await persistence.drain();
      frontend = openCollection();
      await frontend.outbox.waitUntilRegistered([usersTarget.key]);
    },
    async persistedRows() {
      return await persistence.adapter.scanRows!(collectionId);
    },
    async flush() {
      await vi.waitFor(async () => {
        const metadata = await persistence.adapter.loadCollectionMetadata!(collectionId);
        expect(metadata).toContainEqual({
          key: FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
          value: checkpoint,
        });
      });
    },
    async close() {
      await frontend.table.collection.cleanup();
      frontend.outbox.dispose();
      await persistence.drain();
      database.close();
    },
  };
}

describe("FragnoTableCollection", () => {
  it.each(["partial", "full"] as const)(
    "initializes keys once across rotation and interruption, including live changes (%s rows)",
    async (rowUpdateMode) => {
      const scenario = await createKeyTrackingScenario(rowUpdateMode);
      const history = userOutboxEntry(0, { type: "create", id: "history", name: "Ada" });
      const live = userOutboxEntry(1, { type: "create", id: "live", name: "Grace" });
      const deleted = userOutboxEntry(2, { type: "delete", id: "history" });
      const truncated = userOutboxEntry(3, {
        type: "truncate",
        ids: ["history", "live", "missing"],
      });
      const absent = userOutboxEntry(4, { type: "truncate", ids: ["live", "missing"] });
      try {
        await scenario.session([history], [live]);
        await scenario.flush();
        expect(
          (await scenario.persistedRows())
            .map((row) => row.key)
            .sort((left, right) => String(left).localeCompare(String(right))),
        ).toEqual(["history", "live"]);
        expect(scenario.scannedCollections).toHaveLength(1);
        await expect(
          scenario.session([history, live], [deleted], "interrupt"),
        ).rejects.toBeInstanceOf(FragnoOutboxTransportError);
        await scenario.flush();
        scenario.transactions.length = 0;
        await scenario.session([history, live, deleted, truncated]);
        await scenario.flush();
        expect(
          scenario.transactions.flatMap((tx) => tx.mutations.map((mutation) => mutation.key)),
        ).toEqual(["live"]);
        expect(await scenario.persistedRows()).toEqual([]);
        assert(scenario.collection.size === 0);
        scenario.transactions.length = 0;
        await scenario.session([history, live, deleted, truncated, absent]);
        await scenario.flush();
        expect(scenario.transactions.flatMap((tx) => tx.mutations)).toEqual([]);
        expect(scenario.checkpoint).toEqual({
          versionstamp: absent.versionstamp,
          uowId: absent.uowId,
        });
        expect(scenario.scannedCollections).toHaveLength(1);
      } finally {
        await scenario.close();
      }
    },
  );

  it("tracks intra-batch inserts and deletes, live updates and truncates, and explicit clearing", async () => {
    const scenario = await createKeyTrackingScenario();
    const history = userOutboxEntry(
      0,
      { type: "create", id: "history", name: "Ada" },
      { type: "create", id: "temporary", name: "Temp" },
      { type: "truncate", ids: ["temporary"] },
      { type: "truncate", ids: ["temporary"] },
    );
    const updated = userOutboxEntry(1, { type: "update", id: "history", name: "Updated" });
    const truncatedLive = userOutboxEntry(2, { type: "truncate", ids: ["history"] });
    const catchUp = userOutboxEntry(
      3,
      { type: "truncate", ids: ["history", "temporary"] },
      { type: "create", id: "remaining", name: "Remaining" },
    );
    const afterClear = userOutboxEntry(4, { type: "truncate", ids: ["remaining"] });
    try {
      await scenario.session([history]);
      await scenario.flush();
      expect((await scenario.persistedRows()).map((row) => row.key)).toEqual(["history"]);
      expect(
        scenario.transactions
          .flatMap((tx) => tx.mutations)
          .filter((mutation) => mutation.key === "temporary" && mutation.type === "delete"),
      ).toHaveLength(1);
      await scenario.session([history], [updated, truncatedLive]);
      await scenario.flush();
      scenario.transactions.length = 0;
      await scenario.session([history, updated, truncatedLive, catchUp]);
      await scenario.flush();
      expect(
        scenario.transactions.flatMap((tx) => tx.mutations.map((mutation) => mutation.key)),
      ).toEqual(["remaining"]);
      scenario.truncate();
      await vi.waitFor(() => {
        assert(scenario.transactions.some((tx) => tx.truncate));
      });
      scenario.transactions.length = 0;
      await scenario.session([history, updated, truncatedLive, catchUp, afterClear]);
      await scenario.flush();
      expect(scenario.transactions.flatMap((tx) => tx.mutations)).toEqual([]);
      expect(await scenario.persistedRows()).toEqual([]);
      expect(scenario.scannedCollections).toHaveLength(1);
    } finally {
      await scenario.close();
    }
  });

  it("continues forwarding ordinary deletes and live truncate deletes for absent keys", async () => {
    const scenario = await createKeyTrackingScenario();
    const live = userOutboxEntry(0, { type: "truncate", ids: ["missing-live"] });
    const catchUp = userOutboxEntry(
      1,
      { type: "delete", id: "missing-ordinary" },
      { type: "truncate", ids: ["missing-catch-up"] },
    );
    try {
      await scenario.session([], [live]);
      await scenario.flush();
      expect(
        scenario.transactions.flatMap((tx) => tx.mutations.map((mutation) => mutation.key)),
      ).toEqual(["missing-live"]);
      scenario.transactions.length = 0;
      await scenario.session([live, catchUp]);
      await scenario.flush();
      expect(
        scenario.transactions.flatMap((tx) => tx.mutations.map((mutation) => mutation.key)),
      ).toEqual(["missing-ordinary"]);
      expect(await scenario.persistedRows()).toEqual([]);
      expect(scenario.scannedCollections).toHaveLength(1);
    } finally {
      await scenario.close();
    }
  });

  it("reinitializes keys when a replacement registration uses the existing persistence", async () => {
    const scenario = await createKeyTrackingScenario();
    const original = userOutboxEntry(0, { type: "create", id: "persisted", name: "Ada" });
    const truncated = userOutboxEntry(1, { type: "truncate", ids: ["persisted", "missing"] });
    try {
      await scenario.session([original]);
      await scenario.flush();
      await scenario.reopen();
      scenario.transactions.length = 0;
      await scenario.session([original, truncated]);
      await scenario.flush();
      expect(scenario.scannedCollections).toHaveLength(2);
      expect(
        scenario.transactions.flatMap((tx) => tx.mutations.map((mutation) => mutation.key)),
      ).toEqual(["persisted"]);
      expect(await scenario.persistedRows()).toEqual([]);
    } finally {
      await scenario.close();
    }
  });

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
        checkpoint: { versionstamp: "000000000000000000000001", uowId: "uow-1" },
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
        versionstamp: "000000000000000000000002",
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
              versionstamp: "000000000000000000000002",
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
      await catchUpOutbox.streamSession({ onStarted() {}, onCaughtUp() {} });
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
