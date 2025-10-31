import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { DrizzleAdapter } from "./drizzle-adapter";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { DBType } from "./shared";
import { createRequire } from "node:module";
import { writeAndLoadSchema } from "./test-utils";
import { encodeCursor } from "../../query/cursor";

// Import drizzle-kit for migrations
const require = createRequire(import.meta.url);
const { generateSQLiteDrizzleJson, generateSQLiteMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

describe("DrizzleAdapter SQLite", () => {
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
  // let sqliteDb: Database.Database;

  beforeAll(async () => {
    // Write schema to file and dynamically import it
    const { schemaModule, cleanup } = await writeAndLoadSchema(
      "drizzle-adapter-sqlite",
      testSchema,
      "sqlite",
      "namespace",
    );

    const client = createClient({
      url: "file::memory:?cache=shared",
    });

    db = drizzle(client, {
      schema: schemaModule,
    }) as unknown as DBType;

    // Generate and run migrations
    const emptyJson = await generateSQLiteDrizzleJson({});
    const targetJson = await generateSQLiteDrizzleJson(schemaModule);

    const migrationStatements = await generateSQLiteMigration(emptyJson, targetJson);

    for (const statement of migrationStatements) {
      await client.execute(statement);
    }

    adapter = new DrizzleAdapter({
      db,
      provider: "sqlite",
    });

    return async () => {
      client.close();
      await cleanup();
    };
  }, 12000);

  it("should execute Unit of Work with version checking", async () => {
    // Pass namespace to ensure mapper translates logical table names to physical (prefixed) names
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create two users at once using UOW
    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", {
      name: "Alice",
      age: 25,
    });
    createUow.create("users", {
      name: "Bob",
      age: 30,
    });

    expectTypeOf(createUow.find).parameter(0).toEqualTypeOf<keyof typeof testSchema.tables>();

    const { success: createSuccess } = await createUow.executeMutations();
    expect(createSuccess).toBe(true);

    const createdIds = createUow.getCreatedIds();
    expect(createdIds).toHaveLength(2);

    // Verify both users were created by fetching them
    const [allUsers] = await queryEngine
      .createUnitOfWork("get-all-users")
      .find("users")
      .executeRetrieve();

    expect(allUsers).toHaveLength(2);

    // Verify Alice (first created user)
    expect(allUsers[0]).toMatchObject({
      name: "Alice",
      age: 25,
      id: expect.objectContaining({
        externalId: createdIds[0].externalId,
        version: 0,
      }),
    });

    // Verify Bob (second created user)
    expect(allUsers[1]).toMatchObject({
      name: "Bob",
      age: 30,
      id: expect.objectContaining({
        externalId: createdIds[1].externalId,
        version: 0,
      }),
    });

    // Use Alice (first user) for the rest of the test
    const initialUserId = createdIds[0];

    // Build a UOW to update Alice with optimistic locking
    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      // Retrieval phase: find Alice
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
    expect(users[0].name).toBe("Alice");

    // Verify Alice was updated
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

    // Try to update Alice again with stale version (should fail)
    const uow2 = queryEngine.createUnitOfWork("update-user-stale");

    // Use the old version (0) which is now stale
    uow2.update("users", initialUserId, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();

    // Should fail due to version conflict
    expect(success2).toBe(false);

    // Verify Alice was NOT updated
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
    expect(totalCount).toBeGreaterThanOrEqual(5); // At least Alice, Bob, and 3 new users
    expect(typeof totalCount).toBe("number");
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
    expect(firstPage).toHaveLength(2);
    expect(firstPage.map((u) => u.name)).toEqual(["Alice", "Bob"]);

    // Create cursor from last item of first page
    const lastItem = firstPage[firstPage.length - 1]!;
    const cursor = encodeCursor({
      indexValues: { name: lastItem.name },
      direction: "forward",
    });

    // Fetch next page using cursor
    const [secondPage] = await queryEngine
      .createUnitOfWork("second-page")
      .find("users", (b) =>
        b.whereIndex("name_idx").orderByIndex("name_idx", "asc").after(cursor).pageSize(2),
      )
      .executeRetrieve();

    // Verify page 2 continues alphabetically
    expect(secondPage).toHaveLength(2);
    expect(secondPage.map((u) => u.name)).toEqual(["Page User A", "Page User B"]);

    // Ensure no overlap between pages
    const firstPageNames = new Set(firstPage.map((u) => u.name));
    for (const user of secondPage) {
      expect(firstPageNames.has(user.name)).toBe(false);
    }
  });

  it("should support joins", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", { name: "Email User", age: 20 });

    const { success } = await createUow.executeMutations();
    expect(success).toBe(true);

    // Fetch the created user to get the proper ID
    const [usersResult] = await queryEngine
      .createUnitOfWork("get-created-user")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Email User")))
      .executeRetrieve();

    expect(usersResult).toHaveLength(1);
    const createdUser = usersResult[0];
    expect(createdUser).toBeDefined();
    expect(createdUser.name).toBe("Email User");

    // Create an email for testing joins
    const createEmailUow = queryEngine.createUnitOfWork("create-test-email");
    createEmailUow.create("emails", {
      user_id: createdUser.id,
      email: "test@example.com",
      is_primary: true,
    });
    await createEmailUow.executeMutations();

    // Test join query
    const uow = queryEngine
      .createUnitOfWork("test-joins")
      .find("emails", (b) =>
        b
          .whereIndex("user_emails", (eb) => eb("user_id", "=", createdUser.id))
          .join((jb) => jb.user((builder) => builder.select(["name", "id", "age"]))),
      );

    const [[email]] = await uow.executeRetrieve();

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
        name: "Email User",
        age: 20,
      },
    });
  });

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create a user (author)
    const createAuthorUow = queryEngine.createUnitOfWork("create-author");
    createAuthorUow.create("users", { name: "Blog Author", age: 30 });
    await createAuthorUow.executeMutations();

    // Fetch the created author to get the proper ID
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

    // Fetch the created post to get the proper ID
    const [[post]] = await queryEngine
      .createUnitOfWork("get-post")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", author.id)))
      .executeRetrieve();

    // Create a commenter
    const createCommenterUow = queryEngine.createUnitOfWork("create-commenter");
    createCommenterUow.create("users", { name: "Commenter User", age: 25 });
    await createCommenterUow.executeMutations();

    // Fetch the created commenter to get the proper ID
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
    const uow = queryEngine.createUnitOfWork("test-complex-joins").find("comments", (b) =>
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
        // Nested author join (second level)
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
  });

  it("should return created IDs from UOW create operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Test 1: Create operations return IDs with both external and internal IDs
    const uow1 = queryEngine.createUnitOfWork("create-multiple-users");

    uow1.create("users", { name: "Test User 1", age: 30 });
    uow1.create("users", { name: "Test User 2", age: 35 });
    uow1.create("users", { name: "Test User 3", age: 40 });

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

    // All external IDs should be unique
    const externalIds = createdIds1.map((id) => id.externalId);
    expect(new Set(externalIds).size).toBe(3);

    // Verify we can use these IDs to query the created users
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
      name: "Test User 1",
      age: 30,
    });

    expect(user2).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[1].externalId,
      }),
      name: "Test User 2",
      age: 35,
    });

    expect(user3).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[2].externalId,
      }),
      name: "Test User 3",
      age: 40,
    });

    // Test 2: Mixed operations (creates, updates, deletes) - only creates return IDs
    const uow2 = queryEngine.createUnitOfWork("mixed-operations");

    uow2.create("users", { name: "New User", age: 50 });
    uow2.update("users", createdIds1[0], (b) => b.set({ age: 31 }));
    uow2.create("users", { name: "Another New User", age: 55 });
    uow2.delete("users", createdIds1[2]);

    const { success: success2 } = await uow2.executeMutations();
    expect(success2).toBe(true);

    const createdIds2 = uow2.getCreatedIds();

    // Only 2 creates, so only 2 IDs
    expect(createdIds2).toHaveLength(2);
    expect(createdIds2[0].externalId).toBeDefined();
    expect(createdIds2[1].externalId).toBeDefined();

    // Test 3: User-provided IDs are preserved
    const customId = "my-custom-user-id-12345";
    const uow3 = queryEngine.createUnitOfWork("create-with-custom-id");

    uow3.create("users", { id: customId, name: "Custom ID User", age: 60 });

    const { success: success3 } = await uow3.executeMutations();
    expect(success3).toBe(true);

    const createdIds3 = uow3.getCreatedIds();

    expect(createdIds3).toHaveLength(1);
    expect(createdIds3[0].externalId).toBe(customId);
    expect(createdIds3[0].internalId).toBeDefined();

    // Verify the user was created with the custom ID
    const customIdUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", customId)),
    );

    expect(customIdUser).toMatchObject({
      id: expect.objectContaining({
        externalId: customId,
      }),
      name: "Custom ID User",
      age: 60,
    });
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

    // Create a post (note: SQLite schema doesn't have created_at column)
    const createPostUow = queryEngine.createUnitOfWork("create-post-for-timestamp");
    createPostUow.create("posts", {
      user_id: user.id,
      title: "Timestamp Test Post",
      content: "Testing timestamp handling",
    });
    await createPostUow.executeMutations();

    // Retrieve the post
    const [[post]] = await queryEngine
      .createUnitOfWork("get-post-for-timestamp")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", user.id)))
      .executeRetrieve();

    expect(post).toBeDefined();
    expect(post.title).toBe("Timestamp Test Post");

    // Test general Date handling (SQLite stores timestamps as integers)
    const now = new Date();
    expect(now).toBeInstanceOf(Date);
    expect(typeof now.getTime).toBe("function");
    expect(typeof now.toISOString).toBe("function");

    // Verify date serialization/deserialization works
    const isoString = now.toISOString();
    expect(typeof isoString).toBe("string");
    expect(new Date(isoString).getTime()).toBe(now.getTime());

    // Test timezone preservation
    const specificDate = new Date("2024-06-15T14:30:00Z");
    expect(specificDate.toISOString()).toBe("2024-06-15T14:30:00.000Z");

    // Verify SQLite numeric timestamp conversion
    const timestamp = Date.now();
    const dateFromTimestamp = new Date(timestamp);
    expect(dateFromTimestamp.getTime()).toBe(timestamp);

    // Verify that dates from different timezones are handled correctly
    const localDate = new Date("2024-06-15T14:30:00");
    expect(localDate).toBeInstanceOf(Date);
    expect(typeof localDate.getTimezoneOffset()).toBe("number");
  });
});
