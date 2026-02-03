import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
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

type ConformanceDb = SimpleQueryInterface<typeof conformanceSchema>;

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
  const db = testContext.getOrm<typeof conformanceSchema>(namespace) as ConformanceDb;

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
        const createUow = db.createUnitOfWork("create-user");
        createUow.create("users", { name: "Ada" });
        const createResult = await createUow.executeMutations();
        expect(createResult.success).toBe(true);

        const createdId = createUow.getCreatedIds()[0];
        expect(createdId).toBeDefined();

        const updateUow = db.createUnitOfWork("update-user");
        updateUow.update("users", createdId!, (b) => b.set({ name: "Ada Lovelace" }).check());
        const updateResult = await updateUow.executeMutations();
        expect(updateResult.success).toBe(true);

        const [[updatedUser]] = await db
          .createUnitOfWork("verify-update")
          .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", createdId!)))
          .executeRetrieve();

        expect(updatedUser).toMatchObject({
          name: "Ada Lovelace",
          id: expect.objectContaining({ version: 1 }),
        });

        const staleUow = db.createUnitOfWork("stale-update");
        staleUow.update("users", createdId!, (b) => b.set({ name: "Ada Byron" }).check());
        const staleResult = await staleUow.executeMutations();
        expect(staleResult.success).toBe(false);
      });
    });

    it("paginates with cursors on ordered indexes", async () => {
      await withAdapter(adapterCase.config, async (db) => {
        const users = ["Ada", "Brett", "Cora", "Dylan", "Emma"];
        for (const name of users) {
          await db.create("users", { name });
        }

        const firstPage = await db.findWithCursor("users", (b) =>
          b.whereIndex("users_by_name").orderByIndex("users_by_name", "asc").pageSize(2),
        );

        expect(firstPage.items.map((user) => user.name)).toEqual(["Ada", "Brett"]);
        expect(firstPage.hasNextPage).toBe(true);
        expect(firstPage.cursor).toBeDefined();

        const secondPage = await db.findWithCursor("users", (b) =>
          b
            .whereIndex("users_by_name")
            .orderByIndex("users_by_name", "asc")
            .pageSize(2)
            .after(firstPage.cursor!),
        );

        expect(secondPage.items.map((user) => user.name)).toEqual(["Cora", "Dylan"]);
        expect(secondPage.hasNextPage).toBe(true);
        expect(secondPage.cursor).toBeDefined();

        const thirdPage = await db.findWithCursor("users", (b) =>
          b
            .whereIndex("users_by_name")
            .orderByIndex("users_by_name", "asc")
            .pageSize(2)
            .after(secondPage.cursor!),
        );

        expect(thirdPage.items.map((user) => user.name)).toEqual(["Emma"]);
        expect(thirdPage.hasNextPage).toBe(false);
        expect(thirdPage.cursor).toBeUndefined();
      });
    });

    it("executes nested joins consistently", async () => {
      await withAdapter(adapterCase.config, async (db) => {
        const authorId = await db.create("users", { name: "Author" });
        const commenterId = await db.create("users", { name: "Commenter" });
        const postId = await db.create("posts", { title: "Hello", authorId });

        await db.create("comments", {
          postId,
          authorId: commenterId,
          body: "Nice post",
        });

        const comments = await db.find("comments", (b) =>
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
          const firstDb = firstContext.getOrm<typeof conformanceSchema>(namespace);
          const secondDb = secondContext.getOrm<typeof conformanceSchema>(namespace);

          const firstId = await firstDb.create("users", { id: "seeded-user", name: "Seeded" });
          const secondId = await secondDb.create("users", { id: "seeded-user", name: "Seeded" });

          expect(firstId.externalId).toBe(secondId.externalId);

          const createdUser = await firstDb.findFirst("users", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", firstId)),
          );

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

    const db = testContext.getOrm<typeof conformanceSchema>(namespace);

    try {
      const uow = db.createUnitOfWork("instrumented");
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

    const db = testContext.getOrm<typeof conformanceSchema>(namespace);

    try {
      const uow = db.createUnitOfWork("conflict-injected");
      uow.create("users", { name: "Should not persist" });

      const result = await uow.executeMutations();
      expect(result.success).toBe(false);

      const users = await db.find("users", (b) => b.whereIndex("primary"));
      expect(users).toHaveLength(0);
      expect(calls).toEqual([]);
    } finally {
      await testContext.cleanup();
    }
  });
});
