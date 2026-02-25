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
import { IndexedDbAdapter } from "../mod";

const createDbName = () => `lofi-query-${Math.random().toString(16).slice(2)}`;

const createShardSchema = () =>
  schema("app", (s) =>
    s.addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("_shard", column("string").hidden())
        .createIndex("idx_name", ["name"]),
    ),
  );

describe("IndexedDbAdapter query engine", () => {
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

  it("supports whereIndex, orderByIndex, select, and selectCount", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_age", ["age"]),
      ),
    );

    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
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
          values: { name: "Ada", age: 30 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace", age: 30 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-3",
          versionstamp: "vs1",
          values: { name: "Linus", age: 40 },
        },
      ],
    });

    const query = adapter.createQueryEngine(appSchema);

    const ordered = await query.find("users", (b) =>
      b.whereIndex("idx_age", (eb) => eb("age", ">=", 30)).orderByIndex("idx_age", "asc"),
    );

    expect(ordered.map((row) => row.id.externalId)).toEqual(["user-1", "user-2", "user-3"]);

    const selected = await query.find("users", (b) =>
      b.whereIndex("idx_age").select(["id", "name"]),
    );

    expect(selected[0]).toHaveProperty("id");
    expect(selected[0]).toHaveProperty("name");
    expect(selected[0]).not.toHaveProperty("age");

    const count = await query.find("users", (b) => b.whereIndex("idx_age").selectCount());
    expect(count).toBe(3);
  });

  it("resolves reference filters and join semantics", async () => {
    const appSchema = schema("app", (s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("authorId", referenceColumn())
            .addColumn("title", column("string"))
            .createIndex("idx_author", ["authorId"]),
        )
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "authorId" },
          to: { table: "users", column: "id" },
        }),
    );

    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
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
        {
          op: "create",
          schema: "app",
          table: "posts",
          externalId: "post-2",
          versionstamp: "vs2",
          values: { title: "Missing", authorId: "user-missing" },
        },
      ],
    });

    const query = adapter.createQueryEngine(appSchema);

    const joined = await query.find("posts", (b) =>
      b.whereIndex("idx_author", (eb) => eb("authorId", "=", "user-2")).join((j) => j.author()),
    );

    expect(joined).toHaveLength(1);
    if (!joined[0].author) {
      throw new Error("Expected author join to be present");
    }
    expect(joined[0].author.name).toBe("Grace");

    const missingRef = await query.find("posts", (b) =>
      b.whereIndex("primary").select(["id", "authorId"]),
    );

    const missing = missingRef.find((row) => row.id.externalId === "post-2");
    expect(missing?.authorId).toBeNull();
  });

  it("paginates with cursor using index ordering", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_age", ["age"]),
      ),
    );

    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
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
          values: { name: "Ada", age: 20 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace", age: 30 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-3",
          versionstamp: "vs1",
          values: { name: "Linus", age: 40 },
        },
      ],
    });

    const query = adapter.createQueryEngine(appSchema);

    const firstPage = await query.findWithCursor("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc").pageSize(2),
    );

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeDefined();

    const secondPage = await query.findWithCursor("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc").pageSize(2).after(firstPage.cursor!),
    );

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasNextPage).toBe(false);
  });

  it("orders and filters binary columns without Buffer", async () => {
    const originalBuffer = (globalThis as { Buffer?: unknown }).Buffer;

    const runWithoutBuffer = async <T>(fn: () => Promise<T>): Promise<T> => {
      (globalThis as { Buffer?: unknown }).Buffer = undefined;
      try {
        const promise = fn();
        (globalThis as { Buffer?: unknown }).Buffer = originalBuffer;
        return await promise;
      } finally {
        (globalThis as { Buffer?: unknown }).Buffer = originalBuffer;
      }
    };

    const appSchema = schema("app", (s) =>
      s.addTable("files", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("hash", column("binary"))
          .createIndex("idx_hash", ["hash"]),
      ),
    );

    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    await runWithoutBuffer(() =>
      adapter.applyOutboxEntry({
        sourceKey: "app::outbox",
        versionstamp: "vs1",
        uowId: "uow-vs1",
        mutations: [
          {
            op: "create",
            schema: "app",
            table: "files",
            externalId: "file-1",
            versionstamp: "vs1",
            values: { hash: new Uint8Array([0x00, 0x01]) },
          },
          {
            op: "create",
            schema: "app",
            table: "files",
            externalId: "file-2",
            versionstamp: "vs1",
            values: { hash: new Uint8Array([0x00, 0x02]) },
          },
          {
            op: "create",
            schema: "app",
            table: "files",
            externalId: "file-3",
            versionstamp: "vs1",
            values: { hash: new Uint8Array([0x01]) },
          },
        ],
      }),
    );

    const query = adapter.createQueryEngine(appSchema);
    const ordered = await runWithoutBuffer(() =>
      query.find("files", (b) => b.whereIndex("idx_hash").orderByIndex("idx_hash", "asc")),
    );

    expect(ordered.map((row) => row.id.externalId)).toEqual(["file-1", "file-2", "file-3"]);

    const match = await runWithoutBuffer(() =>
      query.find("files", (b) =>
        b.whereIndex("idx_hash", (eb) => eb("hash", "=", new Uint8Array([0x00, 0x02]))),
      ),
    );

    expect(match).toHaveLength(1);
    expect(match[0]?.id.externalId).toBe("file-2");
  });

  it("ignores _shard in select lists", async () => {
    const appSchema = createShardSchema();

    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
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

    const query = adapter.createQueryEngine(appSchema);
    const selected = await query.find("users", (b) =>
      b.whereIndex("idx_name").select(["id", "name", "_shard"]),
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveProperty("id");
    expect(selected[0]).toHaveProperty("name");
    expect(selected[0]).not.toHaveProperty("_shard");
  });
});
