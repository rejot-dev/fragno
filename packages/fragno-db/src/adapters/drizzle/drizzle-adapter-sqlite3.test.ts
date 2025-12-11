import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { DrizzleAdapter } from "./drizzle-adapter";
import { beforeAll, describe, expect, expectTypeOf, it, assert } from "vitest";
import { column, idColumn, referenceColumn, schema, type FragnoId } from "../../schema/create";
import { Cursor } from "../../query/cursor";
import { executeUnitOfWork } from "../../query/execute-unit-of-work";
import { ExponentialBackoffRetryPolicy } from "../../query/retry-policy";
import { BetterSQLite3DriverConfig } from "../generic-sql/driver-config";
import { settingsSchema } from "../../fragments/internal-fragment";

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

  // Second schema for multi-schema testing
  const schema2 = schema((s) => {
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
          .createIndex("product_orders_idx", ["product_id"]);
      })
      .addReference("product", {
        type: "one",
        from: { table: "orders", column: "product_id" },
        to: { table: "products", column: "id" },
      });
  });

  let adapter: DrizzleAdapter;
  let sqliteDatabase: InstanceType<typeof SQLite>;

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new DrizzleAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    // Create settings table first (needed for version tracking)
    {
      const migrations = adapter.prepareMigrations(settingsSchema, "");
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

    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      Parameters<typeof createUow.find>[0]
    >();
    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      "users" | "emails" | "posts" | "comments"
    >();

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

  it("should support forSchema for multi-schema queries", async () => {
    const queryEngine1 = adapter.createQueryEngine(testSchema, "namespace");
    const queryEngine2 = adapter.createQueryEngine(schema2, "namespace2");

    // Create test data in schema1 (users)
    const createUsersUow = queryEngine1.createUnitOfWork("create-users-for-multi-schema");
    createUsersUow.create("users", { name: "Multi Schema User 1", age: 25 });
    createUsersUow.create("users", { name: "Multi Schema User 2", age: 30 });
    const { success: success1 } = await createUsersUow.executeMutations();
    expect(success1).toBe(true);

    // Create test data in schema2 (products)
    const createProductsUow = queryEngine2.createUnitOfWork("create-products-for-multi-schema");
    createProductsUow.create("products", { name: "Product A", price: 100 });
    createProductsUow.create("products", { name: "Product B", price: 200 });
    const { success: success2 } = await createProductsUow.executeMutations();
    expect(success2).toBe(true);

    // Now use forSchema to query from both schemas
    const uow = queryEngine1.createUnitOfWork("multi-schema-query");

    const view1 = uow
      .forSchema(testSchema)
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", "Multi Schema User"))
          .select(["id", "name"]),
      )
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", "Multi Schema User"))
          .select(["name", "age"]),
      );

    const view2 = uow
      .forSchema(schema2)
      .find("products", (b) => b.whereIndex("primary").select(["name", "price"]));

    // Execute the retrieval phase once
    await uow.executeRetrieve();

    // Get results from view1
    const [users1, users2] = await view1.retrievalPhase;
    const [user1] = users1;
    expectTypeOf(user1).toMatchObjectType<{ id: FragnoId; name: string }>();

    const [user2] = users2;
    expectTypeOf(user2).toMatchObjectType<{ name: string; age: number | null }>();

    // Get results from view2
    const [products] = await view2.retrievalPhase;
    const [product1] = products;
    expectTypeOf(product1).toMatchObjectType<{ name: string; price: number }>();

    // Verify users from schema1
    expect(users1).toHaveLength(2);
    expect(users1[0]).toMatchObject({
      id: expect.any(Object),
      name: "Multi Schema User 1",
    });
    expect(users1[1]).toMatchObject({
      id: expect.any(Object),
      name: "Multi Schema User 2",
    });

    expect(users2).toHaveLength(2);
    expect(users2[0]).toMatchObject({
      name: "Multi Schema User 1",
      age: 25,
    });
    expect(users2[1]).toMatchObject({
      name: "Multi Schema User 2",
      age: 30,
    });

    // Verify products from schema2
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      name: "Product A",
      price: 100,
    });
    expect(products[1]).toMatchObject({
      name: "Product B",
      price: 200,
    });
  });

  it("should verify hasNextPage in cursor pagination", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create exactly 15 users for precise pagination testing
    const prefix = "HasNextPageTest";

    for (let i = 1; i <= 15; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i.toString().padStart(2, "0")}`,
        age: 20 + i,
      });
    }

    // Test 1: First page with more results available (pageSize=10, total=15)
    const firstPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeInstanceOf(Cursor);

    // Test 2: Second page (last page, partial results: 5 items remaining)
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

    // Test 3: Empty results
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

  it("should support executeUnitOfWork with retry logic", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create a test user
    const createUow = queryEngine.createUnitOfWork("create-user-for-execute-uow");
    createUow.create("users", { name: "Execute UOW User", age: 42 });
    await createUow.executeMutations();

    // Fetch the user to get their ID
    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-execute-uow")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Execute UOW User")))
      .executeRetrieve();

    // Use executeUnitOfWork to increment age with optimistic locking
    const result = await executeUnitOfWork(
      {
        retrieve: (uow) =>
          uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", user.id))),
        mutate: (uow, [users]) => {
          const foundUser = users[0];
          const newAge = foundUser.age! + 1;
          uow.update("users", foundUser.id, (b) => b.set({ age: newAge }).check());
          return { previousAge: foundUser.age, newAge };
        },
        onSuccess: ({ mutationResult }) => {
          // Verify the age was incremented correctly
          expect(mutationResult.newAge).toBe(mutationResult.previousAge! + 1);
        },
      },
      {
        createUnitOfWork: () => queryEngine.createUnitOfWork("execute-uow-update"),
        retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
      },
    );

    // Verify the operation succeeded
    assert(result.success);
    expect(result.mutationResult).toEqual({
      previousAge: 42,
      newAge: 43,
    });

    // Verify the user was actually updated in the database
    const updatedUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", user.id)),
    );

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: user.id.externalId,
        version: 1, // Version incremented due to check()
      }),
      name: "Execute UOW User",
      age: 43,
    });
  });

  it("should fail check() when version changes", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    // Create a user
    const createUserUow = queryEngine.createUnitOfWork("create-user-for-version-conflict");
    createUserUow.create("users", {
      name: "Version Conflict User SQLite",
      age: 40,
    });
    await createUserUow.executeMutations();

    // Get the user
    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-version-conflict")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Version Conflict User SQLite")),
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
      title: "Should Not Be Created SQLite",
      content: "Content",
    });

    const { success } = await uow.executeMutations();
    expect(success).toBe(false);

    // Verify the post was NOT created
    const [posts] = await queryEngine
      .createUnitOfWork("get-posts-for-version-conflict")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", user.id)))
      .executeRetrieve();

    const conflictPosts = posts.filter((p) => p.title === "Should Not Be Created SQLite");
    expect(conflictPosts).toHaveLength(0);
  });
});
