import { describe, expect, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { defineLocalProjection } from "../../local/projection";
import { InMemoryLofiAdapter } from "./adapter";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const userViewSchema = schema("local_user_view", (s) =>
  s.addTable("user_cards", (t) =>
    t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
  ),
);

const userMutationCountSchema = schema("local_user_mutation_counts", (s) =>
  s.addTable("user_mutation_counts", (t) =>
    t.addColumn("id", idColumn()).addColumn("count", column("integer")),
  ),
);

const userViewProjection = defineLocalProjection({
  retrieve: ({ mutations, match, read }) => {
    let matched = false;
    const existingById: Record<string, ReturnType<typeof read.get>> = {};
    for (const rawMutation of mutations) {
      const mutation = match.one(rawMutation, appSchema, "users", ["create", "update", "delete"]);
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
          userViewSchema,
          "user_cards",
          mutation.externalId,
        );
      }
    }
    return matched ? { existingById } : undefined;
  },
  mutate: ({ mutations, match, retrieved, tx }) => {
    const userCards = tx.forSchema(userViewSchema);
    for (const rawMutation of mutations) {
      const mutation = match.one(rawMutation, appSchema, "users", ["create", "update", "delete"]);
      if (!mutation) {
        continue;
      }

      if (mutation.op === "delete") {
        userCards.delete("user_cards", mutation.externalId);
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

describe("InMemoryLofiAdapter", () => {
  it("normalizes default schema names for outbox application and queries", async () => {
    const fragmentSchema = schema("app-fragment", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [fragmentSchema],
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
      .createQueryEngine(fragmentSchema)
      .find("users", (b) => b.whereIndex("primary"));
    expect(users).toEqual([expect.objectContaining({ name: "Ada" })]);
  });

  it("matches raw source schema names and writes through raw local schema names in projections", async () => {
    const fragmentSchema = schema("app-fragment", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const localSchema = schema("local-user-view", (s) =>
      s.addTable("user_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
      ),
    );
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [fragmentSchema],
      localSchemas: [localSchema],
      projections: [
        defineLocalProjection({
          mutate: ({ mutations, match, tx }) => {
            const userCards = tx.forSchema(localSchema);
            for (const rawMutation of mutations) {
              const mutation = match.one(rawMutation, fragmentSchema, "users", "create");
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

    const cards = await adapter
      .createQueryEngine(localSchema)
      .find("user_cards", (b) => b.whereIndex("primary"));
    expect(cards).toEqual([expect.objectContaining({ displayName: "Ada" })]);
  });

  it("lets projections from multiple outbox sources write into the same local database", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [
        defineLocalProjection({
          mutate: ({ mutations, match, source, tx }) => {
            const userCards = tx.forSchema(userViewSchema);
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
      .createQueryEngine(userViewSchema)
      .find("user_cards", (b) => b.whereIndex("primary"));

    expect(cards).toMatchObject([
      { displayName: "org-a::outbox:Ada" },
      { displayName: "org-b::outbox:Bob" },
    ]);
  });

  it("applies outbox entries once and records inbox", async () => {
    const adapter = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });

    const first = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-1",
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

    assert(first.applied);

    const query = adapter.createQueryEngine(appSchema);
    const users = await query.find("users", (b) => b.whereIndex("primary"));
    expect(users).toHaveLength(1);
    assert(users[0].name === "Ada");

    const second = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-1",
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

    assert(!second.applied);
  });

  it("materializes local schema rows transactionally", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [userViewProjection],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-1",
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

    const query = adapter.createQueryEngine(userViewSchema);
    await expect(query.find("user_cards", (b) => b.whereIndex("primary"))).resolves.toMatchObject([
      { displayName: "ADA" },
    ]);
  });

  it("skips mutate when retrieve returns undefined but still runs projections without retrieve", async () => {
    let skippedMutateRuns = 0;
    let unconditionalMutateRuns = 0;
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [
        defineLocalProjection({
          retrieve: () => undefined,
          mutate: () => {
            skippedMutateRuns += 1;
          },
        }),
        defineLocalProjection({
          mutate: ({ mutations, tx }) => {
            const userCards = tx.forSchema(userViewSchema);
            for (const mutation of mutations) {
              unconditionalMutateRuns += 1;
              userCards.create("user_cards", {
                id: mutation.externalId,
                displayName: "unconditional",
              });
            }
          },
        }),
      ],
    });

    await adapter.applyMutations([
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "local-1",
        values: { name: "Ada" },
      },
    ]);

    expect(skippedMutateRuns).toBe(0);
    expect(unconditionalMutateRuns).toBe(1);
    const query = adapter.createQueryEngine(userViewSchema);
    await expect(query.find("user_cards", (b) => b.whereIndex("primary"))).resolves.toMatchObject([
      { displayName: "unconditional" },
    ]);
  });

  it("increments local counters for each mutation in an outbox batch", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userMutationCountSchema],
      projections: [
        defineLocalProjection({
          retrieve: ({ mutations, match, read }) => {
            const existingById: Record<string, ReturnType<typeof read.get>> = {};
            for (const rawMutation of mutations) {
              const mutation = match.one(rawMutation, appSchema, "users", ["create", "update"]);
              if (mutation) {
                existingById[mutation.externalId] = read.get(
                  userMutationCountSchema,
                  "user_mutation_counts",
                  mutation.externalId,
                );
              }
            }
            return Object.keys(existingById).length > 0 ? { existingById } : undefined;
          },
          mutate: ({ mutations, match, retrieved, tx }) => {
            const countsById = new Map<string, number>();
            for (const rawMutation of mutations) {
              const mutation = match.one(rawMutation, appSchema, "users", ["create", "update"]);
              if (!mutation) {
                continue;
              }
              countsById.set(
                mutation.externalId,
                (countsById.get(mutation.externalId) ??
                  (retrieved.existingById[mutation.externalId] as { count?: number } | undefined)
                    ?.count ??
                  0) + 1,
              );
            }

            const userCounts = tx.forSchema(userMutationCountSchema);
            for (const [externalId, count] of countsById) {
              if (retrieved.existingById[externalId]) {
                userCounts.update("user_mutation_counts", externalId, (b) => b.set({ count }));
              } else {
                userCounts.create("user_mutation_counts", { id: externalId, count });
              }
            }
          },
        }),
      ],
    });

    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs5",
      uowId: "uow-1",
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
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs2",
          set: { name: "Bea" },
        },
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs3",
          set: { name: "Cia" },
        },
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs4",
          set: { name: "Dia" },
        },
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs5",
          set: { name: "Eve" },
        },
      ],
    });

    const query = adapter.createQueryEngine(userMutationCountSchema);
    await expect(
      query.find("user_mutation_counts", (b) => b.whereIndex("primary")),
    ).resolves.toMatchObject([{ count: 5 }]);
  });

  it("does not rerun projections for duplicate outbox entries", async () => {
    let projectionRuns = 0;
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [
        defineLocalProjection({
          retrieve: userViewProjection.retrieve,
          mutate: (ctx) => {
            projectionRuns += 1;
            userViewProjection.mutate(ctx);
          },
        }),
      ],
    });
    const entry = {
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-1",
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

  it("aborts staged server and local writes when projection fails", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
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
        uowId: "uow-1",
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

    const query = adapter.createQueryEngine(appSchema);
    await expect(query.find("users", (b) => b.whereIndex("primary"))).resolves.toEqual([]);
  });

  it("rejects invalid local schemas and projection write targets", async () => {
    expect(
      () =>
        new InMemoryLofiAdapter({
          endpointName: "app",
          schemas: [appSchema],
          localSchemas: [appSchema],
        }),
    ).toThrow("schema name must be unique");

    const serverWriteAdapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [
        {
          mutate: ({ tx, mutations }) => {
            tx.forSchema(appSchema).update("users", mutations[0]!.externalId, (b) =>
              b.set({ name: "Bad" }),
            );
          },
        },
      ],
    });

    await expect(
      serverWriteAdapter.applyMutations([
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

    const serverReadAdapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [
        {
          retrieve: ({ read, mutations }) => ({
            row: read.get(appSchema, "users", mutations[0]!.externalId),
          }),
          mutate: () => {},
        },
      ],
    });

    await expect(
      serverReadAdapter.applyMutations([
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

    const unknownTableAdapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [appSchema],
      localSchemas: [userViewSchema],
      projections: [
        {
          mutate: ({ tx, mutations }) => {
            tx.forSchema(userViewSchema).update("missing" as never, mutations[0]!.externalId, (b) =>
              b.set({}),
            );
          },
        },
      ],
    });

    await expect(
      unknownTableAdapter.applyMutations([
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "local-1",
          values: { name: "Ada" },
        },
      ]),
    ).rejects.toThrow("Unknown local projection table");
  });
});
