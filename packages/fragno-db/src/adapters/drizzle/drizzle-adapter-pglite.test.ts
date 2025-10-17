import { drizzle } from "drizzle-orm/pglite";
import { DrizzleAdapter } from "./drizzle-adapter";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { DBType } from "./shared";
import { createRequire } from "node:module";
import { encodeCursor } from "../../query/cursor";
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
      db,
      provider: "postgresql",
    });

    return async () => {
      await cleanup();
    };
  }, 12000);

  it("should execute Unit of Work with version checking", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create initial user using UOW
    const createUow = queryEngine.createUnitOfWork("create-user").create("users", {
      name: "Alice",
      age: 25,
    });

    expectTypeOf(createUow.find).parameter(0).toEqualTypeOf<keyof typeof testSchema.tables>();

    const { success: createSuccess } = await createUow.executeMutations();
    expect(createSuccess).toBe(true);

    // Fetch the created user to get its ID
    const [[initialUser]] = await queryEngine
      .createUnitOfWork("get-created-user")
      .find("users", (b) => b.whereIndex("primary"))
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
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create some users
    await queryEngine
      .createUnitOfWork("create-users")
      .create("users", { name: "User1", age: 20 })
      .create("users", { name: "User2", age: 30 })
      .create("users", { name: "User3", age: 40 })
      .executeMutations();

    // Count all users
    const [totalCount] = await queryEngine
      .createUnitOfWork("count-all")
      .find("users", (b) => b.whereIndex("primary").selectCount())
      .executeRetrieve();

    // Tests are not isolated, so we can't use expect(totalCount).toBe(3)
    expect(totalCount).toBeGreaterThanOrEqual(3);
  });

  it("should support cursor-based pagination", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    const createUow = queryEngine
      .createUnitOfWork("create-users")
      .create("users", { name: "Page User A", age: 20 })
      .create("users", { name: "Page User B", age: 30 })
      .create("users", { name: "Page User C", age: 40 })
      .create("users", { name: "Page User D", age: 50 })
      .create("users", { name: "Page User E", age: 60 });

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
    expect(secondPage.map((u) => u.name)).toEqual(["Page User B", "Page User C"]);

    // Ensure no overlap between pages
    const firstPageNames = new Set(firstPage.map((u) => u.name));
    for (const user of secondPage) {
      expect(firstPageNames.has(user.name)).toBe(false);
    }
  });

  it("should support joins", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");
    const queries: DrizzleCompiledQuery[] = [];

    const createUow = queryEngine
      .createUnitOfWork("create-users")
      .create("users", { name: "Email User", age: 20 });

    await createUow.executeMutations();

    // Get an existing user to create an email for
    const [[existingUser]] = await queryEngine
      .createUnitOfWork("get-existing-user")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Email User")))
      .executeRetrieve();

    // Create an email for testing joins
    const createEmailUow = queryEngine.createUnitOfWork("create-test-email").create("emails", {
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
      `"select "emails"."id", "emails"."user_id", "emails"."email", "emails"."is_primary", "emails"."_internalId", "emails"."_version", "emails_user"."data" as "user" from "emails" "emails" left join lateral (select json_build_array("emails_user"."name", "emails_user"."id", "emails_user"."age", "emails_user"."_internalId", "emails_user"."_version") as "data" from (select * from "users" "emails_user" where "emails_user"."_internalId" = "emails"."user_id" limit $1) "emails_user") "emails_user" on true"`,
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

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");
    const queries: DrizzleCompiledQuery[] = [];

    // Create a user (author)
    const createAuthorUow = queryEngine
      .createUnitOfWork("create-author")
      .create("users", { name: "Blog Author", age: 30 });
    await createAuthorUow.executeMutations();

    // Get the author
    const [[author]] = await queryEngine
      .createUnitOfWork("get-author")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Blog Author")))
      .executeRetrieve();

    // Create a post by the author
    const createPostUow = queryEngine.createUnitOfWork("create-post").create("posts", {
      user_id: author.id,
      title: "My First Post",
      content: "This is the content of my first post",
    });
    await createPostUow.executeMutations();

    // Get the post
    const [[post]] = await queryEngine
      .createUnitOfWork("get-post")
      .find("posts", (b) => b.whereIndex("primary"))
      .executeRetrieve();

    // Create a commenter
    const createCommenterUow = queryEngine
      .createUnitOfWork("create-commenter")
      .create("users", { name: "Commenter User", age: 25 });
    await createCommenterUow.executeMutations();

    // Get the commenter
    const [[commenter]] = await queryEngine
      .createUnitOfWork("get-commenter")
      .find("users", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "Commenter User")))
      .executeRetrieve();

    // Create a comment on the post
    const createCommentUow = queryEngine.createUnitOfWork("create-comment").create("comments", {
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
      `"select "comments"."id", "comments"."post_id", "comments"."user_id", "comments"."text", "comments"."_internalId", "comments"."_version", "comments_post"."data" as "post", "comments_commenter"."data" as "commenter" from "comments" "comments" left join lateral (select json_build_array("comments_post"."id", "comments_post"."title", "comments_post"."content", "comments_post"."_internalId", "comments_post"."_version", "comments_post_author"."data") as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."post_id" order by "comments_post"."id" desc limit $1) "comments_post" left join lateral (select json_build_array("comments_post_author"."id", "comments_post_author"."name", "comments_post_author"."age", "comments_post_author"."_internalId", "comments_post_author"."_version") as "data" from (select * from "users" "comments_post_author" where "comments_post_author"."_internalId" = "comments_post"."user_id" order by "comments_post_author"."name" asc limit $2) "comments_post_author") "comments_post_author" on true) "comments_post" on true left join lateral (select json_build_array("comments_commenter"."id", "comments_commenter"."name", "comments_commenter"."_internalId", "comments_commenter"."_version") as "data" from (select * from "users" "comments_commenter" where "comments_commenter"."_internalId" = "comments"."user_id" limit $3) "comments_commenter") "comments_commenter" on true"`,
    );
  });
});
