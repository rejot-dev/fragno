import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { SqlAdapter } from "./generic-sql-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { Cursor } from "../../query/cursor";
import { PGLiteDriverConfig } from "./driver-config";
import { internalSchema } from "../../fragments/internal-fragment";
import type { CompiledQuery } from "../../sql-driver/sql-driver";

describe("SqlAdapter PGLite", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("name_idx", ["name"]);
      })
      .addTable("emails", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn())
          .addColumn("email", column("string"))
          .addColumn("is_primary", column("bool").defaultTo(false))
          .createIndex("unique_email", ["email"], { unique: true })
          .createIndex("user_emails", ["user_id"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .createIndex("posts_user_idx", ["user_id"]);
      })
      .addTable("comments", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("post_id", referenceColumn())
          .addColumn("user_id", referenceColumn())
          .addColumn("text", column("string"))
          .createIndex("comments_post_idx", ["post_id"])
          .createIndex("comments_user_idx", ["user_id"]);
      })
      .addTable("events", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn(
            "created_at",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn("happened_on", column("date"))
          .addColumn("payload", column("json").nullable())
          .addColumn("big_score", column("bigint"))
          .createIndex("events_name_idx", ["name"]);
      })
      .addReference("user", {
        type: "one",
        from: { table: "emails", column: "user_id" },
        to: { table: "users", column: "id" },
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "user_id" },
        to: { table: "users", column: "id" },
      })
      .addReference("post", {
        type: "one",
        from: { table: "comments", column: "post_id" },
        to: { table: "posts", column: "id" },
      })
      .addReference("commenter", {
        type: "one",
        from: { table: "comments", column: "user_id" },
        to: { table: "users", column: "id" },
      });
  });

  let adapter: SqlAdapter;

  beforeAll(async () => {
    const pgliteDatabase = new PGlite();

    const { dialect } = new KyselyPGlite(pgliteDatabase);

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new PGLiteDriverConfig(),
    });

    {
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should execute Unit of Work with version checking", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", {
      name: "SqlAdapter PGLite Alice",
      age: 25,
    });
    createUow.create("users", {
      name: "SqlAdapter PGLite Bob",
      age: 30,
    });

    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      Parameters<typeof createUow.find>[0]
    >();
    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      "users" | "emails" | "posts" | "comments" | "events"
    >();

    const { success: createSuccess } = await createUow.executeMutations();
    expect(createSuccess).toBe(true);

    const createdIds = createUow.getCreatedIds();
    expect(createdIds).toHaveLength(2);

    const initialUserId = createdIds[0];

    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)));

    const [users] = await uow.executeRetrieve();

    uow.update("users", initialUserId, (b) => b.set({ age: 26 }).check());

    const { success } = await uow.executeMutations();
    expect(success).toBe(true);
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("SqlAdapter PGLite Alice");

    const [[updatedUser]] = await queryEngine
      .createUnitOfWork("get-updated-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: initialUserId.externalId,
        version: 1,
      }),
      age: 26,
    });

    const uow2 = queryEngine.createUnitOfWork("update-user-stale");
    uow2.update("users", initialUserId, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();
    expect(success2).toBe(false);

    const [[unchangedUser]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(unchangedUser).toMatchObject({
      id: expect.objectContaining({
        version: 1,
      }),
      age: 26,
    });
  });

  it("should support count operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-users-count");
    createUow.create("users", { name: "SqlAdapter PGLite Count 1", age: 21 });
    createUow.create("users", { name: "SqlAdapter PGLite Count 2", age: 31 });
    createUow.create("users", { name: "SqlAdapter PGLite Count 3", age: 41 });
    await createUow.executeMutations();

    const [totalCount] = await queryEngine
      .createUnitOfWork("count-all")
      .find("users", (b) => b.whereIndex("primary").selectCount())
      .executeRetrieve();

    expect(totalCount).toBeGreaterThanOrEqual(3);
    expect(typeof totalCount).toBe("number");
  });

  it("should support cursor-based pagination", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "SqlAdapter PGLite Manual Cursor";

    const createUow = queryEngine.createUnitOfWork("create-cursor-users");
    createUow.create("users", { name: `${prefix} A`, age: 20 });
    createUow.create("users", { name: `${prefix} B`, age: 30 });
    createUow.create("users", { name: `${prefix} C`, age: 40 });
    createUow.create("users", { name: `${prefix} D`, age: 50 });
    createUow.create("users", { name: `${prefix} E`, age: 60 });

    await createUow.executeMutations();

    const [firstPage] = await queryEngine
      .createUnitOfWork("first-page")
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
          .orderByIndex("name_idx", "asc")
          .pageSize(2),
      )
      .executeRetrieve();

    expect(firstPage).toHaveLength(2);
    expect(firstPage.map((u) => u.name)).toEqual([`${prefix} A`, `${prefix} B`]);

    const lastItem = firstPage[firstPage.length - 1]!;
    const cursor = new Cursor({
      indexName: "name_idx",
      orderDirection: "asc",
      pageSize: 2,
      indexValues: { name: lastItem.name },
    }).encode();

    const [secondPage] = await queryEngine
      .createUnitOfWork("second-page")
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
          .orderByIndex("name_idx", "asc")
          .after(cursor)
          .pageSize(2),
      )
      .executeRetrieve();

    expect(secondPage).toHaveLength(2);
    expect(secondPage.map((u) => u.name)).toEqual([`${prefix} C`, `${prefix} D`]);
  });

  it("should support cursor-based pagination with findWithCursor()", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "SqlAdapter PGLite Cursor";

    for (let i = 1; i <= 12; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i.toString().padStart(2, "0")}`,
        age: 20 + i,
      });
    }

    const firstPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(firstPage.items).toHaveLength(5);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeInstanceOf(Cursor);

    const secondPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .after(firstPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.hasNextPage).toBe(true);
    expect(secondPage.cursor).toBeInstanceOf(Cursor);

    const thirdPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .after(secondPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(thirdPage.items).toHaveLength(2);
    expect(thirdPage.hasNextPage).toBe(false);
    expect(thirdPage.cursor).toBeUndefined();

    const emptyPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", "NoMatchPrefix"))
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(emptyPage.items).toHaveLength(0);
    expect(emptyPage.hasNextPage).toBe(false);
    expect(emptyPage.cursor).toBeUndefined();
  });

  it("should support findWithCursor() in Unit of Work", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "SqlAdapter PGLite UOW Cursor";

    for (let i = 1; i <= 6; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i}`,
        age: 40 + i,
      });
    }

    const uow = queryEngine.createUnitOfWork("cursor-test").findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    const [result] = await uow.executeRetrieve();

    expect(result.items).toHaveLength(5);
    expect(typeof result.hasNextPage).toBe("boolean");
    expect(result.cursor).toBeInstanceOf(Cursor);
  });

  it("should support joins", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const queries: CompiledQuery[] = [];

    const createUow = queryEngine.createUnitOfWork("create-join-user");
    createUow.create("users", { name: "SqlAdapter PGLite Email User", age: 20 });
    const { success } = await createUow.executeMutations();
    expect(success).toBe(true);

    const [usersResult] = await queryEngine
      .createUnitOfWork("get-created-user")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "SqlAdapter PGLite Email User")),
      )
      .executeRetrieve();

    expect(usersResult).toHaveLength(1);
    const createdUser = usersResult[0];
    expect(createdUser.name).toBe("SqlAdapter PGLite Email User");

    const createEmailUow = queryEngine.createUnitOfWork("create-test-email");
    createEmailUow.create("emails", {
      user_id: createdUser.id,
      email: "prisma-pglite@example.com",
      is_primary: true,
    });
    await createEmailUow.executeMutations();

    const uow = queryEngine
      .createUnitOfWork("test-joins", { onQuery: (query) => queries.push(query) })
      .find("emails", (b) =>
        b
          .whereIndex("user_emails", (eb) => eb("user_id", "=", createdUser.id))
          .join((jb) => jb.user((builder) => builder.select(["name", "id", "age"]))),
      );

    const [[email]] = await uow.executeRetrieve();

    const [query] = queries;
    expect(query.sql).toMatchInlineSnapshot(
      `"select "user"."name" as "user:name", "user"."id" as "user:id", "user"."age" as "user:age", "user"."_internalId" as "user:_internalId", "user"."_version" as "user:_version", "user"."_shard" as "user:_shard", "namespace"."emails"."id" as "id", "namespace"."emails"."user_id" as "user_id", "namespace"."emails"."email" as "email", "namespace"."emails"."is_primary" as "is_primary", "namespace"."emails"."_internalId" as "_internalId", "namespace"."emails"."_version" as "_version", "namespace"."emails"."_shard" as "_shard" from "namespace"."emails" left join "namespace"."users" as "user" on "namespace"."emails"."user_id" = "user"."_internalId" where "namespace"."emails"."user_id" = $1"`,
    );

    expect(email).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(BigInt),
      }),
      email: "prisma-pglite@example.com",
      is_primary: true,
      user: {
        id: expect.objectContaining({
          externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
          internalId: expect.any(BigInt),
        }),
        name: "SqlAdapter PGLite Email User",
        age: 20,
      },
    });
  });

  it("should support inserting with external id string", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUserUow = queryEngine.createUnitOfWork("create-user-for-external-id");
    createUserUow.create("users", { name: "SqlAdapter PGLite External ID User", age: 35 });
    await createUserUow.executeMutations();

    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-external-id")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "SqlAdapter PGLite External ID User")),
      )
      .executeRetrieve();

    const createEmailUow = queryEngine.createUnitOfWork("create-email-with-external-id");
    createEmailUow.create("emails", {
      user_id: user.id.externalId,
      email: "prisma-pglite-external-id@example.com",
      is_primary: false,
    });

    const { success } = await createEmailUow.executeMutations();
    expect(success).toBe(true);

    const [[email]] = await queryEngine
      .createUnitOfWork("get-email-by-external-id")
      .find("emails", (b) =>
        b
          .whereIndex("unique_email", (eb) =>
            eb("email", "=", "prisma-pglite-external-id@example.com"),
          )
          .join((jb) => jb.user((builder) => builder.select(["name", "id"]))),
      )
      .executeRetrieve();

    expect(email).toMatchObject({
      email: "prisma-pglite-external-id@example.com",
      is_primary: false,
      user_id: expect.objectContaining({
        internalId: user.id.internalId,
      }),
      user: {
        id: expect.objectContaining({
          externalId: user.id.externalId,
        }),
        name: "SqlAdapter PGLite External ID User",
      },
    });
  });

  it("should create user and post in same transaction using returned ID", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const uow = queryEngine.createUnitOfWork("create-user-and-post");
    const userId = uow.create("users", {
      name: "SqlAdapter PGLite UOW User",
      age: 35,
    });

    const postId = uow.create("posts", {
      user_id: userId,
      title: "SqlAdapter PGLite UOW Post",
      content: "This post was created in the same transaction as the user",
    });

    const { success } = await uow.executeMutations();
    expect(success).toBe(true);

    const userIdStr = userId.toString();
    const postIdStr = postId.toString();

    const [[user]] = await queryEngine
      .createUnitOfWork("verify-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userIdStr)))
      .executeRetrieve();

    const [[post]] = await queryEngine
      .createUnitOfWork("verify-post")
      .find("posts", (b) => b.whereIndex("primary", (eb) => eb("id", "=", postIdStr)))
      .executeRetrieve();

    expect(user.name).toBe("SqlAdapter PGLite UOW User");
    expect(user.age).toBe(35);
    expect(post.title).toBe("SqlAdapter PGLite UOW Post");
    expect(post.content).toBe("This post was created in the same transaction as the user");
    expect(post.user_id.internalId).toBe(user.id.internalId);
  });

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const queries: CompiledQuery[] = [];

    const createAuthorUow = queryEngine.createUnitOfWork("create-author");
    createAuthorUow.create("users", { name: "SqlAdapter PGLite Author", age: 30 });
    await createAuthorUow.executeMutations();

    const [[author]] = await queryEngine
      .createUnitOfWork("get-author")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "SqlAdapter PGLite Author")),
      )
      .executeRetrieve();

    const createPostUow = queryEngine.createUnitOfWork("create-post");
    createPostUow.create("posts", {
      user_id: author.id,
      title: "SqlAdapter PGLite Post",
      content: "Nested join content",
    });
    await createPostUow.executeMutations();

    const [[post]] = await queryEngine
      .createUnitOfWork("get-post")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", author.id)))
      .executeRetrieve();

    const createCommenterUow = queryEngine.createUnitOfWork("create-commenter");
    createCommenterUow.create("users", { name: "SqlAdapter PGLite Commenter", age: 25 });
    await createCommenterUow.executeMutations();

    const [[commenter]] = await queryEngine
      .createUnitOfWork("get-commenter")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "SqlAdapter PGLite Commenter")),
      )
      .executeRetrieve();

    const createCommentUow = queryEngine.createUnitOfWork("create-comment");
    createCommentUow.create("comments", {
      post_id: post.id,
      user_id: commenter.id,
      text: "Great Prisma post!",
    });
    await createCommentUow.executeMutations();

    const uow = queryEngine
      .createUnitOfWork("test-complex-joins", { onQuery: (query) => queries.push(query) })
      .find("comments", (b) =>
        b.whereIndex("primary").join((jb) =>
          jb
            .post((postBuilder) =>
              postBuilder
                .select(["id", "title", "content"])
                .orderByIndex("primary", "desc")
                .pageSize(1)
                .join((jb2) =>
                  jb2.author((authorBuilder) =>
                    authorBuilder.select(["id", "name", "age"]).orderByIndex("name_idx", "asc"),
                  ),
                ),
            )
            .commenter((commenterBuilder) => commenterBuilder.select(["id", "name"])),
        ),
      );

    const [[comment]] = await uow.executeRetrieve();

    expect(comment).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      text: "Great Prisma post!",
      post: {
        id: expect.objectContaining({
          externalId: post.id.externalId,
        }),
        title: "SqlAdapter PGLite Post",
        content: "Nested join content",
        author: {
          id: expect.objectContaining({
            externalId: author.id.externalId,
          }),
          name: "SqlAdapter PGLite Author",
          age: 30,
        },
      },
      commenter: {
        id: expect.objectContaining({
          externalId: commenter.id.externalId,
        }),
        name: "SqlAdapter PGLite Commenter",
      },
    });

    const [query] = queries;
    expect(query.sql).toMatchInlineSnapshot(
      `"select "post"."id" as "post:id", "post"."title" as "post:title", "post"."content" as "post:content", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "post"."_shard" as "post:_shard", "post_author"."id" as "post:author:id", "post_author"."name" as "post:author:name", "post_author"."age" as "post:author:age", "post_author"."_internalId" as "post:author:_internalId", "post_author"."_version" as "post:author:_version", "post_author"."_shard" as "post:author:_shard", "commenter"."id" as "commenter:id", "commenter"."name" as "commenter:name", "commenter"."_internalId" as "commenter:_internalId", "commenter"."_version" as "commenter:_version", "commenter"."_shard" as "commenter:_shard", "namespace"."comments"."id" as "id", "namespace"."comments"."post_id" as "post_id", "namespace"."comments"."user_id" as "user_id", "namespace"."comments"."text" as "text", "namespace"."comments"."_internalId" as "_internalId", "namespace"."comments"."_version" as "_version", "namespace"."comments"."_shard" as "_shard" from "namespace"."comments" left join "namespace"."posts" as "post" on "namespace"."comments"."post_id" = "post"."_internalId" left join "namespace"."users" as "post_author" on "post"."user_id" = "post_author"."_internalId" left join "namespace"."users" as "commenter" on "namespace"."comments"."user_id" = "commenter"."_internalId""`,
    );
  });

  it("should return created IDs from UOW create operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const uow1 = queryEngine.createUnitOfWork("create-multiple-users");
    uow1.create("users", { name: "SqlAdapter PGLite ID User 1", age: 30 });
    uow1.create("users", { name: "SqlAdapter PGLite ID User 2", age: 35 });
    uow1.create("users", { name: "SqlAdapter PGLite ID User 3", age: 40 });

    const { success: success1 } = await uow1.executeMutations();
    expect(success1).toBe(true);

    const createdIds1 = uow1.getCreatedIds();
    expect(createdIds1).toMatchObject([
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
    ]);

    const externalIds = createdIds1.map((id) => id.externalId);
    expect(new Set(externalIds).size).toBe(3);

    const user1 = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createdIds1[0].externalId)),
    );
    const user2 = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createdIds1[1].externalId)),
    );
    const user3 = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createdIds1[2].externalId)),
    );

    expect(user1).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[0].externalId,
      }),
      name: "SqlAdapter PGLite ID User 1",
      age: 30,
    });

    expect(user2).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[1].externalId,
      }),
      name: "SqlAdapter PGLite ID User 2",
      age: 35,
    });

    expect(user3).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[2].externalId,
      }),
      name: "SqlAdapter PGLite ID User 3",
      age: 40,
    });

    const uow2 = queryEngine.createUnitOfWork("mixed-operations");
    uow2.create("users", { name: "SqlAdapter PGLite New User", age: 50 });
    uow2.update("users", createdIds1[0], (b) => b.set({ age: 31 }));
    uow2.create("users", { name: "SqlAdapter PGLite Another New User", age: 55 });
    uow2.delete("users", createdIds1[2]);

    const { success: success2 } = await uow2.executeMutations();
    expect(success2).toBe(true);

    const createdIds2 = uow2.getCreatedIds();
    expect(createdIds2).toHaveLength(2);
    expect(createdIds2[0].externalId).toBeDefined();
    expect(createdIds2[1].externalId).toBeDefined();

    const customId = "pglite-custom-user-id-1";
    const uow3 = queryEngine.createUnitOfWork("create-with-custom-id");
    uow3.create("users", { id: customId, name: "SqlAdapter PGLite Custom ID User", age: 60 });

    const { success: success3 } = await uow3.executeMutations();
    expect(success3).toBe(true);

    const createdIds3 = uow3.getCreatedIds();
    expect(createdIds3).toHaveLength(1);
    expect(createdIds3[0].externalId).toBe(customId);
    expect(createdIds3[0].internalId).toBeDefined();

    const customIdUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", customId)),
    );

    expect(customIdUser).toMatchObject({
      id: expect.objectContaining({
        externalId: customId,
      }),
      name: "SqlAdapter PGLite Custom ID User",
      age: 60,
    });
  });

  it("should handle timestamps and timezones correctly", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-event-for-timestamp");
    createUow.create("events", {
      name: "Timestamp Event PGLite",
      happened_on: new Date("2024-06-18T00:00:00.000Z"),
      payload: { level: "info", tags: ["timestamp", "pglite"] },
      big_score: 42n,
    });
    await createUow.executeMutations();

    const [[event]] = await queryEngine
      .createUnitOfWork("get-event-for-timestamp")
      .find("events", (b) =>
        b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Timestamp Event PGLite")),
      )
      .executeRetrieve();

    expect(event.created_at).toBeInstanceOf(Date);

    const now = Date.now();
    const createdTime = event.created_at.getTime();
    expect(createdTime).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
    expect(createdTime).toBeLessThan(now + 24 * 60 * 60 * 1000);

    expect(typeof event.created_at.toISOString).toBe("function");
    expect(typeof event.created_at.getTime).toBe("function");
    expect(typeof event.created_at.getTimezoneOffset).toBe("function");

    const isoString = event.created_at.toISOString();
    expect(new Date(isoString).getTime()).toBe(event.created_at.getTime());
  });

  it("should fail check() when version changes", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUserUow = queryEngine.createUnitOfWork("create-user-for-version-conflict");
    createUserUow.create("users", {
      name: "SqlAdapter PGLite Version Conflict User",
      age: 40,
    });
    await createUserUow.executeMutations();

    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-version-conflict")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) =>
          eb("name", "=", "SqlAdapter PGLite Version Conflict User"),
        ),
      )
      .executeRetrieve();

    const updateUow = queryEngine.createUnitOfWork("update-user-version");
    updateUow.update("users", user.id, (b) => b.set({ age: 41 }));
    await updateUow.executeMutations();

    const uow = queryEngine.createUnitOfWork("check-stale-version");
    uow.check("users", user.id);
    uow.create("posts", {
      user_id: user.id,
      title: "SqlAdapter PGLite Should Not Be Created",
      content: "Content",
    });

    const { success } = await uow.executeMutations();
    expect(success).toBe(false);

    const [posts] = await queryEngine
      .createUnitOfWork("get-posts-for-version-conflict")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", user.id)))
      .executeRetrieve();

    const conflictPosts = posts.filter(
      (p) => p.title === "SqlAdapter PGLite Should Not Be Created",
    );
    expect(conflictPosts).toHaveLength(0);
  });

  it("should roundtrip DateTime, Date, JSON, and BigInt", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const beforeCreate = Date.now();
    const happenedOn = new Date("2024-06-15T00:00:00.000Z");
    const payload = { level: "info", tags: ["launch", "pglite"] };
    const bigScore = 9876543210123n;

    const createUow = queryEngine.createUnitOfWork("create-event");
    createUow.create("events", {
      name: "Launch",
      happened_on: happenedOn,
      payload,
      big_score: bigScore,
    });
    await createUow.executeMutations();

    const [[event]] = await queryEngine
      .createUnitOfWork("get-event")
      .find("events", (b) => b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Launch")))
      .executeRetrieve();

    expect(event).toBeDefined();
    expect(event.name).toBe("Launch");
    expect(event.payload).toEqual(payload);
    expect(event.big_score).toBe(bigScore);
    expect(event.happened_on).toBeInstanceOf(Date);
    expect(event.happened_on.toISOString().slice(0, 10)).toBe(
      happenedOn.toISOString().slice(0, 10),
    );
    expect(event.created_at).toBeInstanceOf(Date);

    const createdAtMs = event.created_at.getTime();
    const afterFetch = Date.now();
    expect(createdAtMs).toBeGreaterThan(0);
    expect(Math.abs(createdAtMs - beforeCreate)).toBeLessThan(24 * 60 * 60 * 1000);
    expect(Math.abs(createdAtMs - afterFetch)).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
