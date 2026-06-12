import { describe, expect, it, assert } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

import { createInMemoryQueryEngine } from "./query";
import { InMemoryLofiStore } from "./store";

const createStore = (appSchema: ReturnType<typeof schema>) =>
  new InMemoryLofiStore({ endpointName: "app", schemas: [appSchema] });

describe("in-memory query engine", () => {
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

    const store = createStore(appSchema);

    store.applyMutations([
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
    ]);

    const query = createInMemoryQueryEngine({ schema: appSchema, store });

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
            .addColumn("authorId", referenceColumn({ table: "users" }))
            .addColumn("title", column("string"))
            .createIndex("idx_author", ["authorId"]),
        ),
    );

    const store = createStore(appSchema);

    store.applyMutations([
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
    ]);

    const query = createInMemoryQueryEngine({ schema: appSchema, store });

    const joined = await query.find("posts", (b) =>
      b
        .whereIndex("idx_author", (eb) => eb("authorId", "=", "user-2"))
        .joinOne("author", "users", (author) =>
          author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
        ),
    );

    expect(joined).toHaveLength(1);
    if (!joined[0].author) {
      throw new Error("Expected author join to be present");
    }
    assert(joined[0].author.name === "Grace");

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

    const store = createStore(appSchema);

    store.applyMutations([
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
    ]);

    const query = createInMemoryQueryEngine({ schema: appSchema, store });

    const firstPage = await query.findWithCursor("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc").pageSize(2),
    );

    expect(firstPage.items).toHaveLength(2);
    assert(firstPage.hasNextPage);
    expect(firstPage.cursor).toBeDefined();

    const secondPage = await query.findWithCursor("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc").pageSize(2).after(firstPage.cursor!),
    );

    expect(secondPage.items).toHaveLength(1);
    assert(!secondPage.hasNextPage);
  });

  it("orders and filters encoded hash strings", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("files", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("hash", column("string"))
          .createIndex("idx_hash", ["hash"]),
      ),
    );

    const store = createStore(appSchema);

    store.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "files",
        externalId: "file-1",
        versionstamp: "vs1",
        values: { hash: "0001" },
      },
      {
        op: "create",
        schema: "app",
        table: "files",
        externalId: "file-2",
        versionstamp: "vs1",
        values: { hash: "0002" },
      },
      {
        op: "create",
        schema: "app",
        table: "files",
        externalId: "file-3",
        versionstamp: "vs1",
        values: { hash: "01" },
      },
    ]);

    const query = createInMemoryQueryEngine({ schema: appSchema, store });
    const ordered = await query.find("files", (b) =>
      b.whereIndex("idx_hash").orderByIndex("idx_hash", "asc"),
    );

    expect(ordered.map((row) => row.id.externalId)).toEqual(["file-1", "file-2", "file-3"]);

    const match = await query.find("files", (b) =>
      b.whereIndex("idx_hash", (eb) => eb("hash", "=", "0002")),
    );

    expect(match).toHaveLength(1);
    assert(match[0]?.id.externalId === "file-2");
  });
});
