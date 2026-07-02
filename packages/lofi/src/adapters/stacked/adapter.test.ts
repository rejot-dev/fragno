import { describe, expect, it, assert } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

import { defineLocalProjection } from "../../local/projection";
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
  it("merges local schema projections from base and optimistic overlay", async () => {
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
    const base = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [localSchema],
      projections: [projection],
    });
    const overlay = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [localSchema],
      projections: [projection],
    });
    const stacked = new StackedLofiAdapter({ base, overlay, schemas: [appSchema] });

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
      ],
    });
    await stacked.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-2",
        versionstamp: "local-1",
        values: { name: "Bea" },
      },
    ]);

    const stackedQuery = stacked.createQueryEngine(localSchema);
    await expect(
      stackedQuery.find("user_cards", (b) => b.whereIndex("primary")),
    ).resolves.toMatchObject([{ displayName: "ADA" }, { displayName: "BEA" }]);

    const baseQuery = base.createQueryEngine(localSchema);
    await expect(
      baseQuery.find("user_cards", (b) => b.whereIndex("primary")),
    ).resolves.toMatchObject([{ displayName: "ADA" }]);
  });

  it("lets optimistic local projections read existing base local rows", async () => {
    //  1. LofiClient syncs an outbox entry into the base adapter.
    //  2. Base adapter runs local projections and creates local view rows.
    //  3. User queues/runs an optimistic command through LofiOverlayManager.
    //  4. The local command executes against overlayManager.stackedAdapter.
    //  5. StackedLofiAdapter.applyMutations() calls overlay.applyMutations(..., { projectionMutations: originalMutations }).
    //  6. Overlay projections call read.get(...), but InMemoryLofiAdapter.collectProjectionMutations() stages reads only from this.store —
    //     the overlay store — so it does not see base local rows.

    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local_user_counts", (s) =>
      s.addTable("user_counts", (t) =>
        t.addColumn("id", idColumn()).addColumn("count", column("integer")),
      ),
    );
    const projection = defineLocalProjection({
      retrieve: ({ match, read }) => {
        const userMutations = match.all(appSchema, "users", ["create", "update"]);
        return userMutations.length > 0
          ? read.get(localSchema, "user_counts", userMutations[0]!.externalId)
          : undefined;
      },
      mutate: ({ mutations, match, retrieved, tx }) => {
        const userCounts = tx.forSchema(localSchema);
        for (const mutation of mutations) {
          const userMutation = match.one(mutation, appSchema, "users", ["create", "update"]);
          if (!userMutation) {
            continue;
          }

          const nextCount = ((retrieved as { count?: number } | undefined)?.count ?? 0) + 1;
          if (retrieved) {
            userCounts.update("user_counts", userMutation.externalId, (b) =>
              b.set({ count: nextCount }),
            );
          } else {
            userCounts.create("user_counts", { id: userMutation.externalId, count: nextCount });
          }
        }
      },
    });
    const base = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [localSchema],
      projections: [projection],
    });
    const overlay = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [localSchema],
      projections: [projection],
    });
    const stacked = new StackedLofiAdapter({ base, overlay, schemas: [appSchema] });

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
      ],
    });
    await stacked.applyMutations([
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "local-1",
        set: { name: "Grace" },
      },
    ]);

    const counts = await stacked
      .createQueryEngine(localSchema)
      .find("user_counts", (b) => b.whereIndex("primary"));
    expect(counts).toMatchObject([{ count: 2 }]);
  });

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
            .addColumn("authorId", referenceColumn({ table: "users" }))
            .addColumn("title", column("string"))
            .createIndex("idx_author", ["authorId"]),
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
      b
        .joinOne("author", "users", (author) =>
          author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
        )
        .whereIndex("idx_author"),
    );

    expect(joined).toHaveLength(1);
    assert(joined[0].author?.name === "Grace");
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
    assert(firstPage.hasNextPage);
    expect(firstPage.cursor).toBeDefined();

    const secondPage = await query.findWithCursor("users", (b) =>
      b.whereIndex("idx_age").orderByIndex("idx_age", "asc").pageSize(2).after(firstPage.cursor!),
    );

    expect(secondPage.items).toHaveLength(1);
    assert(!secondPage.hasNextPage);
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
