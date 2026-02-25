import { beforeEach, describe, expect, it } from "vitest";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import { openDB, type IDBPDatabase } from "idb";
import { IndexedDbAdapter } from "../mod";

const createDbName = () => `lofi-test-${Math.random().toString(16).slice(2)}`;

const createShardSchema = () =>
  schema("app", (s) =>
    s.addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("_shard", column("string").hidden()),
    ),
  );

type StoredRow = {
  data: Record<string, unknown>;
  _lofi: {
    internalId: number;
    version: number;
    norm: Record<string, unknown>;
  };
};

const openDb = (name: string): Promise<IDBPDatabase> => openDB(name);

const getRow = async (db: IDBPDatabase, key: IDBValidKey): Promise<StoredRow | undefined> => {
  const tx = db.transaction("lofi_rows", "readonly");
  const store = tx.objectStore("lofi_rows");
  const row = (await store.get(key)) as StoredRow | undefined;
  await tx.done;
  return row;
};

const getInboxRow = async (db: IDBPDatabase, key: IDBValidKey): Promise<unknown | undefined> => {
  const tx = db.transaction("lofi_inbox", "readonly");
  const store = tx.objectStore("lofi_inbox");
  const row = await store.get(key);
  await tx.done;
  return row;
};

const getMeta = async (db: IDBPDatabase, key: IDBValidKey): Promise<unknown | undefined> => {
  const tx = db.transaction("lofi_meta", "readonly");
  const store = tx.objectStore("lofi_meta");
  const row = await store.get(key);
  await tx.done;
  return row;
};

const getAllRows = async (db: IDBPDatabase): Promise<StoredRow[]> => {
  const tx = db.transaction("lofi_rows", "readonly");
  const store = tx.objectStore("lofi_rows");
  const rows = (await store.getAll()) as StoredRow[];
  await tx.done;
  return rows;
};

describe("IndexedDbAdapter", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("applies create/update/delete with idempotency and versioning", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer")),
      ),
    );

    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    const result = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada", age: 30 },
        },
      ],
    });

    expect(result.applied).toBe(true);

    const db = await openDb(dbName);
    const row = await getRow(db, ["app", "app", "users", "user-1"]);
    if (!row) {
      throw new Error("Expected row to exist");
    }
    expect(row.data).toMatchObject({ name: "Ada", age: 30 });
    expect(row._lofi.internalId).toBe(1);
    expect(row._lofi.version).toBe(1);

    const updateResult = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs2",
      uowId: "uow-vs2",
      mutations: [
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs2",
          set: { age: 31 },
        },
      ],
    });

    expect(updateResult.applied).toBe(true);
    const updated = await getRow(db, ["app", "app", "users", "user-1"]);
    if (!updated) {
      throw new Error("Expected updated row to exist");
    }
    expect(updated.data).toMatchObject({ name: "Ada", age: 31 });
    expect(updated._lofi.version).toBe(2);

    const deleteResult = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs3",
      uowId: "uow-vs3",
      mutations: [
        {
          op: "delete",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs3",
        },
      ],
    });

    expect(deleteResult.applied).toBe(true);
    const deleted = await getRow(db, ["app", "app", "users", "user-1"]);
    expect(deleted).toBeUndefined();

    const missingUpdate = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs4",
      uowId: "uow-vs4",
      mutations: [
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-missing",
          versionstamp: "vs4",
          set: { age: 20 },
        },
      ],
    });

    expect(missingUpdate.applied).toBe(true);
    const missingRow = await getRow(db, ["app", "app", "users", "user-missing"]);
    expect(missingRow).toBeUndefined();

    const duplicate = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs2",
      uowId: "uow-vs2",
      mutations: [
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs2",
          set: { age: 32 },
        },
      ],
    });

    expect(duplicate.applied).toBe(false);
  });

  it("maintains per-table internal IDs and reference normalization", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace" },
        },
      ],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs2",
      uowId: "uow-vs2",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-1",
          versionstamp: "vs2",
          values: { title: "Hello", authorId: "user-2" },
        },
      ],
    });

    const db = await openDb(dbName);
    const user1 = await getRow(db, ["app", "app", "users", "user-1"]);
    const user2 = await getRow(db, ["app", "app", "users", "user-2"]);
    const post = await getRow(db, ["app", "app", "posts", "post-1"]);

    if (!user1 || !user2 || !post) {
      throw new Error("Expected rows to exist");
    }
    expect(user1._lofi.internalId).toBe(1);
    expect(user2._lofi.internalId).toBe(2);
    expect(post._lofi.norm["authorId"]).toBe(2);
  });

  it("ignores _shard system values in stored rows", async () => {
    const appSchema = createShardSchema();
    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada", _shard: "shard-a" },
        },
      ],
    });

    const db = await openDb(dbName);
    const row = await getRow(db, ["app", "app", "users", "user-1"]);
    if (!row) {
      throw new Error("Expected row to exist");
    }
    expect(row.data).not.toHaveProperty("_shard");
    expect(row._lofi.norm["_shard"]).toBeUndefined();
  });

  it("throws on unknown schemas by default", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    await expect(
      adapter.applyOutboxEntry({
        sourceKey: "app::outbox",
        versionstamp: "vs1",
        uowId: "uow-vs1",
        mutations: [
          {
            op: "create",
            schema: "unknown",
            table: "users",
            externalId: "user-1",
            versionstamp: "vs1",
            values: { name: "Ada" },
          },
        ],
      }),
    ).rejects.toThrow("Unknown outbox schema: unknown");
  });

  it("can ignore unknown schemas when configured", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      ignoreUnknownSchemas: true,
    });

    const result = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "unknown",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    expect(result.applied).toBe(true);
    const db = await openDb(dbName);
    const row = await getRow(db, ["app", "app", "users", "user-1"]);
    const inboxRow = await getInboxRow(db, ["app::outbox", "uow-vs1", "vs1"]);
    expect(row).toBeUndefined();
    expect(inboxRow).toBeDefined();
  });

  it("aborts the transaction when a mutation fails", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string")),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    await expect(
      adapter.applyOutboxEntry({
        sourceKey: "app::outbox",
        versionstamp: "vs1",
        uowId: "uow-vs1",
        mutations: [
          {
            op: "create",
            schema: "app",
            table: "users",
            externalId: "user-1",
            versionstamp: "vs1",
            values: { name: "Ada" },
          },
          {
            op: "create",
            schema: "app",
            table: "posts",
            externalId: "post-1",
            versionstamp: "vs1",
            values: { title: "Hello", authorId: 123 },
          },
        ],
      }),
    ).rejects.toThrow("Expected reference value to be external ID string");

    const db = await openDb(dbName);
    const userRow = await getRow(db, ["app", "app", "users", "user-1"]);
    const postRow = await getRow(db, ["app", "app", "posts", "post-1"]);
    const inboxRow = await getInboxRow(db, ["app::outbox", "uow-vs1", "vs1"]);
    const seqMeta = await getMeta(db, "app::seq::app::users");

    expect(userRow).toBeUndefined();
    expect(postRow).toBeUndefined();
    expect(inboxRow).toBeUndefined();
    expect(seqMeta).toBeUndefined();
    db.close();
  });

  it("creates indexes and clears rows on schema fingerprint changes", async () => {
    const schemaV1 = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .createIndex("idx_name", ["name"]),
      ),
    );

    const dbName = createDbName();
    const adapterV1 = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: schemaV1 }],
    });

    await adapterV1.setMeta("app::outbox", "vs0");
    await adapterV1.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    const db = await openDb(dbName);
    const rows = await getAllRows(db);
    expect(rows).toHaveLength(1);

    const rowsStore = db.transaction("lofi_rows", "readonly").objectStore("lofi_rows");
    expect(rowsStore.indexNames.contains("idx_schema_table")).toBe(true);
    expect(rowsStore.indexNames.contains("idx__app__users__idx_name")).toBe(true);
    db.close();

    const schemaV2 = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_name", ["name"])
          .createIndex("idx_age", ["age"]),
      ),
    );

    const adapterV2 = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: schemaV2 }],
    });

    await adapterV2.getMeta("app::schema_fingerprint");

    const dbAfter = await openDb(dbName);
    const clearedRows = await getAllRows(dbAfter);
    expect(clearedRows).toHaveLength(0);
    const cursorMeta = await adapterV2.getMeta("app::outbox");
    expect(cursorMeta).toBeUndefined();
    dbAfter.close();
  });
});
