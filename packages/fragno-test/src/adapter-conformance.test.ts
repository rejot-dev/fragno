import { describe, expect, it } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

import type { TestDb } from ".";
import { createAdapter, type SupportedAdapter } from "./adapters";

const conformanceSchema = schema("conformance", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn(
          "slug",
          column("string").defaultTo$((b) => b.cuid()),
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo$((b) => b.now()),
        )
        .createIndex("users_by_name", ["name"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("authorId", referenceColumn())
        .createIndex("posts_by_author", ["authorId"]),
    )
    .addTable("comments", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("postId", referenceColumn())
        .addColumn("authorId", referenceColumn())
        .addColumn("body", column("string"))
        .createIndex("comments_by_post", ["postId"]),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    })
    .addReference("post", {
      type: "one",
      from: { table: "comments", column: "postId" },
      to: { table: "posts", column: "id" },
    })
    .addReference("commenter", {
      type: "one",
      from: { table: "comments", column: "authorId" },
      to: { table: "users", column: "id" },
    }),
);

const namespace = "conformance";
const fixedClock = new Date("2024-01-01T00:00:00.000Z");

type AdapterCase = {
  name: string;
  config: SupportedAdapter;
  supportsDeterministicDefaults: boolean;
};

type ConformanceDb = TestDb;

const adapterCases: AdapterCase[] = [
  {
    name: "in-memory",
    config: {
      type: "in-memory",
      options: { idSeed: "conformance-seed", clock: { now: () => fixedClock } },
    },
    supportsDeterministicDefaults: true,
  },
  {
    name: "kysely-sqlite",
    config: { type: "kysely-sqlite" },
    supportsDeterministicDefaults: false,
  },
];

async function withAdapter<T>(config: SupportedAdapter, run: (db: ConformanceDb) => Promise<T>) {
  const { testContext } = await createAdapter(config, [{ schema: conformanceSchema, namespace }]);
  const db = testContext.getDb(namespace);

  try {
    return await run(db);
  } finally {
    await testContext.cleanup();
  }
}

for (const adapterCase of adapterCases) {
  describe(`adapter conformance (${adapterCase.name})`, () => {
    it("enforces optimistic checks and version bumps", async () => {
      await withAdapter(adapterCase.config, async (db) => {
        const createUow = db.createUnitOfWork("create-user").forSchema(conformanceSchema);
        createUow.create("users", { name: "Ada" });
        const createResult = await createUow.executeMutations();
        expect(createResult.success).toBe(true);

        const createdId = createUow.getCreatedIds()[0];
        expect(createdId).toBeDefined();

        const updateUow = db.createUnitOfWork("update-user").forSchema(conformanceSchema);
        updateUow.update("users", createdId!, (b) => b.set({ name: "Ada Lovelace" }).check());
        const updateResult = await updateUow.executeMutations();
        expect(updateResult.success).toBe(true);

        const [[updatedUser]] = await db
          .createUnitOfWork("verify-update")
          .forSchema(conformanceSchema)
          .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", createdId!)))
          .executeRetrieve();

        expect(updatedUser).toMatchObject({
          name: "Ada Lovelace",
          id: expect.objectContaining({ version: 1 }),
        });

        const staleUow = db.createUnitOfWork("stale-update").forSchema(conformanceSchema);
        staleUow.update("users", createdId!, (b) => b.set({ name: "Ada Byron" }).check());
        const staleResult = await staleUow.executeMutations();
        expect(staleResult.success).toBe(false);
      });
    });

    it("paginates with cursors on ordered indexes", async () => {
      await withAdapter(adapterCase.config, async (db) => {
        const users = ["Ada", "Brett", "Cora", "Dylan", "Emma"];
        for (const name of users) {
          await (async () => {
            const uow = db.createUnitOfWork("write").forSchema(conformanceSchema);
            const created = uow.create("users", { name });
            const { success } = await uow.executeMutations();
            if (!success) {
              throw new Error("Failed to create record");
            }
            return created;
          })();
        }

        const firstPage = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(conformanceSchema)
            .findWithCursor("users", (b) =>
              b.whereIndex("users_by_name").orderByIndex("users_by_name", "asc").pageSize(2),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();

        expect(firstPage.items.map((user) => user.name)).toEqual(["Ada", "Brett"]);
        expect(firstPage.hasNextPage).toBe(true);
        expect(firstPage.cursor).toBeDefined();

        const secondPage = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(conformanceSchema)
            .findWithCursor("users", (b) =>
              b
                .whereIndex("users_by_name")
                .orderByIndex("users_by_name", "asc")
                .pageSize(2)
                .after(firstPage.cursor!),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();

        expect(secondPage.items.map((user) => user.name)).toEqual(["Cora", "Dylan"]);
        expect(secondPage.hasNextPage).toBe(true);
        expect(secondPage.cursor).toBeDefined();

        const thirdPage = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(conformanceSchema)
            .findWithCursor("users", (b) =>
              b
                .whereIndex("users_by_name")
                .orderByIndex("users_by_name", "asc")
                .pageSize(2)
                .after(secondPage.cursor!),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();

        expect(thirdPage.items.map((user) => user.name)).toEqual(["Emma"]);
        expect(thirdPage.hasNextPage).toBe(false);
        expect(thirdPage.cursor).toBeUndefined();
      });
    });

    it("executes nested joins consistently", async () => {
      await withAdapter(adapterCase.config, async (db) => {
        const authorId = await (async () => {
          const uow = db.createUnitOfWork("write").forSchema(conformanceSchema);
          const created = uow.create("users", { name: "Author" });
          const { success } = await uow.executeMutations();
          if (!success) {
            throw new Error("Failed to create record");
          }
          return created;
        })();
        const commenterId = await (async () => {
          const uow = db.createUnitOfWork("write").forSchema(conformanceSchema);
          const created = uow.create("users", { name: "Commenter" });
          const { success } = await uow.executeMutations();
          if (!success) {
            throw new Error("Failed to create record");
          }
          return created;
        })();
        const postId = await (async () => {
          const uow = db.createUnitOfWork("write").forSchema(conformanceSchema);
          const created = uow.create("posts", { title: "Hello", authorId });
          const { success } = await uow.executeMutations();
          if (!success) {
            throw new Error("Failed to create record");
          }
          return created;
        })();

        await (async () => {
          const uow = db.createUnitOfWork("write").forSchema(conformanceSchema);
          const created = uow.create("comments", {
            postId,
            authorId: commenterId,
            body: "Nice post",
          });
          const { success } = await uow.executeMutations();
          if (!success) {
            throw new Error("Failed to create record");
          }
          return created;
        })();

        const comments = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(conformanceSchema)
            .find("comments", (b) =>
              b
                .whereIndex("primary")
                .join((jb) =>
                  jb
                    .post((pb) =>
                      pb.select(["title"]).join((jb2) => jb2.author((ab) => ab.select(["name"]))),
                    )
                    .commenter((cb) => cb.select(["name"])),
                ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();

        expect(comments).toHaveLength(1);
        expect(comments[0]).toMatchObject({
          body: "Nice post",
          post: {
            title: "Hello",
            author: { name: "Author" },
          },
          commenter: { name: "Commenter" },
        });
      });
    });

    if (adapterCase.supportsDeterministicDefaults) {
      it("generates deterministic ids and clocks runtime defaults", async () => {
        const createDeterministicConfig = (): SupportedAdapter => {
          let counter = 0;
          return {
            type: "in-memory",
            options: {
              clock: { now: () => fixedClock },
              idGenerator: () => `seeded-${counter++}`,
            },
          };
        };

        const { testContext: firstContext } = await createAdapter(createDeterministicConfig(), [
          { schema: conformanceSchema, namespace },
        ]);
        const { testContext: secondContext } = await createAdapter(createDeterministicConfig(), [
          { schema: conformanceSchema, namespace },
        ]);

        try {
          const firstDb = firstContext.getDb(namespace);
          const secondDb = secondContext.getDb(namespace);

          const firstId = await (async () => {
            const uow = firstDb.createUnitOfWork("write").forSchema(conformanceSchema);
            const created = uow.create("users", { id: "seeded-user", name: "Seeded" });
            const { success } = await uow.executeMutations();
            if (!success) {
              throw new Error("Failed to create record");
            }
            return created;
          })();
          const secondId = await (async () => {
            const uow = secondDb.createUnitOfWork("write").forSchema(conformanceSchema);
            const created = uow.create("users", { id: "seeded-user", name: "Seeded" });
            const { success } = await uow.executeMutations();
            if (!success) {
              throw new Error("Failed to create record");
            }
            return created;
          })();

          expect(firstId.externalId).toBe(secondId.externalId);

          const createdUser = await (async () => {
            const uow = firstDb
              .createUnitOfWork("read")
              .forSchema(conformanceSchema)
              .findFirst("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", firstId)));
            await uow.executeRetrieve();
            return (await uow.retrievalPhase)[0];
          })();

          expect(createdUser?.slug).toBe("seeded-0");
          expect(createdUser?.createdAt?.toISOString()).toBe(fixedClock.toISOString());
        } finally {
          await firstContext.cleanup();
          await secondContext.cleanup();
        }
      });
    }
  });
}

describe("adapter conformance (kysely-sqlite instrumentation)", () => {
  it("invokes instrumentation hooks in order", async () => {
    const calls: string[] = [];
    const { testContext } = await createAdapter(
      {
        type: "kysely-sqlite",
        uowConfig: {
          instrumentation: {
            beforeRetrieve: () => {
              calls.push("beforeRetrieve");
            },
            afterRetrieve: () => {
              calls.push("afterRetrieve");
            },
            beforeMutate: () => {
              calls.push("beforeMutate");
            },
            afterMutate: () => {
              calls.push("afterMutate");
            },
          },
        },
      },
      [{ schema: conformanceSchema, namespace }],
    );

    const db = testContext.getDb(namespace);

    try {
      const uow = db.createUnitOfWork("instrumented").forSchema(conformanceSchema);
      uow.find("users", (b) => b.whereIndex("primary"));
      uow.create("users", { name: "Instrumented" });

      await uow.executeRetrieve();
      await uow.executeMutations();

      expect(calls).toEqual(["beforeRetrieve", "afterRetrieve", "beforeMutate", "afterMutate"]);
    } finally {
      await testContext.cleanup();
    }
  });

  it("short-circuits mutation execution on injected conflicts", async () => {
    const calls: string[] = [];
    const { testContext } = await createAdapter(
      {
        type: "kysely-sqlite",
        uowConfig: {
          instrumentation: {
            beforeMutate: () => ({ type: "conflict", reason: "Injected conflict" }),
            afterMutate: () => {
              calls.push("afterMutate");
            },
          },
        },
      },
      [{ schema: conformanceSchema, namespace }],
    );

    const db = testContext.getDb(namespace);

    try {
      const uow = db.createUnitOfWork("conflict-injected").forSchema(conformanceSchema);
      uow.create("users", { name: "Should not persist" });

      const result = await uow.executeMutations();
      expect(result.success).toBe(false);

      const users = await (async () => {
        const uow = db
          .createUnitOfWork("read")
          .forSchema(conformanceSchema)
          .find("users", (b) => b.whereIndex("primary"));
        await uow.executeRetrieve();
        return (await uow.retrievalPhase)[0];
      })();
      expect(users).toHaveLength(0);
      expect(calls).toEqual([]);
    } finally {
      await testContext.cleanup();
    }
  });
});
