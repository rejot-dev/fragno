import { afterAll, describe, expect, it } from "vitest";

import { DatabaseConstraintError } from "../../errors";
import { internalSchema } from "../../fragments/internal-fragment";
import { Cursor } from "../../query/cursor";
import {
  createHandlerTxBuilder,
  createServiceTxBuilder,
} from "../../query/unit-of-work/execute-unit-of-work";
import { ExponentialBackoffRetryPolicy } from "../../query/unit-of-work/retry-policy";
import { FragnoId, type AnySchema } from "../../schema/create";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import type { DatabaseAdapter } from "../adapters";
import {
  suiteCapability,
  type QueryEngineSuiteContext,
  type QueryEngineSuiteHarness,
} from "./query-engine-harness";
import { queryEngineSuiteSchema, queryEngineSuiteSecondarySchema } from "./query-engine-schema";

const namespace = "query_engine_suite";
const secondaryNamespace = "query_engine_suite_secondary";

const createSuiteUnitOfWork = (adapter: DatabaseAdapter<unknown>, name: string) =>
  adapter.createUnitOfWork(queryEngineSuiteSchema, namespace, name);

const createSuiteBaseUnitOfWork = (adapter: DatabaseAdapter<unknown>, name: string) =>
  adapter.createBaseUnitOfWork(name);

const registerSuiteSchema = (
  adapter: DatabaseAdapter<unknown>,
  schema: AnySchema,
  schemaNamespace: string | null,
) => {
  adapter.registerSchema(schema, schemaNamespace);
};

export function describeQueryEngineSuite(harness: QueryEngineSuiteHarness): void {
  describe(`query engine contract: ${harness.name}`, () => {
    let sharedContext: QueryEngineSuiteContext | undefined;

    const prepareContext = async () => {
      const context = await harness.createAdapter();
      const adapterDriver =
        "driver" in context.adapter && context.adapter.driver instanceof SqlDriverAdapter
          ? context.adapter.driver
          : undefined;
      if (context.adapter.prepareMigrations) {
        const migrations = [
          context.adapter.prepareMigrations(internalSchema, ""),
          context.adapter.prepareMigrations(queryEngineSuiteSchema, namespace),
          context.adapter.prepareMigrations(queryEngineSuiteSecondarySchema, secondaryNamespace),
        ];
        for (const migration of migrations) {
          if (adapterDriver) {
            await migration.executeWithDriver(adapterDriver, 0);
          } else {
            await migration.execute(0);
          }
        }
      }
      return context;
    };

    const createContext = async () => {
      if (!harness.reuseContext) {
        return prepareContext();
      }

      sharedContext ??= await prepareContext();
      await harness.resetContext?.(sharedContext);
      return { adapter: sharedContext.adapter, close: undefined };
    };

    afterAll(async () => {
      await sharedContext?.close?.();
    });

    it("creates, reads, updates, and joins basic rows", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-basic");
        create.create("users", {
          id: "user-basic",
          name: "Alice",
          email: "alice@example.com",
          age: 32,
        });
        create.create("emails", {
          id: "email-basic",
          user_id: "user-basic",
          email: "alice.primary@example.com",
          is_primary: true,
        });
        expect((await create.executeMutations()).success).toBe(true);

        const [[email]] = await createSuiteUnitOfWork(adapter, "read-basic")
          .find("emails", (b) =>
            b
              .whereIndex("emails_email_idx", (eb) => eb("email", "=", "alice.primary@example.com"))
              .joinOne("user", "users", (user) =>
                user
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                  .select(["id", "name", "age"]),
              ),
          )
          .executeRetrieve();

        expect(email).toMatchObject({
          email: "alice.primary@example.com",
          user: { name: "Alice", age: 32 },
        });

        const update = createSuiteUnitOfWork(adapter, "update-basic");
        expect(email.user).not.toBeNull();
        update.update("users", email.user!.id, (b) => b.set({ age: 33 }).check());
        expect((await update.executeMutations()).success).toBe(true);

        const [[user]] = await createSuiteUnitOfWork(adapter, "read-updated-basic")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "alice@example.com")),
          )
          .executeRetrieve();
        expect(user.age).toBe(33);
        expect(user.id.version).toBe(1);
      } finally {
        await close?.();
      }
    });

    it("executes UOW update with version check and rejects stale update", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-stale-user");
        create.create("users", {
          id: "user-stale",
          name: "Stale",
          email: "stale@example.com",
          age: 20,
        });
        await create.executeMutations();
        const createdId = create.getCreatedIds()[0]!;

        const update = createSuiteUnitOfWork(adapter, "update-current");
        update.update("users", createdId, (b) => b.set({ name: "Fresh" }).check());
        expect((await update.executeMutations()).success).toBe(true);

        const stale = createSuiteUnitOfWork(adapter, "update-stale");
        stale.update("users", createdId, (b) => b.set({ name: "Wrong" }).check());
        expect((await stale.executeMutations()).success).toBe(false);

        const [[user]] = await createSuiteUnitOfWork(adapter, "read-after-stale")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "stale@example.com")),
          )
          .executeRetrieve();
        expect(user.name).toBe("Fresh");
      } finally {
        await close?.();
      }
    });

    it("checks and deletes rows with version enforcement", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-delete-user");
        create.create("users", {
          id: "user-delete",
          name: "Delete",
          email: "delete@example.com",
          age: 44,
        });
        await create.executeMutations();
        const createdId = create.getCreatedIds()[0]!;
        const wrongVersionId = new FragnoId({
          externalId: createdId.externalId,
          internalId: createdId.internalId,
          version: createdId.version + 1,
        });

        const badDelete = createSuiteUnitOfWork(adapter, "bad-delete");
        badDelete.delete("users", wrongVersionId, (b) => b.check());
        expect((await badDelete.executeMutations()).success).toBe(false);

        const goodDelete = createSuiteUnitOfWork(adapter, "good-delete");
        goodDelete.delete("users", createdId, (b) => b.check());
        expect((await goodDelete.executeMutations()).success).toBe(true);

        const [users] = await createSuiteUnitOfWork(adapter, "read-after-delete")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "delete@example.com")),
          )
          .executeRetrieve();
        expect(users).toHaveLength(0);
      } finally {
        await close?.();
      }
    });

    it("selects total counts and filtered counts", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-count-users");
        create.create("users", {
          id: "count-1",
          name: "Count",
          email: "count1@example.com",
          age: 10,
        });
        create.create("users", {
          id: "count-2",
          name: "Count",
          email: "count2@example.com",
          age: 30,
        });
        await create.executeMutations();

        const [allCount, filteredCount] = await createSuiteUnitOfWork(adapter, "count-users")
          .find("users", (b) =>
            b.whereIndex("users_name_idx", (eb) => eb("name", "=", "Count")).selectCount(),
          )
          .find("users", (b) =>
            b.whereIndex("users_age_idx", (eb) => eb("age", ">", 20)).selectCount(),
          )
          .executeRetrieve();
        expect(allCount).toBe(2);
        expect(filteredCount).toBe(1);
      } finally {
        await close?.();
      }
    });

    it("paginates with findWithCursor and reports hasNextPage/cursor/empty results", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-cursor-users");
        for (const [id, name] of [
          ["cursor-1", "A"],
          ["cursor-2", "B"],
          ["cursor-3", "C"],
        ] as const) {
          create.create("users", {
            id,
            name: `Cursor ${name}`,
            email: `${id}@example.com`,
            age: 1,
          });
        }
        await create.executeMutations();

        const firstPageUow = createSuiteUnitOfWork(adapter, "cursor-page-1").findWithCursor(
          "users",
          (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Cursor"))
              .orderByIndex("users_name_idx", "asc")
              .pageSize(2),
        );
        await firstPageUow.executeRetrieve();
        const [firstPage] = await firstPageUow.retrievalPhase;
        expect(firstPage.items.map((user: { name: string }) => user.name)).toEqual([
          "Cursor A",
          "Cursor B",
        ]);
        expect(firstPage.hasNextPage).toBe(true);
        expect(firstPage.cursor).toBeInstanceOf(Cursor);
        const cursor = firstPage.cursor;
        if (!cursor) {
          throw new Error("Expected first page cursor");
        }

        const secondPageUow = createSuiteUnitOfWork(adapter, "cursor-page-2").findWithCursor(
          "users",
          (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Cursor"))
              .after(cursor)
              .orderByIndex("users_name_idx", "asc")
              .pageSize(2),
        );
        await secondPageUow.executeRetrieve();
        const [secondPage] = await secondPageUow.retrievalPhase;
        expect(secondPage.items.map((user: { name: string }) => user.name)).toEqual(["Cursor C"]);
        expect(secondPage.hasNextPage).toBe(false);
      } finally {
        await close?.();
      }
    });

    it("queries multiple schemas from one UOW with forSchema", async () => {
      const { adapter, close } = await createContext();
      try {
        registerSuiteSchema(adapter, queryEngineSuiteSchema, namespace);
        registerSuiteSchema(adapter, queryEngineSuiteSecondarySchema, secondaryNamespace);
        const create = createSuiteBaseUnitOfWork(adapter, "create-multi-schema");
        create
          .forSchema(queryEngineSuiteSchema)
          .create("users", { id: "multi-user", name: "Multi", email: "multi@example.com", age: 1 });
        create
          .forSchema(queryEngineSuiteSecondarySchema)
          .create("products", { id: "multi-product", name: "Widget", price: 25 });
        expect((await create.executeMutations()).success).toBe(true);

        const read = createSuiteBaseUnitOfWork(adapter, "read-multi-schema");
        read
          .forSchema(queryEngineSuiteSchema)
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "multi@example.com")),
          );
        read
          .forSchema(queryEngineSuiteSecondarySchema)
          .find("products", (b) =>
            b.whereIndex("products_name_idx", (eb) => eb("name", "=", "Widget")),
          );
        const [users, products] = await read.executeRetrieve();
        expect((users as { name: string }[])[0]?.name).toBe("Multi");
        expect((products as { name: string }[])[0]?.name).toBe("Widget");
      } finally {
        await close?.();
      }
    });

    it.skipIf(!suiteCapability(harness.capabilities, "databaseDefaultTimestamp"))(
      "returns database default timestamps as Date values",
      async () => {
        const { adapter, close } = await createContext();
        try {
          const create = createSuiteUnitOfWork(adapter, "create-default-time-post");
          create.create("users", {
            id: "time-user",
            name: "Time",
            email: "time@example.com",
            age: 1,
          });
          create.create("posts", {
            id: "time-post",
            user_id: "time-user",
            title: "T",
            content: "C",
          });
          await create.executeMutations();
          const [[post]] = await createSuiteUnitOfWork(adapter, "read-default-time-post")
            .find("posts", (b) => b.whereIndex("posts_title_idx", (eb) => eb("title", "=", "T")))
            .executeRetrieve();
          expect(post.created_at).toBeInstanceOf(Date);
        } finally {
          await close?.();
        }
      },
    );

    it("fails a UOW when check() sees a changed version and rolls back following mutations", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-check-rollback-user");
        create.create("users", {
          id: "check-rollback-user",
          name: "Before",
          email: "check-rollback@example.com",
          age: 1,
        });
        await create.executeMutations();
        const staleId = create.getCreatedIds()[0]!;

        const bump = createSuiteUnitOfWork(adapter, "bump-check-version");
        bump.update("users", staleId, (b) => b.set({ name: "After" }).check());
        expect((await bump.executeMutations()).success).toBe(true);

        const stale = createSuiteUnitOfWork(adapter, "stale-check-rolls-back");
        stale.check("users", staleId);
        stale.create("users", {
          id: "should-not-exist",
          name: "Rollback",
          email: "rollback@example.com",
          age: 1,
        });
        expect((await stale.executeMutations()).success).toBe(false);

        const [rolledBackRows] = await createSuiteUnitOfWork(adapter, "verify-check-rollback")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "rollback@example.com")),
          )
          .executeRetrieve();
        expect(rolledBackRows).toHaveLength(0);
      } finally {
        await close?.();
      }
    });

    it("returns created ids for creates, mixed operations, and user-provided ids", async () => {
      const { adapter, close } = await createContext();
      try {
        const first = createSuiteUnitOfWork(adapter, "created-ids-create");
        first.create("users", { name: "Generated", email: "generated@example.com", age: 1 });
        first.create("users", {
          id: "provided-id",
          name: "Provided",
          email: "provided@example.com",
          age: 2,
        });
        expect((await first.executeMutations()).success).toBe(true);
        const ids = first.getCreatedIds();
        expect(ids).toHaveLength(2);
        expect(ids[1]!.externalId).toBe("provided-id");

        const mixed = createSuiteUnitOfWork(adapter, "created-ids-mixed");
        mixed.update("users", ids[0]!, (b) => b.set({ age: 3 }).check());
        mixed.create("users", {
          id: "mixed-created",
          name: "Mixed",
          email: "mixed@example.com",
          age: 4,
        });
        mixed.delete("users", ids[1]!, (b) => b.check());
        expect((await mixed.executeMutations()).success).toBe(true);
        expect(mixed.getCreatedIds().map((id) => id.externalId)).toEqual(["mixed-created"]);
      } finally {
        await close?.();
      }
    });

    it("uses a returned id as a reference in the same transaction", async () => {
      const { adapter, close } = await createContext();
      try {
        const uow = createSuiteUnitOfWork(adapter, "create-with-returned-ref");
        const userRef = uow.create("users", { name: "Ref User", email: "ref@example.com", age: 5 });
        uow.create("posts", { id: "ref-post", user_id: userRef, title: "Ref", content: "Post" });
        expect((await uow.executeMutations()).success).toBe(true);

        const [[post]] = await createSuiteUnitOfWork(adapter, "read-returned-ref")
          .find("posts", (b) =>
            b
              .whereIndex("posts_title_idx", (eb) => eb("title", "=", "Ref"))
              .joinOne("user", "users", (user) =>
                user.onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id"))),
              ),
          )
          .executeRetrieve();
        expect(post.user?.email).toBe("ref@example.com");
      } finally {
        await close?.();
      }
    });

    it("uses an external id string as a reference value", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-external-ref");
        create.create("users", {
          id: "external-ref-user",
          name: "External",
          email: "external-ref@example.com",
          age: 6,
        });
        create.create("emails", {
          id: "external-ref-email",
          user_id: "external-ref-user",
          email: "external-ref-email@example.com",
          is_primary: false,
        });
        expect((await create.executeMutations()).success).toBe(true);

        const [[email]] = await createSuiteUnitOfWork(adapter, "read-external-ref")
          .find("emails", (b) =>
            b
              .whereIndex("emails_email_idx", (eb) =>
                eb("email", "=", "external-ref-email@example.com"),
              )
              .joinOne("user", "users", (user) =>
                user.onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id"))),
              ),
          )
          .executeRetrieve();
        expect(email.user?.id.externalId).toBe("external-ref-user");
      } finally {
        await close?.();
      }
    });

    it("joins comments -> post -> author and comments -> commenter", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-complex-join-data");
        create.create("users", {
          id: "author",
          name: "Author",
          email: "author@example.com",
          age: 30,
        });
        create.create("users", {
          id: "commenter",
          name: "Commenter",
          email: "commenter@example.com",
          age: 31,
        });
        create.create("posts", {
          id: "complex-post",
          user_id: "author",
          title: "Complex",
          content: "Nested",
        });
        create.create("comments", {
          id: "complex-comment",
          post_id: "complex-post",
          user_id: "commenter",
          text: "Nice",
        });
        await create.executeMutations();

        const [[comment]] = await createSuiteUnitOfWork(adapter, "read-complex-join")
          .find("comments", (b) =>
            b
              .whereIndex("comments_post_idx")
              .joinOne("post", "posts", (post) =>
                post
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("post_id")))
                  .joinOne("author", "users", (author) =>
                    author
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                      .select(["name"]),
                  ),
              )
              .joinOne("commenter", "users", (commenter) =>
                commenter
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                  .select(["name"]),
              ),
          )
          .executeRetrieve();
        expect(comment).toMatchObject({
          text: "Nice",
          post: { title: "Complex", author: { name: "Author" } },
          commenter: { name: "Commenter" },
        });
      } finally {
        await close?.();
      }
    });

    it("queries many-to-many data through a junction table and nested author join", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-many-to-many");
        create.create("users", {
          id: "m2m-author",
          name: "M2M Author",
          email: "m2m-author@example.com",
          age: 1,
        });
        create.create("posts", {
          id: "m2m-post",
          user_id: "m2m-author",
          title: "M2M",
          content: "Post",
        });
        create.create("tags", { id: "m2m-tag", name: "typescript" });
        create.create("post_tags", { id: "m2m-link", post_id: "m2m-post", tag_id: "m2m-tag" });
        await create.executeMutations();

        const [[link]] = await createSuiteUnitOfWork(adapter, "read-many-to-many")
          .find("post_tags", (b) =>
            b
              .whereIndex("post_tags_post_idx")
              .joinOne("post", "posts", (post) =>
                post
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("post_id")))
                  .joinOne("author", "users", (author) =>
                    author
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                      .select(["name"]),
                  ),
              )
              .joinOne("tag", "tags", (tag) =>
                tag.onIndex("primary", (eb) => eb("id", "=", eb.parent("tag_id"))).select(["name"]),
              ),
          )
          .executeRetrieve();
        expect(link).toMatchObject({
          post: { title: "M2M", author: { name: "M2M Author" } },
          tag: { name: "typescript" },
        });
      } finally {
        await close?.();
      }
    });

    it("enforces unique indexes on create and update", async () => {
      const expectUniqueConstraintError = async (promise: Promise<unknown>) => {
        await expect(promise).rejects.toBeInstanceOf(DatabaseConstraintError);
        await expect(promise).rejects.toMatchObject({ kind: "unique" });
      };

      const { adapter, close } = await createContext();
      try {
        const seed = createSuiteUnitOfWork(adapter, "seed-unique-users");
        seed.create("users", {
          id: "unique-user-a",
          name: "Unique A",
          email: "unique@example.com",
          age: 1,
        });
        seed.create("users", {
          id: "unique-user-b",
          name: "Unique B",
          email: "unique-b@example.com",
          age: 2,
        });
        await seed.executeMutations();

        const badCreate = createSuiteUnitOfWork(adapter, "bad-unique-create");
        badCreate.create("users", {
          id: "unique-user-c",
          name: "Unique C",
          email: "unique@example.com",
          age: 3,
        });
        await expectUniqueConstraintError(badCreate.executeMutations());

        const badUpdate = createSuiteUnitOfWork(adapter, "bad-unique-update");
        badUpdate.update("users", "unique-user-b", (b) => b.set({ email: "unique@example.com" }));
        await expectUniqueConstraintError(badUpdate.executeMutations());
      } finally {
        await close?.();
      }
    });

    it.skipIf(!suiteCapability(harness.capabilities, "constraints"))(
      "enforces foreign keys on create and update",
      async () => {
        const { adapter, close } = await createContext();
        try {
          const badCreate = createSuiteUnitOfWork(adapter, "bad-fk-create");
          badCreate.create("posts", {
            id: "bad-fk-post",
            user_id: "missing-user",
            title: "Bad",
            content: "Bad",
          });
          await expect(badCreate.executeMutations()).rejects.toThrow();

          const create = createSuiteUnitOfWork(adapter, "good-fk-create");
          create.create("users", { id: "fk-user", name: "FK", email: "fk@example.com", age: 1 });
          create.create("posts", {
            id: "fk-post",
            user_id: "fk-user",
            title: "FK",
            content: "Post",
          });
          await create.executeMutations();
          const postId = create.getCreatedIds()[1]!;

          const badUpdate = createSuiteUnitOfWork(adapter, "bad-fk-update");
          badUpdate.update("posts", postId, (b) => b.set({ user_id: "missing-user" }));
          await expect(badUpdate.executeMutations()).rejects.toThrow();
        } finally {
          await close?.();
        }
      },
    );

    it.skipIf(!suiteCapability(harness.capabilities, "constraints"))(
      "enforces foreign keys on delete",
      async () => {
        const { adapter, close } = await createContext();
        try {
          const create = createSuiteUnitOfWork(adapter, "create-fk-delete");
          create.create("users", {
            id: "fk-delete-user",
            name: "FK Delete",
            email: "fk-delete@example.com",
            age: 1,
          });
          create.create("posts", {
            id: "fk-delete-post",
            user_id: "fk-delete-user",
            title: "FK Delete",
            content: "Post",
          });
          await create.executeMutations();
          const userId = create.getCreatedIds()[0]!;

          const deleteUser = createSuiteUnitOfWork(adapter, "delete-fk-parent");
          deleteUser.delete("users", userId, (b) => b.check());
          await expect(deleteUser.executeMutations()).rejects.toThrow();
        } finally {
          await close?.();
        }
      },
    );

    it("performs a multi-row transactional transfer with checked updates and a dependent create", async () => {
      const { adapter, close } = await createContext();
      try {
        const seed = createSuiteUnitOfWork(adapter, "seed-transfer");
        seed.create("users", {
          id: "transfer-from",
          name: "From",
          email: "from@example.com",
          age: 100,
        });
        seed.create("users", { id: "transfer-to", name: "To", email: "to@example.com", age: 10 });
        await seed.executeMutations();
        const [fromId, toId] = seed.getCreatedIds();

        const transfer = createSuiteUnitOfWork(adapter, "transfer");
        transfer.update("users", fromId!, (b) => b.set({ age: 75 }).check());
        transfer.update("users", toId!, (b) => b.set({ age: 35 }).check());
        transfer.create("emails", {
          id: "transfer-receipt",
          user_id: toId!,
          email: "receipt@example.com",
          is_primary: false,
        });
        expect((await transfer.executeMutations()).success).toBe(true);

        const [users, receipts] = await createSuiteUnitOfWork(adapter, "verify-transfer")
          .find("users", (b) => b.whereIndex("users_name_idx"))
          .find("emails", (b) =>
            b.whereIndex("emails_email_idx", (eb) => eb("email", "=", "receipt@example.com")),
          )
          .executeRetrieve();
        expect(users.map((user) => user.age).sort((a, b) => a! - b!)).toEqual([35, 75]);
        expect(receipts).toHaveLength(1);
      } finally {
        await close?.();
      }
    });

    it("paginates with a manually-created cursor", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-manual-cursor-users");
        create.create("users", {
          id: "manual-a",
          name: "Manual A",
          email: "manual-a@example.com",
          age: 1,
        });
        create.create("users", {
          id: "manual-b",
          name: "Manual B",
          email: "manual-b@example.com",
          age: 1,
        });
        create.create("users", {
          id: "manual-c",
          name: "Manual C",
          email: "manual-c@example.com",
          age: 1,
        });
        await create.executeMutations();

        const cursor = new Cursor({
          indexName: "users_name_idx",
          orderDirection: "asc",
          pageSize: 2,
          indexValues: { name: "Manual A" },
        });
        const pageUow = createSuiteUnitOfWork(adapter, "manual-cursor-page").findWithCursor(
          "users",
          (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Manual"))
              .after(cursor)
              .orderByIndex("users_name_idx", "asc")
              .pageSize(2),
        );
        await pageUow.executeRetrieve();
        const [page] = await pageUow.retrievalPhase;
        expect(page.items.map((user: { name: string }) => user.name)).toEqual([
          "Manual B",
          "Manual C",
        ]);
      } finally {
        await close?.();
      }
    });

    it("paginates by a composite index with findWithCursor", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-composite-cursor-users");
        create.create("users", {
          id: "composite-a",
          name: "Composite",
          email: "composite-a@example.com",
          age: 1,
        });
        create.create("users", {
          id: "composite-b",
          name: "Composite",
          email: "composite-b@example.com",
          age: 2,
        });
        create.create("users", {
          id: "composite-c",
          name: "Composite",
          email: "composite-c@example.com",
          age: 3,
        });
        await create.executeMutations();

        const pageUow = createSuiteUnitOfWork(adapter, "composite-cursor-page").findWithCursor(
          "users",
          (b) =>
            b
              .whereIndex("users_name_id_idx", (eb) => eb("name", "=", "Composite"))
              .orderByIndex("users_name_id_idx", "asc")
              .pageSize(2),
        );
        await pageUow.executeRetrieve();
        const [page] = await pageUow.retrievalPhase;
        expect(page.items.map((user: { id: FragnoId }) => user.id.externalId)).toEqual([
          "composite-a",
          "composite-b",
        ]);
        expect(page.hasNextPage).toBe(true);
      } finally {
        await close?.();
      }
    });

    it("applies page size after primary-index filtering", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-primary-filter-users");
        create.create("users", {
          id: "primary-filter-a",
          name: "Primary A",
          email: "primary-filter-a@example.com",
          age: 1,
        });
        create.create("users", {
          id: "primary-filter-b",
          name: "Primary B",
          email: "primary-filter-b@example.com",
          age: 1,
        });
        await create.executeMutations();

        const [user] = await createSuiteUnitOfWork(adapter, "primary-filter-find-first")
          .findFirst("users", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", "primary-filter-b")),
          )
          .executeRetrieve();

        expect(user).toMatchObject({
          id: expect.objectContaining({ externalId: "primary-filter-b" }),
          name: "Primary B",
        });
      } finally {
        await close?.();
      }
    });

    it("paginates query-tree retrievals with selected fields", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-selected-cursor-users");
        create.create("users", {
          id: "selected-cursor-a",
          name: "Selected Cursor A",
          email: "selected-cursor-a@example.com",
          age: 1,
        });
        create.create("users", {
          id: "selected-cursor-b",
          name: "Selected Cursor B",
          email: "selected-cursor-b@example.com",
          age: 2,
        });
        create.create("users", {
          id: "selected-cursor-c",
          name: "Selected Cursor C",
          email: "selected-cursor-c@example.com",
          age: 3,
        });
        await create.executeMutations();

        const pageUow = createSuiteUnitOfWork(adapter, "selected-cursor-page").findWithCursor(
          "users",
          (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Selected Cursor"))
              .select(["id", "name"])
              .orderByIndex("users_name_idx", "asc")
              .pageSize(2),
        );
        await pageUow.executeRetrieve();
        const [page] = await pageUow.retrievalPhase;
        expect(page.items).toMatchObject([
          {
            id: expect.objectContaining({ externalId: "selected-cursor-a" }),
            name: "Selected Cursor A",
          },
          {
            id: expect.objectContaining({ externalId: "selected-cursor-b" }),
            name: "Selected Cursor B",
          },
        ]);
        expect(page.items[0]).not.toHaveProperty("email");
        expect(page.hasNextPage).toBe(true);
      } finally {
        await close?.();
      }
    });

    it("supports findWithCursor as a UOW retrieval operation", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-uow-cursor-users");
        create.create("users", {
          id: "uow-cursor-a",
          name: "UowCursor A",
          email: "uow-cursor-a@example.com",
          age: 1,
        });
        create.create("users", {
          id: "uow-cursor-b",
          name: "UowCursor B",
          email: "uow-cursor-b@example.com",
          age: 1,
        });
        await create.executeMutations();

        const uow = createSuiteUnitOfWork(adapter, "uow-cursor")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "uow-cursor-a@example.com")),
          )
          .findWithCursor("users", (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "UowCursor"))
              .orderByIndex("users_name_idx", "asc")
              .pageSize(1),
          );
        await uow.executeRetrieve();
        const [exactUsers, page] = await uow.retrievalPhase;
        expect(exactUsers).toHaveLength(1);
        expect(page.items).toHaveLength(1);
        expect(page.hasNextPage).toBe(true);
      } finally {
        await close?.();
      }
    });

    it("supports query-tree joins without schema-declared relations", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-query-tree-join-data");
        create.create("users", {
          id: "tree-user",
          name: "Tree",
          email: "tree@example.com",
          age: 1,
        });
        create.create("memberships", { id: "tree-membership-1", user_id: "tree-user" });
        create.create("memberships", { id: "tree-membership-2", user_id: "tree-user" });
        await create.executeMutations();

        const [users] = await createSuiteUnitOfWork(adapter, "read-query-tree-join")
          .find("users", (b) =>
            b
              .whereIndex("users_email_idx", (eb) => eb("email", "=", "tree@example.com"))
              .select(["id", "name"])
              .joinMany("memberships", "memberships", (memberships) =>
                memberships
                  .onIndex("memberships_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
                  .select(["id", "user_id"])
                  .joinOne("memberUser", "users", (memberUser) =>
                    memberUser
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                      .select(["id", "name"]),
                  ),
              ),
          )
          .executeRetrieve();

        expect(users[0]).toMatchObject({
          id: expect.objectContaining({ externalId: "tree-user" }),
          name: "Tree",
          memberships: expect.arrayContaining([
            expect.objectContaining({
              id: expect.objectContaining({ externalId: "tree-membership-1" }),
              memberUser: expect.objectContaining({ name: "Tree" }),
            }),
            expect.objectContaining({
              id: expect.objectContaining({ externalId: "tree-membership-2" }),
              memberUser: expect.objectContaining({ name: "Tree" }),
            }),
          ]),
        });
      } finally {
        await close?.();
      }
    });

    it("supports join-only relations using left-side id coercion", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-join-only-coercion-data");
        create.create("users", {
          id: "join-only-user",
          name: "JoinOnly",
          email: "join-only@example.com",
          age: 1,
        });
        create.create("memberships", { id: "join-only-membership", user_id: "join-only-user" });
        await create.executeMutations();

        const [users] = await createSuiteUnitOfWork(adapter, "read-join-only-coercion")
          .find("users", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", "join-only-user"))
              .joinMany("memberships", "memberships", (memberships) =>
                memberships
                  .onIndex("memberships_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
                  .select(["id"]),
              ),
          )
          .executeRetrieve();

        expect(users[0]?.memberships).toMatchObject([
          { id: expect.objectContaining({ externalId: "join-only-membership" }) },
        ]);
      } finally {
        await close?.();
      }
    });

    it("supports findFirst and child whereIndex filtering in joined query-tree retrievals", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-find-first-join-data");
        create.create("users", {
          id: "find-first-user",
          name: "FindFirst",
          email: "find-first@example.com",
          age: 1,
        });
        create.create("users", {
          id: "find-first-other",
          name: "Other",
          email: "find-first-other@example.com",
          age: 1,
        });
        create.create("memberships", { id: "find-first-membership", user_id: "find-first-user" });
        await create.executeMutations();

        const [user] = await createSuiteUnitOfWork(adapter, "read-find-first-join")
          .findFirst("users", (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "=", "FindFirst"))
              .select(["id", "name"])
              .joinMany("memberships", "memberships", (memberships) =>
                memberships
                  .onIndex("memberships_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
                  .select(["id", "user_id"])
                  .joinOne("memberUser", "users", (memberUser) =>
                    memberUser
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                      .whereIndex("users_name_idx", (eb) => eb("name", "=", "FindFirst"))
                      .select(["id", "name"]),
                  ),
              ),
          )
          .executeRetrieve();

        expect(user).toMatchObject({
          id: expect.objectContaining({ externalId: "find-first-user" }),
          memberships: [{ memberUser: expect.objectContaining({ name: "FindFirst" }) }],
        });
      } finally {
        await close?.();
      }
    });

    it("returns null for a nullable left-joined relation", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-nullable-join-post");
        create.create("posts", {
          id: "orphan-post",
          user_id: null,
          title: "Orphan",
          content: "No author",
        });
        await create.executeMutations();
        const [[post]] = await createSuiteUnitOfWork(adapter, "read-nullable-join-post")
          .find("posts", (b) =>
            b
              .whereIndex("posts_title_idx", (eb) => eb("title", "=", "Orphan"))
              .joinOne("author", "users", (author) =>
                author.onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id"))),
              ),
          )
          .executeRetrieve();
        expect(post.author).toBeNull();
      } finally {
        await close?.();
      }
    });

    it("does not enforce join-only relations as foreign keys", async () => {
      const { adapter, close } = await createContext();
      try {
        const createInvitation = createSuiteUnitOfWork(adapter, "create-join-only-invitation");
        createInvitation.create("invitations", {
          id: "join-only-invite",
          email: "missing@example.com",
        });
        expect((await createInvitation.executeMutations()).success).toBe(true);

        const createUser = createSuiteUnitOfWork(adapter, "create-join-only-user");
        createUser.create("users", {
          id: "join-only-fk-user",
          name: "JoinOnly FK",
          email: "join-only-fk@example.com",
          age: 1,
        });
        expect((await createUser.executeMutations()).success).toBe(true);

        const createMatchingInvitation = createSuiteUnitOfWork(
          adapter,
          "create-matching-join-only-invitation",
        );
        createMatchingInvitation.create("invitations", {
          id: "matching-join-only-invite",
          email: "join-only-fk@example.com",
        });
        expect((await createMatchingInvitation.executeMutations()).success).toBe(true);

        const deleteUser = createSuiteUnitOfWork(adapter, "delete-join-only-user");
        deleteUser.delete("users", createUser.getCreatedIds()[0]!, (b) => b.check());
        expect((await deleteUser.executeMutations()).success).toBe(true);
      } finally {
        await close?.();
      }
    });

    it("paginates with encoded cursors, before cursors, descending order, and composite continuation", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-cursor-edge-users");
        for (const [id, name] of [
          ["encoded-a", "Encoded A"],
          ["encoded-b", "Encoded B"],
          ["encoded-c", "Encoded C"],
          ["encoded-d", "Encoded D"],
        ] as const) {
          create.create("users", { id, name, email: `${id}@example.com`, age: 1 });
        }
        for (const id of ["composite-a", "composite-b", "composite-c"] as const) {
          create.create("users", {
            id,
            name: "Encoded Composite",
            email: `${id}@example.com`,
            age: 2,
          });
        }
        await create.executeMutations();

        const ascFirstUow = createSuiteUnitOfWork(
          adapter,
          "encoded-cursor-asc-page-1",
        ).findWithCursor("users", (b) =>
          b
            .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Encoded "))
            .orderByIndex("users_name_idx", "asc")
            .pageSize(2),
        );
        await ascFirstUow.executeRetrieve();
        const [ascFirstPage] = await ascFirstUow.retrievalPhase;
        expect(ascFirstPage.items.map((user: { name: string }) => user.name)).toEqual([
          "Encoded A",
          "Encoded B",
        ]);
        expect(ascFirstPage.hasNextPage).toBe(true);
        expect(ascFirstPage.cursor).toBeInstanceOf(Cursor);
        if (!ascFirstPage.cursor) {
          throw new Error("Expected encoded cursor first page cursor");
        }

        const ascSecondUow = createSuiteUnitOfWork(
          adapter,
          "encoded-cursor-asc-page-2",
        ).findWithCursor("users", (b) =>
          b
            .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Encoded "))
            .after(ascFirstPage.cursor!.encode()),
        );
        await ascSecondUow.executeRetrieve();
        const [ascSecondPage] = await ascSecondUow.retrievalPhase;
        expect(ascSecondPage.items.map((user: { name: string }) => user.name)).toEqual([
          "Encoded C",
          "Encoded Composite",
        ]);
        expect(ascSecondPage.hasNextPage).toBe(true);

        const beforeCursor = new Cursor({
          indexName: "users_name_idx",
          orderDirection: "asc",
          pageSize: 2,
          indexValues: { name: "Encoded C" },
        });
        const beforeUow = createSuiteUnitOfWork(adapter, "encoded-cursor-before").findWithCursor(
          "users",
          (b) =>
            b
              .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Encoded "))
              .before(beforeCursor),
        );
        await beforeUow.executeRetrieve();
        const [beforePage] = await beforeUow.retrievalPhase;
        expect(beforePage.items.map((user: { name: string }) => user.name)).toEqual([
          "Encoded A",
          "Encoded B",
        ]);
        expect(beforePage.hasNextPage).toBe(false);

        const descFirstUow = createSuiteUnitOfWork(
          adapter,
          "encoded-cursor-desc-page-1",
        ).findWithCursor("users", (b) =>
          b
            .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Encoded "))
            .orderByIndex("users_name_idx", "desc")
            .pageSize(2),
        );
        await descFirstUow.executeRetrieve();
        const [descFirstPage] = await descFirstUow.retrievalPhase;
        expect(descFirstPage.items.map((user: { name: string }) => user.name)).toEqual([
          "Encoded D",
          "Encoded Composite",
        ]);
        expect(descFirstPage.hasNextPage).toBe(true);
        expect(descFirstPage.cursor).toBeInstanceOf(Cursor);
        if (!descFirstPage.cursor) {
          throw new Error("Expected desc first page cursor");
        }

        const descSecondUow = createSuiteUnitOfWork(
          adapter,
          "encoded-cursor-desc-page-2",
        ).findWithCursor("users", (b) =>
          b
            .whereIndex("users_name_idx", (eb) => eb("name", "starts with", "Encoded "))
            .after(descFirstPage.cursor!),
        );
        await descSecondUow.executeRetrieve();
        const [descSecondPage] = await descSecondUow.retrievalPhase;
        expect(descSecondPage.items.map((user: { name: string }) => user.name)).toEqual([
          "Encoded C",
          "Encoded B",
        ]);
        expect(descSecondPage.hasNextPage).toBe(true);

        const compositeFirstUow = createSuiteUnitOfWork(
          adapter,
          "encoded-composite-page-1",
        ).findWithCursor("users", (b) =>
          b
            .whereIndex("users_name_id_idx", (eb) => eb("name", "=", "Encoded Composite"))
            .orderByIndex("users_name_id_idx", "asc")
            .pageSize(2),
        );
        await compositeFirstUow.executeRetrieve();
        const [compositeFirstPage] = await compositeFirstUow.retrievalPhase;
        expect(
          compositeFirstPage.items.map((user: { id: FragnoId }) => user.id.externalId),
        ).toEqual(["composite-a", "composite-b"]);
        expect(compositeFirstPage.hasNextPage).toBe(true);
        if (!compositeFirstPage.cursor) {
          throw new Error("Expected composite first page cursor");
        }

        const compositeSecondUow = createSuiteUnitOfWork(
          adapter,
          "encoded-composite-page-2",
        ).findWithCursor("users", (b) =>
          b
            .whereIndex("users_name_id_idx", (eb) => eb("name", "=", "Encoded Composite"))
            .after(compositeFirstPage.cursor!),
        );
        await compositeSecondUow.executeRetrieve();
        const [compositeSecondPage] = await compositeSecondUow.retrievalPhase;
        expect(
          compositeSecondPage.items.map((user: { id: FragnoId }) => user.id.externalId),
        ).toEqual(["composite-c"]);
        expect(compositeSecondPage.hasNextPage).toBe(false);
      } finally {
        await close?.();
      }
    });

    it("rolls back a failed unique create without leaving a partially indexed row", async () => {
      const { adapter, close } = await createContext();
      try {
        const seed = createSuiteUnitOfWork(adapter, "seed-partial-unique");
        seed.create("users", {
          id: "partial-original",
          name: "Partial Original",
          email: "partial@example.com",
          age: 1,
        });
        await seed.executeMutations();

        const badCreate = createSuiteUnitOfWork(adapter, "bad-partial-unique-create");
        badCreate.create("users", {
          id: "partial-bad",
          name: "Partial Bad",
          email: "partial@example.com",
          age: 2,
        });
        await expect(badCreate.executeMutations()).rejects.toBeInstanceOf(DatabaseConstraintError);

        const [byPrimary, byEmail] = await createSuiteUnitOfWork(adapter, "verify-partial-rollback")
          .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", "partial-bad")))
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "partial@example.com")),
          )
          .executeRetrieve();
        expect(byPrimary).toHaveLength(0);
        expect(byEmail.map((user) => user.id.externalId)).toEqual(["partial-original"]);
      } finally {
        await close?.();
      }
    });

    it("rolls back earlier mutations when a later checked mutation conflicts", async () => {
      const { adapter, close } = await createContext();
      try {
        const seed = createSuiteUnitOfWork(adapter, "seed-late-conflict");
        seed.create("users", {
          id: "late-conflict-a",
          name: "Late A",
          email: "late-a@example.com",
          age: 10,
        });
        seed.create("users", {
          id: "late-conflict-b",
          name: "Late B",
          email: "late-b@example.com",
          age: 20,
        });
        await seed.executeMutations();
        const [firstId, staleSecondId] = seed.getCreatedIds();

        const bumpSecond = createSuiteUnitOfWork(adapter, "bump-late-conflict-second");
        bumpSecond.update("users", staleSecondId!, (b) => b.set({ age: 21 }).check());
        expect((await bumpSecond.executeMutations()).success).toBe(true);

        const staleTransfer = createSuiteUnitOfWork(adapter, "late-conflict-rolls-back-first");
        staleTransfer.update("users", firstId!, (b) => b.set({ age: 11 }).check());
        staleTransfer.update("users", staleSecondId!, (b) => b.set({ age: 22 }).check());
        expect((await staleTransfer.executeMutations()).success).toBe(false);

        const [[first], [second]] = await createSuiteUnitOfWork(adapter, "verify-late-conflict")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "late-a@example.com")),
          )
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "late-b@example.com")),
          )
          .executeRetrieve();
        expect(first).toMatchObject({ age: 10, id: expect.objectContaining({ version: 0 }) });
        expect(second).toMatchObject({ age: 21, id: expect.objectContaining({ version: 1 }) });
      } finally {
        await close?.();
      }
    });

    it("filters nullable indexed columns with isNull and isNotNull", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-null-age-users");
        create.create("users", {
          id: "null-age-user",
          name: "Null Age",
          email: "null-age@example.com",
          age: null,
        });
        create.create("users", {
          id: "set-age-user",
          name: "Set Age",
          email: "set-age@example.com",
          age: 7,
        });
        await create.executeMutations();

        const [nullAgeUsers, setAgeUsers] = await createSuiteUnitOfWork(adapter, "read-null-ages")
          .find("users", (b) => b.whereIndex("users_age_idx", (eb) => eb.isNull("age")))
          .find("users", (b) => b.whereIndex("users_age_idx", (eb) => eb.isNotNull("age")))
          .executeRetrieve();
        expect(nullAgeUsers).toMatchObject([{ name: "Null Age", age: null }]);
        expect(setAgeUsers.map((user) => user.name).sort()).toEqual(["Set Age"]);
      } finally {
        await close?.();
      }
    });

    it("supports comparison, set, string, and boolean-composition operators", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-operator-users");
        for (const user of [
          { id: "operator-alice", name: "Alice", email: "operator-alice@example.com", age: 20 },
          { id: "operator-alicia", name: "Alicia", email: "operator-alicia@example.com", age: 30 },
          { id: "operator-bob", name: "Bob", email: "operator-bob@example.com", age: 10 },
          { id: "operator-carol", name: "Carol", email: "operator-carol@example.com", age: 40 },
        ] as const) {
          create.create("users", user);
        }
        await create.executeMutations();

        const [
          range,
          outsideRange,
          inNames,
          notInAndNotEndsWith,
          containsNotEquals,
          notStartsWith,
          notContains,
        ] = await createSuiteUnitOfWork(adapter, "read-operator-users")
          .find("users", (b) =>
            b.whereIndex("users_age_idx", (eb) => eb.and(eb("age", ">=", 20), eb("age", "<=", 30))),
          )
          .find("users", (b) =>
            b.whereIndex("users_age_idx", (eb) => eb.or(eb("age", "<", 20), eb("age", ">", 30))),
          )
          .find("users", (b) =>
            b.whereIndex("users_name_idx", (eb) => eb("name", "in", ["Alice", "Bob"])),
          )
          .find("users", (b) =>
            b.whereIndex("users_name_idx", (eb) =>
              eb.and(eb("name", "not in", ["Carol"]), eb.not(eb("name", "ends with", "ia"))),
            ),
          )
          .find("users", (b) =>
            b.whereIndex("users_name_idx", (eb) =>
              eb.and(eb("name", "contains", "lic"), eb("name", "!=", "Alice")),
            ),
          )
          .find("users", (b) =>
            b.whereIndex("users_name_idx", (eb) => eb("name", "not starts with", "A")),
          )
          .find("users", (b) =>
            b.whereIndex("users_name_idx", (eb) => eb("name", "not contains", "lic")),
          )
          .executeRetrieve();

        const names = (rows: { name: string }[]) => rows.map((user) => user.name).sort();
        expect(names(range)).toEqual(["Alice", "Alicia"]);
        expect(names(outsideRange)).toEqual(["Bob", "Carol"]);
        expect(names(inNames)).toEqual(["Alice", "Bob"]);
        expect(names(notInAndNotEndsWith)).toEqual(["Alice", "Bob"]);
        expect(names(containsNotEquals)).toEqual(["Alicia"]);
        expect(names(notStartsWith)).toEqual(["Bob", "Carol"]);
        expect(names(notContains)).toEqual(["Bob", "Carol"]);
      } finally {
        await close?.();
      }
    });

    it("filters reference columns by external id string, FragnoId, and reference lists", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-reference-filter-data");
        create.create("users", {
          id: "reference-filter-user",
          name: "Reference Filter",
          email: "reference-filter@example.com",
          age: 1,
        });
        create.create("users", {
          id: "reference-filter-other",
          name: "Reference Filter Other",
          email: "reference-filter-other@example.com",
          age: 1,
        });
        create.create("posts", {
          id: "reference-filter-post",
          user_id: "reference-filter-user",
          title: "Reference Target",
          content: "Target",
        });
        create.create("posts", {
          id: "reference-filter-other-post",
          user_id: "reference-filter-other",
          title: "Reference Other",
          content: "Other",
        });
        await create.executeMutations();
        const [userId] = create.getCreatedIds();

        const [byExternalId, byFragnoId, byReferenceList] = await createSuiteUnitOfWork(
          adapter,
          "read-reference-filter-data",
        )
          .find("posts", (b) =>
            b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", "reference-filter-user")),
          )
          .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", userId!)))
          .find("posts", (b) =>
            b.whereIndex("posts_user_idx", (eb) => eb("user_id", "in", [userId!])),
          )
          .executeRetrieve();

        expect(byExternalId.map((post) => post.title)).toEqual(["Reference Target"]);
        expect(byFragnoId.map((post) => post.title)).toEqual(["Reference Target"]);
        expect(byReferenceList.map((post) => post.title)).toEqual(["Reference Target"]);
      } finally {
        await close?.();
      }
    });

    it("returns empty arrays for empty joinMany relations and null for filtered-out joinOne relations", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-empty-join-data");
        create.create("users", {
          id: "empty-join-user",
          name: "Empty Join",
          email: "empty-join@example.com",
          age: 1,
        });
        create.create("posts", {
          id: "filtered-join-post",
          user_id: "empty-join-user",
          title: "Filtered Join",
          content: "Filtered",
        });
        await create.executeMutations();

        const [users, posts] = await createSuiteUnitOfWork(adapter, "read-empty-join-data")
          .find("users", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", "empty-join-user"))
              .joinMany("memberships", "memberships", (memberships) =>
                memberships.onIndex("memberships_user_idx", (eb) =>
                  eb("user_id", "=", eb.parent("id")),
                ),
              ),
          )
          .find("posts", (b) =>
            b
              .whereIndex("posts_title_idx", (eb) => eb("title", "=", "Filtered Join"))
              .joinOne("author", "users", (author) =>
                author
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
                  .whereIndex("users_name_idx", (eb) => eb("name", "=", "No Match")),
              ),
          )
          .executeRetrieve();

        expect(users[0]).toMatchObject({ memberships: [] });
        expect(posts[0]).toMatchObject({ author: null });
      } finally {
        await close?.();
      }
    });

    it("orders and limits child joinMany relations", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-ordered-child-joins");
        create.create("users", {
          id: "ordered-child-user",
          name: "Ordered Child",
          email: "ordered-child@example.com",
          age: 1,
        });
        for (const suffix of ["a", "b", "c"] as const) {
          create.create("emails", {
            id: `ordered-child-email-${suffix}`,
            user_id: "ordered-child-user",
            email: `ordered-child-${suffix}@example.com`,
            is_primary: suffix === "a",
          });
        }
        await create.executeMutations();

        const [users] = await createSuiteUnitOfWork(adapter, "read-ordered-child-joins")
          .find("users", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", "ordered-child-user"))
              .joinMany("emails", "emails", (emails) =>
                emails
                  .onIndex("emails_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
                  .select(["email"])
                  .orderByIndex("emails_email_idx", "desc")
                  .pageSize(2),
              ),
          )
          .executeRetrieve();

        expect(users[0]?.emails).toMatchObject([
          { email: "ordered-child-c@example.com" },
          { email: "ordered-child-b@example.com" },
        ]);
      } finally {
        await close?.();
      }
    });

    it("filters child joinMany relations with child whereIndex constants", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-filtered-child-joins");
        create.create("users", {
          id: "filtered-child-user",
          name: "Filtered Child",
          email: "filtered-child@example.com",
          age: 1,
        });
        for (const [id, email] of [
          ["filtered-child-email-a", "constant-keep-a@example.com"],
          ["filtered-child-email-b", "constant-drop@example.com"],
          ["filtered-child-email-c", "constant-keep-c@example.com"],
        ] as const) {
          create.create("emails", {
            id,
            user_id: "filtered-child-user",
            email,
            is_primary: false,
          });
        }
        await create.executeMutations();

        const [users] = await createSuiteUnitOfWork(adapter, "read-filtered-child-joins")
          .find("users", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", "filtered-child-user"))
              .joinMany("emails", "emails", (emails) =>
                emails
                  .onIndex("emails_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
                  .whereIndex("emails_email_idx", (eb) =>
                    eb("email", "starts with", "constant-keep"),
                  )
                  .select(["email"])
                  .orderByIndex("emails_email_idx", "asc"),
              ),
          )
          .executeRetrieve();

        expect(users[0]?.emails).toMatchObject([
          { email: "constant-keep-a@example.com" },
          { email: "constant-keep-c@example.com" },
        ]);
      } finally {
        await close?.();
      }
    });

    it("executes handlerTx service calls, checked mutation, retry policy, and transform", async () => {
      const { adapter, close } = await createContext();
      try {
        const create = createSuiteUnitOfWork(adapter, "create-handler-tx-user");
        create.create("users", {
          id: "handler-tx-user",
          name: "HandlerTx",
          email: "handler-tx@example.com",
          age: 42,
        });
        await create.executeMutations();

        const [[user]] = await createSuiteUnitOfWork(adapter, "read-handler-tx-user")
          .find("users", (b) =>
            b.whereIndex("users_email_idx", (eb) => eb("email", "=", "handler-tx@example.com")),
          )
          .executeRetrieve();

        let currentUow: ReturnType<typeof createSuiteUnitOfWork> | null = null;
        const getUserById = (userId: typeof user.id) =>
          createServiceTxBuilder(queryEngineSuiteSchema, currentUow!)
            .retrieve((uow) =>
              uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
            )
            .transformRetrieve(([users]) => users[0] ?? null)
            .build();

        const result = await createHandlerTxBuilder({
          createUnitOfWork: () => {
            currentUow = createSuiteUnitOfWork(adapter, "handler-tx-update");
            return currentUow;
          },
          retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
        })
          .withServiceCalls(() => [getUserById(user.id)])
          .mutate(({ forSchema, serviceIntermediateResult: [foundUser] }) => {
            if (!foundUser) {
              throw new Error("User not found");
            }
            const newAge = foundUser.age! + 1;
            forSchema(queryEngineSuiteSchema).update("users", foundUser.id, (b) =>
              b.set({ age: newAge }).check(),
            );
            return { previousAge: foundUser.age, newAge };
          })
          .transform(({ mutateResult }) => {
            expect(mutateResult.newAge).toBe(mutateResult.previousAge! + 1);
            return mutateResult;
          })
          .execute();

        expect(result).toEqual({ previousAge: 42, newAge: 43 });

        const [updatedUser] = await createSuiteUnitOfWork(adapter, "verify-handler-tx-user")
          .findFirst("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", user.id)))
          .executeRetrieve();
        expect(updatedUser).toMatchObject({
          id: expect.objectContaining({ externalId: "handler-tx-user", version: 1 }),
          age: 43,
        });
      } finally {
        await close?.();
      }
    });

    it("roundtrips DateTime, Date, JSON, and BigInt values", async () => {
      const { adapter, close } = await createContext();
      try {
        const happenedOn = new Date("2024-06-18T00:00:00.000Z");
        const createdAt = new Date("2024-06-18T12:34:56.000Z");
        const bigScore = 9007199254740991n;
        const payload = { nested: { ok: true }, tags: ["a", "b"] };
        const create = createSuiteUnitOfWork(adapter, "create-scalar-event");
        create.create("events", {
          id: "scalar-event",
          name: "Scalar",
          created_at: createdAt,
          happened_on: happenedOn,
          payload,
          big_score: bigScore,
        });
        await create.executeMutations();

        const [[event]] = await createSuiteUnitOfWork(adapter, "read-scalar-event")
          .find("events", (b) => b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Scalar")))
          .executeRetrieve();
        expect(event.created_at).toBeInstanceOf(Date);
        expect(event.happened_on).toBeInstanceOf(Date);
        expect(event.happened_on.toISOString().slice(0, 10)).toBe("2024-06-18");
        expect(event.payload).toEqual(payload);
        expect(event.big_score).toBe(bigScore);
      } finally {
        await close?.();
      }
    });
  });
}
