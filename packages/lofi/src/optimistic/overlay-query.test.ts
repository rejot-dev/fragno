import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import { OptimisticOverlayStore } from "./overlay-store";
import { createOverlayQueryEngine } from "./overlay-query";

const createStore = (appSchema: ReturnType<typeof schema>) =>
  new OptimisticOverlayStore({ endpointName: "app", schemas: [appSchema] });

describe("optimistic overlay query engine", () => {
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

    const query = createOverlayQueryEngine({ schema: appSchema, store });

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

    const query = createOverlayQueryEngine({ schema: appSchema, store });

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

    const query = createOverlayQueryEngine({ schema: appSchema, store });

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

  it("orders and filters binary columns", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("files", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("hash", column("binary"))
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
    ]);

    const query = createOverlayQueryEngine({ schema: appSchema, store });
    const ordered = await query.find("files", (b) =>
      b.whereIndex("idx_hash").orderByIndex("idx_hash", "asc"),
    );

    expect(ordered.map((row) => row.id.externalId)).toEqual(["file-1", "file-2", "file-3"]);

    const match = await query.find("files", (b) =>
      b.whereIndex("idx_hash", (eb) => eb("hash", "=", new Uint8Array([0x00, 0x02]))),
    );

    expect(match).toHaveLength(1);
    expect(match[0]?.id.externalId).toBe("file-2");
  });
});
