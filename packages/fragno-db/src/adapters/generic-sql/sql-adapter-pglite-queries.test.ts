import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import { SqlAdapter } from "./generic-sql-adapter";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { Cursor } from "../../query/cursor";
import { PGLiteDriverConfig } from "./driver-config";
import type { CompiledQuery } from "../../sql-driver/sql-driver";
import { internalSchema } from "../../fragments/internal-fragment";

describe("SqlAdapter PGLite", () => {
  let pgliteDatabase: PGlite;
  let adapter: SqlAdapter;

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
          .addColumn(
            "created_at",
            column("timestamp").defaultTo((b) => b.now()),
          )
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

  const schema2 = schema("schema2", (s) => {
    return s
      .addTable("products", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("price", column("integer"))
          .createIndex("name_idx", ["name"]);
      })
      .addTable("orders", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("product_id", referenceColumn())
          .addColumn("quantity", column("integer"))
          .addColumn("user_id", referenceColumn())
          .createIndex("orders_user_idx", ["user_id"])
          .createIndex("orders_product_idx", ["product_id"]);
      });
  });

  beforeAll(async () => {
    pgliteDatabase = new PGlite();

    const { dialect } = new KyselyPGlite(pgliteDatabase);

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new PGLiteDriverConfig(),
    });

    // Create settings table first (needed for version tracking)
    {
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(schema2, "namespace2");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should execute Unit of Work with version checking", async () => {
    // Pass namespace to ensure mapper translates logical table names to physical (prefixed) names
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create initial user using UOW
    const createUow = queryEngine.createUnitOfWork("create-user");
    createUow.create("users", {
      name: "Alice",
      age: 25,
    });

    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      Parameters<typeof createUow.find>[0]
    >();
    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      "users" | "emails" | "posts" | "comments"
    >();

    const { success: createSuccess } = await createUow.executeMutations();
    expect(createSuccess).toBe(true);

    // Fetch the created user to get its ID
    const [[initialUser]] = await queryEngine
      .createUnitOfWork("get-created-user")
      .find("users")
      .executeRetrieve();

    expect(initialUser).toBeDefined();
    expect(initialUser.name).toBe("Alice");
    expect(initialUser.id.version).toBe(0);

    const initialUserId = initialUser.id;

    // Build a UOW to update the user with optimistic locking
    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      // Retrieval phase: find the user
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)));

    // Execute retrieval and transition to mutation phase
    const [users] = await uow.executeRetrieve();

    // Mutation phase: update with version check
    uow.update("users", initialUserId, (b) => b.set({ age: 26 }).check());

    // Execute mutations
    const { success } = await uow.executeMutations();

    // Should succeed
    expect(success).toBe(true);
    expect(users).toHaveLength(1);

    // Verify the user was updated
    const [[updatedUser]] = await queryEngine
      .createUnitOfWork("get-updated-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: initialUserId.externalId,
        version: 1, // Version incremented
      }),
      name: "Alice",
      age: 26,
    });

    // Try to update again with stale version (should fail)
    const uow2 = queryEngine.createUnitOfWork("update-user-stale");

    // Use the old version (0) which is now stale
    uow2.update("users", initialUserId, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();

    // Should fail due to version conflict
    expect(success2).toBe(false);

    // Verify the user was NOT updated
    const [[unchangedUser]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(unchangedUser).toMatchObject({
      id: expect.objectContaining({
        version: 1, // Still version 1
      }),
      age: 26, // Still 26, not 27
    });
  });

  it("should support count operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create some users
    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", { name: "User1", age: 20 });
    createUow.create("users", { name: "User2", age: 30 });
    createUow.create("users", { name: "User3", age: 40 });
    await createUow.executeMutations();

    // Count all users
    const [totalCount] = await queryEngine
      .createUnitOfWork("count-all")
      .find("users", (b) => b.whereIndex("primary").selectCount())
      .executeRetrieve();

    // Tests are not isolated, so we can't use expect(totalCount).toBe(3)
    expect(totalCount).toBeGreaterThanOrEqual(3);
  });

  it("should support cursor-based pagination", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", { name: "Page User A", age: 20 });
    createUow.create("users", { name: "Page User B", age: 30 });
    createUow.create("users", { name: "Page User C", age: 40 });
    createUow.create("users", { name: "Page User D", age: 50 });
    createUow.create("users", { name: "Page User E", age: 60 });

    await createUow.executeMutations();

    // Fetch first page ordered by name
    const [firstPage] = await queryEngine
      .createUnitOfWork("first-page")
      .find("users", (b) => b.whereIndex("name_idx").orderByIndex("name_idx", "asc").pageSize(2))
      .executeRetrieve();

    // Verify first page contains the first 2 users alphabetically
    expect(firstPage.map((u) => u.name)).toEqual(["Alice", "Page User A"]);

    // Create cursor from last item of first page
    const lastItem = firstPage[firstPage.length - 1]!;
    const cursor = new Cursor({
      indexName: "name_idx",
      orderDirection: "asc",
      pageSize: 2,
      indexValues: { name: lastItem.name },
    }).encode();

    // Fetch next page using cursor
    const [secondPage] = await queryEngine
      .createUnitOfWork("second-page")
      .find("users", (b) =>
        b.whereIndex("name_idx").orderByIndex("name_idx", "asc").after(cursor).pageSize(2),
      )
      .executeRetrieve();

    // Verify page 2 continues alphabetically
    expect(secondPage.map((u) => u.name)).toEqual(["Page User B", "Page User C"]);

    // Ensure no overlap between pages
    const firstPageNames = new Set(firstPage.map((u) => u.name));
    for (const user of secondPage) {
      expect(firstPageNames.has(user.name)).toBe(false);
    }
  });

  it("should support joins", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const queries: CompiledQuery[] = [];

    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", { name: "Email User", age: 20 });

    await createUow.executeMutations();

    // Get an existing user to create an email for
    const [[existingUser]] = await queryEngine
      .createUnitOfWork("get-existing-user")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Email User")))
      .executeRetrieve();

    // Create an email for testing joins
    const createEmailUow = queryEngine.createUnitOfWork("create-test-email");
    createEmailUow.create("emails", {
      user_id: existingUser.id,
      email: "test@example.com",
      is_primary: true,
    });
    await createEmailUow.executeMutations();

    // Test join query
    const uow = queryEngine
      .createUnitOfWork("test-joins", { onQuery: (query) => queries.push(query) })
      .find("emails", (b) =>
        b
          .whereIndex("user_emails")
          .join((jb) => jb.user((builder) => builder.select(["name", "id", "age"]))),
      );

    const [[email]] = await uow.executeRetrieve();

    const [query] = queries;
    expect(query.sql).toMatchInlineSnapshot(
      `"select "user"."name" as "user:name", "user"."id" as "user:id", "user"."age" as "user:age", "user"."_internalId" as "user:_internalId", "user"."_version" as "user:_version", "user"."_shard" as "user:_shard", "namespace"."emails"."id" as "id", "namespace"."emails"."user_id" as "user_id", "namespace"."emails"."email" as "email", "namespace"."emails"."is_primary" as "is_primary", "namespace"."emails"."_internalId" as "_internalId", "namespace"."emails"."_version" as "_version", "namespace"."emails"."_shard" as "_shard" from "namespace"."emails" left join "namespace"."users" as "user" on "namespace"."emails"."user_id" = "user"."_internalId""`,
    );

    expect(email).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(BigInt),
      }),
      email: "test@example.com",
      is_primary: true,
      user: {
        id: expect.objectContaining({
          externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
          internalId: expect.any(BigInt),
        }),
        name: existingUser.name,
        age: existingUser.age,
      },
    });
  });

  it("should support inserting with external id string", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create a user first
    const createUserUow = queryEngine.createUnitOfWork("create-user-for-external-id");
    createUserUow.create("users", { name: "External ID Test User", age: 35 });
    await createUserUow.executeMutations();

    // Get the user
    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-external-id")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "External ID Test User")),
      )
      .executeRetrieve();

    // Create an email using just the external id string (not the full id object)
    const createEmailUow = queryEngine.createUnitOfWork("create-email-with-external-id");
    createEmailUow.create("emails", {
      user_id: user.id.externalId,
      email: "external-id-test@example.com",
      is_primary: false,
    });

    const { success } = await createEmailUow.executeMutations();
    expect(success).toBe(true);

    // Verify the email was created and can be retrieved with a join
    const [[email]] = await queryEngine
      .createUnitOfWork("get-email-by-external-id")
      .find("emails", (b) =>
        b
          .whereIndex("unique_email", (eb) => eb("email", "=", "external-id-test@example.com"))
          .join((jb) => jb.user((builder) => builder.select(["name", "id"]))),
      )
      .executeRetrieve();

    expect(email).toMatchObject({
      email: "external-id-test@example.com",
      is_primary: false,
      user_id: expect.objectContaining({
        internalId: user.id.internalId,
      }),
      user: {
        id: expect.objectContaining({
          externalId: user.id.externalId,
        }),
        name: "External ID Test User",
      },
    });
  });

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const queries: CompiledQuery[] = [];

    // Create a user (author)
    const createAuthorUow = queryEngine.createUnitOfWork("create-author");
    createAuthorUow.create("users", { name: "Blog Author", age: 30 });
    await createAuthorUow.executeMutations();

    // Get the author
    const [[author]] = await queryEngine
      .createUnitOfWork("get-author")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Blog Author")))
      .executeRetrieve();

    // Create a post by the author
    const createPostUow = queryEngine.createUnitOfWork("create-post");
    createPostUow.create("posts", {
      user_id: author.id,
      title: "My First Post",
      content: "This is the content of my first post",
    });
    await createPostUow.executeMutations();

    // Get the post
    const [[post]] = await queryEngine.createUnitOfWork("get-post").find("posts").executeRetrieve();

    // Create a commenter
    const createCommenterUow = queryEngine.createUnitOfWork("create-commenter");
    createCommenterUow.create("users", { name: "Commenter User", age: 25 });
    await createCommenterUow.executeMutations();

    // Get the commenter
    const [[commenter]] = await queryEngine
      .createUnitOfWork("get-commenter")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Commenter User")))
      .executeRetrieve();

    // Create a comment on the post
    const createCommentUow = queryEngine.createUnitOfWork("create-comment");
    createCommentUow.create("comments", {
      post_id: post.id,
      user_id: commenter.id,
      text: "Great post!",
    });
    await createCommentUow.executeMutations();

    // Now perform a complex nested join: comments -> post -> author, and comments -> commenter
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
                  // Nested join to the post's author
                  jb2.author((authorBuilder) =>
                    authorBuilder.select(["id", "name", "age"]).orderByIndex("name_idx", "asc"),
                  ),
                ),
            )
            .commenter((commenterBuilder) => commenterBuilder.select(["id", "name"])),
        ),
      );

    const [[comment]] = await uow.executeRetrieve();

    // Verify the result structure with nested joins
    expect(comment).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      text: "Great post!",
      // Post join (first level)
      post: {
        id: expect.objectContaining({
          externalId: post.id.externalId,
        }),
        title: "My First Post",
        content: "This is the content of my first post",
        // Nested author join (second level) - now decoded!
        author: {
          id: expect.objectContaining({
            externalId: author.id.externalId,
          }),
          name: "Blog Author",
          age: 30,
        },
      },
      // Commenter join (first level)
      commenter: {
        id: expect.objectContaining({
          externalId: commenter.id.externalId,
        }),
        name: "Commenter User",
      },
    });

    const [query] = queries;
    expect(query.sql).toMatchInlineSnapshot(
      `"select "post"."id" as "post:id", "post"."title" as "post:title", "post"."content" as "post:content", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "post"."_shard" as "post:_shard", "post_author"."id" as "post:author:id", "post_author"."name" as "post:author:name", "post_author"."age" as "post:author:age", "post_author"."_internalId" as "post:author:_internalId", "post_author"."_version" as "post:author:_version", "post_author"."_shard" as "post:author:_shard", "commenter"."id" as "commenter:id", "commenter"."name" as "commenter:name", "commenter"."_internalId" as "commenter:_internalId", "commenter"."_version" as "commenter:_version", "commenter"."_shard" as "commenter:_shard", "namespace"."comments"."id" as "id", "namespace"."comments"."post_id" as "post_id", "namespace"."comments"."user_id" as "user_id", "namespace"."comments"."text" as "text", "namespace"."comments"."_internalId" as "_internalId", "namespace"."comments"."_version" as "_version", "namespace"."comments"."_shard" as "_shard" from "namespace"."comments" left join "namespace"."posts" as "post" on "namespace"."comments"."post_id" = "post"."_internalId" left join "namespace"."users" as "post_author" on "post"."user_id" = "post_author"."_internalId" left join "namespace"."users" as "commenter" on "namespace"."comments"."user_id" = "commenter"."_internalId""`,
    );
  });

  it("should handle timestamps and timezones correctly", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create a user
    const createUserUow = queryEngine.createUnitOfWork("create-user-for-timestamp");
    createUserUow.create("users", { name: "Timestamp User", age: 28 });
    await createUserUow.executeMutations();

    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-timestamp")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Timestamp User")))
      .executeRetrieve();

    // Create a post with database-generated timestamp (defaultTo(b => b.now()))
    const createPostUow = queryEngine.createUnitOfWork("create-post-with-timestamp");
    createPostUow.create("posts", {
      user_id: user.id,
      title: "Timestamp Test Post",
      content: "Testing timestamp handling",
    });
    await createPostUow.executeMutations();

    const createdPostIds = createPostUow.getCreatedIds();
    expect(createdPostIds).toHaveLength(1);
    expect(createdPostIds[0].internalId).toBeDefined();
    const postId = createdPostIds[0];

    // Retrieve the specific post we just created by its ID
    const [[post]] = await queryEngine
      .createUnitOfWork("get-post-with-timestamp")
      .find("posts", (b) => b.whereIndex("primary", (eb) => eb("id", "=", postId)))
      .executeRetrieve();

    // Verify created_at is a Date
    expect(post.created_at).toBeInstanceOf(Date);

    // Verify the timestamp is a valid date (not too far in the past or future)
    const now = Date.now();
    const createdTime = post.created_at.getTime();
    expect(createdTime).toBeGreaterThan(now - 24 * 60 * 60 * 1000); // Within last 24 hours
    expect(createdTime).toBeLessThan(now + 24 * 60 * 60 * 1000); // Not more than 24 hours in future

    // Verify we can compare timestamps
    expect(post.created_at.getTime()).toBeGreaterThan(0);

    // Test that the Date object has the correct methods
    expect(typeof post.created_at.toISOString).toBe("function");
    expect(typeof post.created_at.getTime).toBe("function");
    expect(typeof post.created_at.getTimezoneOffset).toBe("function");

    // Verify the date can be serialized and deserialized
    const isoString = post.created_at.toISOString();
    expect(typeof isoString).toBe("string");
    expect(new Date(isoString).getTime()).toBe(post.created_at.getTime());
  });

  it("should create user and post in same transaction using returned ID", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const queries: CompiledQuery[] = [];

    // Create UOW and create both user and post in same transaction
    const uow = queryEngine.createUnitOfWork("create-user-and-post", {
      onQuery: (query) => queries.push(query),
    });

    // Create user and capture the returned ID
    const userId = uow.create("users", {
      name: "UOW Test User",
      age: 35,
    });

    // Use the returned FragnoId directly to create a post in the same transaction
    // The compiler will extract externalId and generate a subquery to lookup the internal ID
    const postId = uow.create("posts", {
      user_id: userId,
      title: "UOW Test Post",
      content: "This post was created in the same transaction as the user",
    });

    // Execute all mutations in a single transaction
    const { success } = await uow.executeMutations();
    expect(success).toBe(true);

    // Verify both records were created
    const userIdStr = userId.toString();
    const postIdStr = postId.toString();

    const [[user]] = await queryEngine
      .createUnitOfWork("verify-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userIdStr)))
      .executeRetrieve();

    expect(user.name).toBe("UOW Test User");
    expect(user.age).toBe(35);

    const [[post]] = await queryEngine
      .createUnitOfWork("verify-post")
      .find("posts", (b) => b.whereIndex("primary", (eb) => eb("id", "=", postIdStr)))
      .executeRetrieve();

    expect(post.title).toBe("UOW Test Post");
    expect(post.content).toBe("This post was created in the same transaction as the user");

    // Verify the foreign key relationship is correct
    expect(post.user_id.internalId).toBe(user.id.internalId);

    const [insertUserQuery, insertPostQuery] = queries;
    expect(insertUserQuery.sql).toMatchInlineSnapshot(
      `"insert into "namespace"."users" ("id", "name", "age") values ($1, $2, $3) returning "namespace"."users"."id" as "id", "namespace"."users"."name" as "name", "namespace"."users"."age" as "age", "namespace"."users"."_internalId" as "_internalId", "namespace"."users"."_version" as "_version", "namespace"."users"."_shard" as "_shard""`,
    );
    expect(insertUserQuery.parameters).toEqual([userId.externalId, "UOW Test User", 35]);
    expect(insertPostQuery.sql).toMatchInlineSnapshot(
      `"insert into "namespace"."posts" ("id", "user_id", "title", "content") values ($1, (select "_internalId" from "namespace"."users" where "id" = $2 limit $3), $4, $5) returning "namespace"."posts"."id" as "id", "namespace"."posts"."user_id" as "user_id", "namespace"."posts"."title" as "title", "namespace"."posts"."content" as "content", "namespace"."posts"."created_at" as "created_at", "namespace"."posts"."_internalId" as "_internalId", "namespace"."posts"."_version" as "_version", "namespace"."posts"."_shard" as "_shard""`,
    );
    expect(insertPostQuery.parameters).toEqual([
      postId.externalId,
      userId.externalId,
      1,
      "UOW Test Post",
      "This post was created in the same transaction as the user",
    ]);
  });

  it("should support cursor-based pagination with findWithCursor()", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create exactly 15 users for precise pagination testing
    const prefix = "CursorPagTest";

    for (let i = 1; i <= 15; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i.toString().padStart(2, "0")}`,
        age: 20 + i,
      });
    }

    // Fetch first page with cursor (pageSize=10, total=15 items)
    const firstPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    // Check structure and hasNextPage
    expect(firstPage).toHaveProperty("items");
    expect(firstPage).toHaveProperty("cursor");
    expect(firstPage).toHaveProperty("hasNextPage");
    expect(Array.isArray(firstPage.items)).toBe(true);
    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeInstanceOf(Cursor);

    // Fetch second page using cursor (last page with 5 remaining items)
    const secondPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .after(firstPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.hasNextPage).toBe(false);
    expect(secondPage.cursor).toBeUndefined();

    // Verify no overlap - first item of second page should come after last item of first page
    const firstPageLastName = firstPage.items[firstPage.items.length - 1].name;
    const secondPageFirstName = secondPage.items[0].name;
    expect(secondPageFirstName > firstPageLastName).toBe(true);

    // Test empty results
    const emptyPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", "NonExistentPrefix"))
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );
    expect(emptyPage.items).toHaveLength(0);
    expect(emptyPage.hasNextPage).toBe(false);
    expect(emptyPage.cursor).toBeUndefined();
  });

  it("should support findWithCursor() in Unit of Work", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Use findWithCursor in UOW
    const uow = queryEngine
      .createUnitOfWork("cursor-test")
      .findWithCursor("users", (b) =>
        b.whereIndex("name_idx").orderByIndex("name_idx", "asc").pageSize(5),
      );

    const [result] = await uow.executeRetrieve();

    // Verify result structure including hasNextPage
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("cursor");
    expect(result).toHaveProperty("hasNextPage");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(5);
    expect(typeof result.hasNextPage).toBe("boolean");
    expect(result.cursor).toBeInstanceOf(Cursor);
  });

  it("should fail check() when version changes", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create a user
    const createUserUow = queryEngine.createUnitOfWork("create-user-for-version-conflict");
    createUserUow.create("users", {
      name: "Version Conflict User",
      age: 40,
    });
    await createUserUow.executeMutations();

    // Get the user
    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-version-conflict")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Version Conflict User")),
      )
      .executeRetrieve();

    // Update the user to increment their version
    const updateUow = queryEngine.createUnitOfWork("update-user-version");
    updateUow.update("users", user.id, (b) => b.set({ age: 41 }));
    await updateUow.executeMutations();

    // Try to check with the old version (should fail)
    const uow = queryEngine.createUnitOfWork("check-stale-version");
    uow.check("users", user.id); // This has version 0, but the user now has version 1
    uow.create("posts", {
      user_id: user.id,
      title: "Should Not Be Created",
      content: "Content",
      created_at: new Date(),
    });

    const { success } = await uow.executeMutations();
    expect(success).toBe(false);

    // Verify the post was NOT created
    const [posts] = await queryEngine
      .createUnitOfWork("get-posts-for-version-conflict")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", user.id)))
      .executeRetrieve();

    const conflictPosts = posts.filter((p) => p.title === "Should Not Be Created");
    expect(conflictPosts).toHaveLength(0);
  });
});
