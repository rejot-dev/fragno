import { drizzle } from "drizzle-orm/pglite";
import { DrizzleAdapter } from "./drizzle-adapter";
import { assert, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { DBType } from "./shared";
import { createRequire } from "node:module";
import { Cursor } from "../../query/cursor";
import type { DrizzleCompiledQuery } from "./drizzle-uow-compiler";
import { writeAndLoadSchema } from "./test-utils";

// Import drizzle-kit for migrations
const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

describe("DrizzleAdapter PGLite", () => {
  const testSchema = schema((s) => {
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

  let adapter: DrizzleAdapter;
  let db: DBType;

  beforeAll(async () => {
    // Write schema to file and dynamically import it
    const { schemaModule, cleanup } = await writeAndLoadSchema(
      "drizzle-adapter-pglite",
      testSchema,
      "postgresql",
      "namespace",
    );

    // Create Drizzle instance with PGLite (in-memory Postgres)
    db = drizzle({
      schema: schemaModule,
    }) as unknown as DBType;

    // Generate and run migrations
    const migrationStatements = await generateMigration(
      generateDrizzleJson({}), // Empty schema (starting state)
      generateDrizzleJson(schemaModule), // Target schema
    );

    // Execute migration SQL
    for (const statement of migrationStatements) {
      await db.execute(statement);
    }

    adapter = new DrizzleAdapter({
      db: () => db,
      provider: "postgresql",
    });

    expect(await adapter.isConnectionHealthy()).toBe(true);

    return async () => {
      await cleanup();
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
    const queries: DrizzleCompiledQuery[] = [];

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
      `"select "emails_namespace"."id", "emails_namespace"."user_id", "emails_namespace"."email", "emails_namespace"."is_primary", "emails_namespace"."_internalId", "emails_namespace"."_version", "emails_namespace_user"."data" as "user" from "emails_namespace" "emails_namespace" left join lateral (select json_build_array("emails_namespace_user"."name", "emails_namespace_user"."id", "emails_namespace_user"."age", "emails_namespace_user"."_internalId", "emails_namespace_user"."_version") as "data" from (select * from "users_namespace" "emails_namespace_user" where "emails_namespace_user"."_internalId" = "emails_namespace"."user_id" limit $1) "emails_namespace_user") "emails_namespace_user" on true"`,
    );

    expect(email).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      email: "test@example.com",
      is_primary: true,
      user: {
        id: expect.objectContaining({
          externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
          internalId: expect.any(Number),
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
    const queries: DrizzleCompiledQuery[] = [];

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
        internalId: expect.any(Number),
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
      `"select "comments_namespace"."id", "comments_namespace"."post_id", "comments_namespace"."user_id", "comments_namespace"."text", "comments_namespace"."_internalId", "comments_namespace"."_version", "comments_namespace_post"."data" as "post", "comments_namespace_commenter"."data" as "commenter" from "comments_namespace" "comments_namespace" left join lateral (select json_build_array("comments_namespace_post"."id", "comments_namespace_post"."title", "comments_namespace_post"."content", "comments_namespace_post"."_internalId", "comments_namespace_post"."_version", "comments_namespace_post_author"."data") as "data" from (select * from "posts_namespace" "comments_namespace_post" where "comments_namespace_post"."_internalId" = "comments_namespace"."post_id" order by "comments_namespace_post"."id" desc limit $1) "comments_namespace_post" left join lateral (select json_build_array("comments_namespace_post_author"."id", "comments_namespace_post_author"."name", "comments_namespace_post_author"."age", "comments_namespace_post_author"."_internalId", "comments_namespace_post_author"."_version") as "data" from (select * from "users_namespace" "comments_namespace_post_author" where "comments_namespace_post_author"."_internalId" = "comments_namespace_post"."user_id" order by "comments_namespace_post_author"."name" asc limit $2) "comments_namespace_post_author") "comments_namespace_post_author" on true) "comments_namespace_post" on true left join lateral (select json_build_array("comments_namespace_commenter"."id", "comments_namespace_commenter"."name", "comments_namespace_commenter"."_internalId", "comments_namespace_commenter"."_version") as "data" from (select * from "users_namespace" "comments_namespace_commenter" where "comments_namespace_commenter"."_internalId" = "comments_namespace"."user_id" limit $3) "comments_namespace_commenter") "comments_namespace_commenter" on true"`,
    );
  });

  it("should support joins with convenience aliases when relations are also aliased", async () => {
    // This test demonstrates the solution: include BOTH table aliases AND relations aliases
    // in the same schema object. This works around Drizzle's relation resolution bug.
    //
    // The bug: When Drizzle processes a relational query with `.join()`, it looks up
    // tableConfig.relations[relationKey]. If the tableConfig comes from an alias that
    // doesn't have matching relations, it returns undefined and crashes.
    //
    // The fix: For each table alias (e.g., `user`), also add a relations alias
    // (e.g., `userRelations`) pointing to the same relations object.

    const authSchema = schema((s) => {
      return s
        .addTable("user", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .addColumn("passwordHash", column("string"));
        })
        .addTable("session", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("userId", referenceColumn())
            .addColumn("expiresAt", column("timestamp"));
        })
        .addReference("sessionOwner", {
          from: { table: "session", column: "userId" },
          to: { table: "user", column: "id" },
          type: "one",
        });
    });

    // Generate schema with BOTH table aliases AND relations aliases
    const { schemaModule, cleanup } = await writeAndLoadSchema(
      "drizzle-adapter-with-relations-aliases",
      authSchema,
      "postgresql",
      "test-namespace",
    );

    // The schema now includes:
    // - user_test_namespace + user_test_namespaceRelations (physical)
    // - user + userRelations (aliases that point to the same objects)
    const schemaWithAliases = {
      ...schemaModule.test_namespace_schema,
    };

    // Create Drizzle instance
    const db = drizzle({
      schema: schemaWithAliases,
    }) as unknown as DBType;

    // Generate and run migrations
    const require = createRequire(import.meta.url);
    const { generateDrizzleJson, generateMigration } =
      require("drizzle-kit/api") as typeof import("drizzle-kit/api");

    const migrationStatements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schemaModule),
    );

    for (const statement of migrationStatements) {
      await db.execute(statement);
    }

    const adapter = new DrizzleAdapter({
      db: async () => db,
      provider: "postgresql",
    });

    await adapter.isConnectionHealthy();
    const queryEngine = adapter.createQueryEngine(authSchema, "test-namespace");

    // Create a user
    const createUserUow = queryEngine.createUnitOfWork("create-user");
    createUserUow.create("user", {
      email: "test@example.com",
      passwordHash: "hash",
    });
    await createUserUow.executeMutations();

    // Create a session
    const [[user]] = await queryEngine.createUnitOfWork("get-user").find("user").executeRetrieve();

    const createSessionUow = queryEngine.createUnitOfWork("create-session");
    createSessionUow.create("session", {
      userId: user.id,
      expiresAt: new Date("2025-12-31"),
    });
    await createSessionUow.executeMutations();

    // Get session
    const [[session]] = await queryEngine
      .createUnitOfWork("get-session")
      .find("session")
      .executeRetrieve();

    // Find session with join - this works now!
    // The key is that when Drizzle looks up the session's relations,
    // it finds BOTH `sessionOwner` (from session_test_namespaceRelations)
    // AND the same relations via `sessionRelations` (the alias)
    const [[sessionWithUser]] = await queryEngine
      .createUnitOfWork("find-session-with-join")
      .find("session", (b) =>
        b
          .whereIndex("primary", (eb) => eb("id", "=", session.id.valueOf()))
          .join((j) => j.sessionOwner((b) => b.select(["id", "email"]))),
      )
      .executeRetrieve();

    // Verify the join worked
    expect(sessionWithUser).toBeDefined();
    expect(sessionWithUser.sessionOwner).toBeDefined();
    expect(sessionWithUser.sessionOwner?.email).toBe("test@example.com");

    await cleanup();
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
    const queries: DrizzleCompiledQuery[] = [];

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
      `"insert into "users_namespace" ("id", "name", "age", "_internalId", "_version") values ($1, $2, $3, default, default)"`,
    );
    expect(insertUserQuery.params).toEqual([userId.externalId, "UOW Test User", 35]);
    expect(insertPostQuery.sql).toMatchInlineSnapshot(
      `"insert into "posts_namespace" ("id", "user_id", "title", "content", "created_at", "_internalId", "_version") values ($1, (select "_internalId" from "users_namespace" where "id" = $2 limit 1), $3, $4, default, default, default)"`,
    );
    expect(insertPostQuery.params).toEqual([
      postId.externalId,
      userId.externalId,
      "UOW Test Post",
      "This post was created in the same transaction as the user",
    ]);
  });

  it("should support cursor-based pagination with findWithCursor()", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create multiple users for pagination testing
    for (let i = 1; i <= 25; i++) {
      await queryEngine.create("users", {
        name: `Cursor User ${i.toString().padStart(2, "0")}`,
        age: 20 + i,
      });
    }

    // Fetch first page with cursor
    const firstPage = await queryEngine.findWithCursor("users", (b) =>
      b.whereIndex("name_idx").orderByIndex("name_idx", "asc").pageSize(10),
    );

    // Check structure
    expect(firstPage).toHaveProperty("items");
    expect(firstPage).toHaveProperty("cursor");
    expect(Array.isArray(firstPage.items)).toBe(true);
    expect(firstPage.items.length).toBeGreaterThan(0);
    expect(firstPage.items.length).toBeLessThanOrEqual(10);

    assert(firstPage.cursor instanceof Cursor);
    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.cursor).toBeInstanceOf(Cursor);

    // Fetch second page using cursor
    const secondPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx")
        .after(firstPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    expect(secondPage.items.length).toBeGreaterThan(0);
    expect(secondPage.items.length).toBeLessThanOrEqual(10);

    // Verify no overlap - first item of second page should come after last item of first page
    const firstPageLastName = firstPage.items[firstPage.items.length - 1].name;
    const secondPageFirstName = secondPage.items[0].name;
    expect(secondPageFirstName > firstPageLastName).toBe(true);
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

    // Verify result structure
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("cursor");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(5);
    expect(result.cursor).toBeInstanceOf(Cursor);
  });
});
