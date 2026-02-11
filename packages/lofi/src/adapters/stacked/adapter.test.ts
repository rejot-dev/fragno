import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import { InMemoryLofiAdapter } from "../in-memory/adapter";
import { StackedLofiAdapter } from "./adapter";

const createStackedAdapters = (appSchema: ReturnType<typeof schema>) => {
  const base = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
  const overlay = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });
  const stacked = new StackedLofiAdapter({
    base,
    overlay,
    schemas: [appSchema],
  });

  return { base, overlay, stacked };
};

describe("StackedLofiAdapter", () => {
  it("orders using overlay updates that change ordering", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_age", ["age"]),
      ),
    );

    const { stacked } = createStackedAdapters(appSchema);

    await stacked.applyOutboxEntry({
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

    await stacked.applyMutations([
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-3",
        versionstamp: "vs2",
        set: { age: 10 },
      },
    ]);

    const query = stacked.createQueryEngine(appSchema);
    const ordered = await query.find("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc"),
    );

    expect(ordered.map((row) => row.id.externalId)).toEqual(["user-3", "user-1", "user-2"]);
  });

  it("suppresses base rows with overlay tombstones", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    const { stacked } = createStackedAdapters(appSchema);

    await stacked.applyOutboxEntry({
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

    await stacked.applyMutations([
      {
        op: "delete",
        schema: "app",
        table: "users",
        externalId: "user-2",
        versionstamp: "vs2",
      },
    ]);

    const query = stacked.createQueryEngine(appSchema);
    const rows = await query.find("users", (b) => b.whereIndex("primary"));

    expect(rows.map((row) => row.id.externalId)).toEqual(["user-1"]);
  });

  it("inserts overlay-only rows into the result set", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_age", ["age"]),
      ),
    );

    const { stacked } = createStackedAdapters(appSchema);

    await stacked.applyOutboxEntry({
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
      ],
    });

    await stacked.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-3",
        versionstamp: "vs2",
        values: { name: "Linus", age: 25 },
      },
    ]);

    const query = stacked.createQueryEngine(appSchema);
    const ordered = await query.find("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc"),
    );

    expect(ordered.map((row) => row.id.externalId)).toEqual(["user-1", "user-3", "user-2"]);
  });

  it("patches joined rows from the overlay", async () => {
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

    const { stacked } = createStackedAdapters(appSchema);

    await stacked.applyOutboxEntry({
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
          values: { title: "Hello", authorId: "user-1" },
        },
      ],
    });

    await stacked.applyMutations([
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs2",
        set: { name: "Grace" },
      },
    ]);

    const query = stacked.createQueryEngine(appSchema);
    const joined = await query.find("posts", (b) =>
      b.whereIndex("idx_author").join((j) => j.author()),
    );

    expect(joined).toHaveLength(1);
    expect(joined[0].author?.name).toBe("Grace");
  });

  it("paginates with cursor after overlay merges", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_age", ["age"]),
      ),
    );

    const { stacked } = createStackedAdapters(appSchema);

    await stacked.applyOutboxEntry({
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

    const query = stacked.createQueryEngine(appSchema);
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

  it("iteratively fetches base pages when overlay removes rows", async () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer"))
          .createIndex("idx_age", ["age"]),
      ),
    );

    const { stacked } = createStackedAdapters(appSchema);

    await stacked.applyOutboxEntry({
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
          values: { name: "Ada", age: 10 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs1",
          values: { name: "Grace", age: 20 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-3",
          versionstamp: "vs1",
          values: { name: "Linus", age: 30 },
        },
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-4",
          versionstamp: "vs1",
          values: { name: "Bjarne", age: 40 },
        },
      ],
    });

    await stacked.applyMutations([
      {
        op: "delete",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs2",
      },
      {
        op: "delete",
        schema: "app",
        table: "users",
        externalId: "user-2",
        versionstamp: "vs2",
      },
    ]);

    const query = stacked.createQueryEngine(appSchema);
    const firstPage = await query.findWithCursor("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc").pageSize(2),
    );

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items.map((row) => row.id.externalId)).toEqual(["user-3", "user-4"]);
  });
});
