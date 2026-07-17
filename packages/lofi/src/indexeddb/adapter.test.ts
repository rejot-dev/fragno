import { beforeEach, describe, expect, it, assert } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
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
import { openDB, type IDBPDatabase } from "idb";

import { defineLocalProjection, IndexedDbAdapter } from "../mod";

const createDbName = () => `lofi-test-${Math.random().toString(16).slice(2)}`;

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

const getInboxRow = async (db: IDBPDatabase, key: IDBValidKey): Promise<unknown> => {
  const tx = db.transaction("lofi_inbox", "readonly");
  const store = tx.objectStore("lofi_inbox");
  const row = await store.get(key);
  await tx.done;
  return row;
};

const getMeta = async (db: IDBPDatabase, key: IDBValidKey): Promise<unknown> => {
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

  it("normalizes default schema names for outbox application and queries", async () => {
    const appSchema = schema("app-fragment", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
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
          schema: "app-fragment",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    const users = await adapter
      .createQueryEngine(appSchema)
      .find("users", (b) => b.whereIndex("primary"));
    expect(users).toEqual([expect.objectContaining({ name: "Ada" })]);

    const db = await openDb(dbName);
    const row = await getRow(db, ["app", "app_fragment", "users", "user-1"]);
    expect(row?.data).toMatchObject({ name: "Ada" });
    db.close();
  });

  it("uses explicit schema aliases for source matching, projection writes, and queries", async () => {
    const appSchema = schema("app-fragment", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local-user-view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema, schemaName: "custom_app" }],
      localSchemas: [{ schema: localSchema, schemaName: "custom_local" }],
      projections: [
        defineLocalProjection({
          mutate: ({ mutations, match, tx }) => {
            const userCards = tx.forSchema(localSchema);
            for (const rawMutation of mutations) {
              const mutation = match.one(rawMutation, appSchema, "users", "create");
              if (!mutation) {
                continue;
              }
              userCards.create("user_cards", {
                id: mutation.externalId,
                displayName: String(mutation.values.name),
              });
            }
          },
        }),
      ],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app-fragment",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    const users = await adapter
      .createQueryEngine(appSchema)
      .find("users", (b) => b.whereIndex("primary"));
    const cards = await adapter
      .createQueryEngine(localSchema)
      .find("user_cards", (b) => b.whereIndex("primary"));
    expect(users).toEqual([expect.objectContaining({ name: "Ada" })]);
    expect(cards).toEqual([expect.objectContaining({ displayName: "Ada" })]);

    const db = await openDb(dbName);
    expect(await getRow(db, ["app", "custom_app", "users", "user-1"])).toBeDefined();
    expect(await getRow(db, ["app", "custom_local", "user_cards", "user-1"])).toBeDefined();
    db.close();
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

    assert(result.applied);

    const db = await openDb(dbName);
    const row = await getRow(db, ["app", "app", "users", "user-1"]);
    if (!row) {
      throw new Error("Expected row to exist");
    }
    expect(row.data).toMatchObject({ name: "Ada", age: 30 });
    assert(row._lofi.internalId === 1);
    assert(row._lofi.version === 1);

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

    assert(updateResult.applied);
    const updated = await getRow(db, ["app", "app", "users", "user-1"]);
    if (!updated) {
      throw new Error("Expected updated row to exist");
    }
    expect(updated.data).toMatchObject({ name: "Ada", age: 31 });
    assert(updated._lofi.version === 2);

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

    assert(deleteResult.applied);
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

    assert(missingUpdate.applied);
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

    assert(!duplicate.applied);
  });

  it("maintains per-table internal IDs and reference normalization", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn({ table: "users" }))
            .addColumn("title", column("string")),
        ),
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
    assert(user1._lofi.internalId === 1);
    assert(user2._lofi.internalId === 2);
    assert(post._lofi.norm["authorId"] === 2);
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

    assert(result.applied);
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
            .addColumn("authorId", referenceColumn({ table: "users" }))
            .addColumn("title", column("string")),
        ),
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

  it("recreates managed indexes when an existing index definition changes", async () => {
    const schemaV1 = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .createIndex("idx_lookup", ["name"]),
      ),
    );

    const dbName = createDbName();
    const adapterV1 = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: schemaV1 }],
    });

    await adapterV1.getMeta("app::schema_fingerprint");

    const dbBefore = await openDb(dbName);
    const rowsStoreBefore = dbBefore.transaction("lofi_rows", "readonly").objectStore("lofi_rows");
    const indexBefore = rowsStoreBefore.index("idx__app__users__idx_lookup");
    expect(indexBefore.keyPath).toEqual(["endpoint", "schema", "table", "_lofi.norm.name", "id"]);
    assert(!indexBefore.unique);
    dbBefore.close();

    const schemaV2 = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .createIndex("idx_lookup", ["email"], { unique: true }),
      ),
    );

    const adapterV2 = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: schemaV2 }],
    });

    await adapterV2.getMeta("app::schema_fingerprint");

    const dbAfter = await openDb(dbName);
    const rowsStoreAfter = dbAfter.transaction("lofi_rows", "readonly").objectStore("lofi_rows");
    const indexAfter = rowsStoreAfter.index("idx__app__users__idx_lookup");
    expect(indexAfter.keyPath).toEqual(["endpoint", "schema", "table", "_lofi.norm.email", "id"]);
    assert(indexAfter.unique);
    dbAfter.close();
  });

  it("clears registered custom cursor state on schema fingerprint changes", async () => {
    const schemaV1 = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    const dbName = createDbName();
    const adapterV1 = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: schemaV1 }],
    });

    const customCursorKey = "custom-client::cursor";
    await adapterV1.applyOutboxEntry({
      sourceKey: customCursorKey,
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
    await adapterV1.setMeta(customCursorKey, "vs1");

    const schemaV2 = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .createIndex("idx_email", ["email"]),
      ),
    );

    const adapterV2 = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: schemaV2 }],
    });

    await adapterV2.getMeta("app::schema_fingerprint");

    const dbAfter = await openDb(dbName);
    expect(await getInboxRow(dbAfter, [customCursorKey, "uow-vs1", "vs1"])).toBeUndefined();
    expect(await adapterV2.getMeta(customCursorKey)).toBeUndefined();
    dbAfter.close();
  });

  it("lets projections from multiple indexeddb outbox sources write into the same local database", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local_user_view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [
        defineLocalProjection({
          mutate: ({ mutations, match, source, tx }) => {
            const userCards = tx.forSchema(localSchema);
            for (const rawMutation of mutations) {
              const mutation = match.one(rawMutation, appSchema, "users", "create");
              if (!mutation) {
                continue;
              }

              userCards.create("user_cards", {
                id: `${source.sourceKey}:${mutation.externalId}`,
                displayName: `${source.sourceKey}:${mutation.values.name}`,
              });
            }
          },
        }),
      ],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "org-a::outbox",
      versionstamp: "vs-a1",
      uowId: "uow-a1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-a",
          versionstamp: "vs-a1",
          values: { name: "Ada" },
        },
      ],
    });
    await adapter.applyOutboxEntry({
      sourceKey: "org-b::outbox",
      versionstamp: "vs-b1",
      uowId: "uow-b1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-b",
          versionstamp: "vs-b1",
          values: { name: "Bob" },
        },
      ],
    });

    const cards = await adapter
      .createQueryEngine(localSchema)
      .find("user_cards", (b) => b.whereIndex("primary"));
    expect(cards).toMatchObject([
      { displayName: "org-a::outbox:Ada" },
      { displayName: "org-b::outbox:Bob" },
    ]);

    const db = await openDb(dbName);
    expect(
      await getRow(db, ["app", "local_user_view", "user_cards", "org-a::outbox:user-a"]),
    ).toBeDefined();
    expect(
      await getRow(db, ["app", "local_user_view", "user_cards", "org-b::outbox:user-b"]),
    ).toBeDefined();
    db.close();
  });

  it("materializes local schema rows in the same transaction", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local_user_view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    const projection = defineLocalProjection({
      retrieve: ({ mutations, match, read }) => {
        let matched = false;
        const existingById: Record<string, ReturnType<typeof read.get>> = {};
        for (const rawMutation of mutations) {
          const mutation = match.one(rawMutation, appSchema, "users", [
            "create",
            "update",
            "delete",
          ]);
          if (!mutation) {
            continue;
          }
          matched = true;
          if (mutation.op === "delete") {
            continue;
          }
          const name = mutation.op === "create" ? mutation.values.name : mutation.set.name;
          if (typeof name === "string") {
            existingById[mutation.externalId] = read.get(
              localSchema,
              "user_cards",
              mutation.externalId,
            );
          }
        }
        return matched ? { existingById } : undefined;
      },
      mutate: ({ mutations, match, retrieved, tx }) => {
        const userCards = tx.forSchema(localSchema);
        for (const rawMutation of mutations) {
          const mutation = match.one(rawMutation, appSchema, "users", ["create", "update"]);
          if (!mutation) {
            continue;
          }
          const name = mutation.op === "create" ? mutation.values.name : mutation.set.name;
          if (typeof name !== "string") {
            continue;
          }
          const values = { displayName: name.toUpperCase() };
          if (retrieved.existingById[mutation.externalId]) {
            userCards.update("user_cards", mutation.externalId, (b) => b.set(values));
          } else {
            userCards.create("user_cards", { id: mutation.externalId, ...values });
          }
        }
      },
    });

    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [projection],
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
      ],
    });

    const query = adapter.createQueryEngine(localSchema);
    await expect(query.find("user_cards", (b) => b.whereIndex("primary"))).resolves.toMatchObject([
      { displayName: "ADA" },
    ]);

    const db = await openDb(dbName);
    const localRow = await getRow(db, ["app", "local_user_view", "user_cards", "user-1"]);
    expect(localRow?.data).toMatchObject({ displayName: "ADA" });
    db.close();
  });

  it("skips indexeddb mutate when retrieve returns undefined", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local_user_view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    let skippedMutateRuns = 0;
    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [
        defineLocalProjection({
          retrieve: () => undefined,
          mutate: () => {
            skippedMutateRuns += 1;
          },
        }),
      ],
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
      ],
    });

    expect(skippedMutateRuns).toBe(0);
    const db = await openDb(dbName);
    expect(await getRow(db, ["app", "local_user_view", "user_cards", "user-1"])).toBeUndefined();
    db.close();
  });

  it("does not rerun projections for duplicate indexeddb outbox entries", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local_user_view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    let projectionRuns = 0;
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [
        {
          mutate: ({ mutations, tx }) => {
            const userCards = tx.forSchema(localSchema);
            for (const mutation of mutations) {
              projectionRuns += 1;
              userCards.create("user_cards", {
                id: mutation.externalId,
                displayName: "ADA",
              });
            }
          },
        },
      ],
    });
    const entry = {
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create" as const,
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    };

    await adapter.applyOutboxEntry(entry);
    await adapter.applyOutboxEntry(entry);

    expect(projectionRuns).toBe(1);
  });

  it("aborts indexeddb server rows and inbox entry when projection fails", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local_user_view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    const dbName = createDbName();
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [
        {
          mutate: () => {
            throw new Error("projection failed");
          },
        },
      ],
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
        ],
      }),
    ).rejects.toThrow("projection failed");

    const db = await openDb(dbName);
    expect(await getRow(db, ["app", "app", "users", "user-1"])).toBeUndefined();
    expect(await getInboxRow(db, ["app::outbox", "uow-vs1", "vs1"])).toBeUndefined();
    db.close();
  });

  it("rejects invalid indexeddb local schema and projection targets", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    expect(
      () =>
        new IndexedDbAdapter({
          dbName: createDbName(),
          endpointName: "app",
          schemas: [{ schema: appSchema }],
          localSchemas: [{ schema: appSchema }],
        }),
    ).toThrow("schema name must be unique");

    const localSchema = schema("local_user_view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [
        {
          mutate: ({ mutations, tx }) => {
            tx.forSchema(appSchema).update("users", mutations[0]!.externalId, (b) =>
              b.set({ name: "Bad" }),
            );
          },
        },
      ],
    });

    await expect(
      adapter.applyMutations([
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "local-1",
          values: { name: "Ada" },
        },
      ]),
    ).rejects.toThrow("Projection writes must target a local schema");

    const readAdapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
      localSchemas: [{ schema: localSchema }],
      projections: [
        {
          retrieve: ({ mutations, read }) => ({
            row: read.get(appSchema, "users", mutations[0]!.externalId),
          }),
          mutate: () => {},
        },
      ],
    });

    await expect(
      readAdapter.applyMutations([
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "local-1",
          values: { name: "Ada" },
        },
      ]),
    ).rejects.toThrow("Projection reads must target a local schema");
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
    assert(rowsStore.indexNames.contains("idx_schema_table"));
    assert(rowsStore.indexNames.contains("idx__app__users__idx_name"));
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
