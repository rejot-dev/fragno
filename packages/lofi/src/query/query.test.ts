import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import { IndexedDbAdapter } from "../mod";

const createDbName = () => `lofi-query-${Math.random().toString(16).slice(2)}`;

describe("IndexedDbAdapter query engine", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
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
});
