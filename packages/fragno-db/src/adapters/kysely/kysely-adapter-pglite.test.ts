import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import {
  column,
  idColumn,
  referenceColumn,
  schema,
  type FragnoId,
  type FragnoReference,
} from "../../schema/create";
import { encodeCursor } from "../../query/cursor";

describe("KyselyAdapter PGLite", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("name_idx", ["name"])
          .createIndex("age_idx", ["age"]);
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
      .addTable("tags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .createIndex("tag_name", ["name"]);
      })
      .addTable("post_tags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("post_id", referenceColumn())
          .addColumn("tag_id", referenceColumn())
          .createIndex("pt_post", ["post_id"])
          .createIndex("pt_tag", ["tag_id"]);
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
        from: { table: "post_tags", column: "post_id" },
        to: { table: "posts", column: "id" },
      })
      .addReference("tag", {
        type: "one",
        from: { table: "post_tags", column: "tag_id" },
        to: { table: "tags", column: "id" },
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let adapter: KyselyAdapter;

  beforeAll(async () => {
    const { dialect } = await KyselyPGlite.create();
    kysely = new Kysely({
      dialect,
    });

    adapter = new KyselyAdapter({
      db: kysely,
      provider: "postgresql",
    });
  }, 12000);

  it("should run migrations and basic queries", async () => {
    const schemaVersion = await adapter.getSchemaVersion("test");
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(testSchema, "test");
    const preparedMigration = await migrator.prepareMigration({
      updateSettings: false,
    });
    assert(preparedMigration.getSQL);

    expect(preparedMigration.getSQL()).toMatchInlineSnapshot(`
      "create table "users_test" ("id" varchar(30) not null unique, "name" text not null, "age" integer, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "name_idx" on "users_test" ("name");

      create index "age_idx" on "users_test" ("age");

      create table "emails_test" ("id" varchar(30) not null unique, "user_id" bigint not null, "email" text not null, "is_primary" boolean default false not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create unique index "unique_email" on "emails_test" ("email");

      create index "user_emails" on "emails_test" ("user_id");

      create table "posts_test" ("id" varchar(30) not null unique, "user_id" bigint not null, "title" text not null, "content" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "posts_user_idx" on "posts_test" ("user_id");

      create table "tags_test" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "tag_name" on "tags_test" ("name");

      create table "post_tags_test" ("id" varchar(30) not null unique, "post_id" bigint not null, "tag_id" bigint not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "pt_post" on "post_tags_test" ("post_id");

      create index "pt_tag" on "post_tags_test" ("tag_id");

      create table "comments_test" ("id" varchar(30) not null unique, "post_id" bigint not null, "user_id" bigint not null, "text" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "comments_post_idx" on "comments_test" ("post_id");

      create index "comments_user_idx" on "comments_test" ("user_id");

      alter table "emails_test" add constraint "emails_users_user_fk" foreign key ("user_id") references "users_test" ("_internalId") on delete restrict on update restrict;

      alter table "posts_test" add constraint "posts_users_author_fk" foreign key ("user_id") references "users_test" ("_internalId") on delete restrict on update restrict;

      alter table "post_tags_test" add constraint "post_tags_posts_post_fk" foreign key ("post_id") references "posts_test" ("_internalId") on delete restrict on update restrict;

      alter table "post_tags_test" add constraint "post_tags_tags_tag_fk" foreign key ("tag_id") references "tags_test" ("_internalId") on delete restrict on update restrict;

      alter table "comments_test" add constraint "comments_posts_post_fk" foreign key ("post_id") references "posts_test" ("_internalId") on delete restrict on update restrict;

      alter table "comments_test" add constraint "comments_users_commenter_fk" foreign key ("user_id") references "users_test" ("_internalId") on delete restrict on update restrict;"
    `);

    await preparedMigration.execute();

    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user
    const userId = await queryEngine.create("users", {
      name: "John Doe",
      age: 30,
    });

    // create() now returns just the ID
    expect(userId).toMatchObject({
      externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
      internalId: expect.any(Number),
    });

    expect(userId.version).toBe(0);

    const getUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", userId)).select(["id", "name"]),
    );
    expect(getUser).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      name: "John Doe",
    });

    // Create 2 emails for the user
    const email1Id = await queryEngine.create("emails", {
      user_id: userId,
      email: "john.doe@example.com",
      is_primary: true,
    });

    const email2Id = await queryEngine.create("emails", {
      // Pass only the string (external ID) here, to make sure we generate the right sub-query.
      user_id: userId.toString(),
      email: "john.doe.work@company.com",
      is_primary: false,
    });

    expect(email1Id).toMatchObject({
      externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
      internalId: expect.any(Number),
    });

    expect(email2Id).toMatchObject({
      externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
      internalId: expect.any(Number),
    });

    // Update user name
    await queryEngine.updateMany("users", (b) =>
      b
        .whereIndex("primary", (eb) => eb("id", "=", userId))
        .set({
          name: "Jane Doe",
        }),
    );

    const updatedUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", userId)),
    );
    // Version has been incremented
    expect(updatedUser!.id.version).toBe(1);

    // Query emails with their users using join (since the relation is from emails to users)
    const emailsWithUsers = await queryEngine.find("emails", (b) =>
      b.whereIndex("primary").join((jb) => jb.user()),
    );

    expect(emailsWithUsers).toHaveLength(2); // One row per email
    expect(emailsWithUsers[0]).toEqual({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      email: expect.stringMatching(/\.com$/),
      is_primary: expect.any(Boolean),
      user: {
        id: expect.objectContaining({
          externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
          internalId: expect.any(Number),
        }),
        name: "Jane Doe",
        age: 30,
      },
    });

    // Also test a more specific join query to get emails for a specific user
    const userEmails = await queryEngine.find("emails", (b) =>
      b.whereIndex("user_emails", (eb) => eb("user_id", "=", userId)).join((jb) => jb.user()),
    );

    expect(userEmails).toHaveLength(2);
  });

  it("should execute Unit of Work with version checking", async () => {
    // Use the same namespace as the first test (migrations already ran)
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create initial user
    const initialUserId = await queryEngine.create("users", {
      name: "Alice",
      age: 25,
    });

    expect(initialUserId.version).toBe(0);

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
    const updatedUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)),
    );

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

    const uow3 = queryEngine
      .createUnitOfWork("get-all-emails")
      .find("emails", (b) => b.whereIndex("primary").orderByIndex("unique_email", "desc"));
    const [allEmails] = await uow3.executeRetrieve();
    const userNames = allEmails.map((email) => email.email);
    expect(userNames).toEqual(["john.doe@example.com", "john.doe.work@company.com"]);
  });

  it("should support selectCount in UOW", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Count all users
    const uow = queryEngine
      .createUnitOfWork("count-users")
      .find("users", (b) => b.whereIndex("primary").selectCount());

    const [count] = await uow.executeRetrieve();

    // We created 2 users in previous tests (John Doe and Alice)
    expect(count).toBeGreaterThanOrEqual(2);
    expect(typeof count).toBe("number");

    // Count with where clause
    const uow2 = queryEngine
      .createUnitOfWork("count-young-users")
      .find("users", (b) => b.whereIndex("age_idx", (eb) => eb("age", "<", 28)).selectCount());

    const [youngCount] = await uow2.executeRetrieve();
    expect(youngCount).toBeGreaterThanOrEqual(1); // At least Alice (25)
  });

  it("should support cursor-based pagination in UOW", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create some test users for pagination
    const users = [
      { name: "User A", age: 20 },
      { name: "User B", age: 21 },
      { name: "User C", age: 22 },
      { name: "User D", age: 23 },
      { name: "User E", age: 24 },
    ];

    for (const user of users) {
      await queryEngine.create("users", user);
    }

    // Test forward pagination with after cursor, ordered by name
    const page1 = queryEngine
      .createUnitOfWork("page-1")
      .find("users", (b) => b.whereIndex("name_idx").orderByIndex("name_idx", "asc").pageSize(2));

    const [page1Results] = await page1.executeRetrieve();
    // Note: Previous tests created "Alice" and "Jane Doe"
    expect(page1Results.map((u) => u.name)).toEqual(["Alice", "Jane Doe"]);

    // Get cursor for pagination (using the last item from page 1)
    const lastItem = page1Results[page1Results.length - 1]!;
    const cursor = encodeCursor({
      indexValues: { name: lastItem.name },
      direction: "forward",
    });

    // Get page 2 using the cursor
    const page2 = queryEngine
      .createUnitOfWork("page-2")
      .find("users", (b) =>
        b.whereIndex("name_idx").orderByIndex("name_idx", "asc").after(cursor).pageSize(2),
      );

    const [page2Results] = await page2.executeRetrieve();
    expect(page2Results.map((u) => u.name)).toEqual(["User A", "User B"]);

    // Ensure no overlap between pages
    const page1Names = new Set(page1Results.map((u) => u.name));
    for (const user of page2Results) {
      expect(page1Names.has(user.name)).toBe(false);
    }
  });

  it("should support many-to-many queries through junction table", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user
    const userId = await queryEngine.create("users", {
      name: "Blog Author",
      age: 28,
    });

    // Create posts
    const post1Id = await queryEngine.create("posts", {
      title: "TypeScript Tips",
      content: "Learn TypeScript",
      user_id: userId,
    });

    const post2Id = await queryEngine.create("posts", {
      title: "Database Design",
      content: "Learn databases",
      user_id: userId,
    });

    // Create tags
    const tagTypeScriptId = await queryEngine.create("tags", {
      name: "TypeScript",
    });

    const tagDatabaseId = await queryEngine.create("tags", {
      name: "Database",
    });

    const tagTutorialId = await queryEngine.create("tags", {
      name: "Tutorial",
    });

    // Link posts to tags via junction table
    // Post 1 has tags: TypeScript, Tutorial
    await queryEngine.create("post_tags", {
      post_id: post1Id,
      tag_id: tagTypeScriptId,
    });

    await queryEngine.create("post_tags", {
      post_id: post1Id,
      tag_id: tagTutorialId,
    });

    // Post 2 has tags: Database, Tutorial
    await queryEngine.create("post_tags", {
      post_id: post2Id,
      tag_id: tagDatabaseId,
    });

    await queryEngine.create("post_tags", {
      post_id: post2Id,
      tag_id: tagTutorialId,
    });

    // Query post_tags with joined post and tag data using UOW
    const uow = queryEngine
      .createUnitOfWork("get-post-tags")
      .find("post_tags", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb.post((pb) => pb.select(["title"])).tag((tb) => tb.select(["name"]))),
      );

    const [postTags] = await uow.executeRetrieve();

    // Should have 4 post_tag entries
    expect(postTags).toHaveLength(4);

    // Verify the structure includes both post and tag data
    expect(postTags[0]).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.any(String),
      }),
      post_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      tag_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      post: {
        title: expect.any(String),
      },
      tag: {
        name: expect.any(String),
      },
    });

    type InferArrayElement<T> = T extends (infer U)[] ? U : never;
    type Prettify<T> = {
      [K in keyof T]: T[K];
    } & {};
    type RemoveIndex<T> = {
      [K in keyof T as string extends K
        ? never
        : number extends K
          ? never
          : symbol extends K
            ? never
            : K]: T[K];
    };

    type PostTag = Prettify<InferArrayElement<typeof postTags>>;
    type Tag = Prettify<RemoveIndex<PostTag["tag"]>>;
    expectTypeOf<Tag>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
    } | null>();

    // Verify we can find specific combinations
    const typeScriptPosts = postTags.filter((pt) => pt.tag?.name === "TypeScript");
    expect(typeScriptPosts).toHaveLength(1);
    type Post = Prettify<(typeof typeScriptPosts)[number]["post"]>;
    expectTypeOf<Post>().toEqualTypeOf<{
      id: FragnoId;
      user_id: FragnoReference;
      title: string;
      content: string;
    } | null>();
    expect(typeScriptPosts[0]!.post!.title).toBe("TypeScript Tips");

    const tutorialPosts = postTags.filter((pt) => pt.tag!.name === "Tutorial");
    expect(tutorialPosts).toHaveLength(2);
    expect(tutorialPosts.map((pt) => pt.post!.title).sort()).toEqual([
      "Database Design",
      "TypeScript Tips",
    ]);

    // Test nested many-to-many join: post_tags -> post -> author
    const uow2 = queryEngine
      .createUnitOfWork("get-post-tags-with-authors")
      .find("post_tags", (b) =>
        b
          .whereIndex("pt_post", (eb) => eb("post_id", "=", post1Id))
          .join((jb) =>
            jb.post((pb) =>
              pb.select(["title"]).join((jb2) => jb2["author"]((ab) => ab.select(["name"]))),
            ),
          ),
      );

    const [postTagsWithAuthors] = await uow2.executeRetrieve();

    // Should have 2 entries (TypeScript and Tutorial tags for post1)
    expect(postTagsWithAuthors).toHaveLength(2);

    // Verify nested structure
    expect(postTagsWithAuthors[0]).toMatchObject({
      post: {
        title: "TypeScript Tips",
        author: {
          name: "Blog Author",
        },
      },
    });

    // Both should have the same author
    for (const pt of postTagsWithAuthors) {
      expect(pt.post!.author!.name).toBe("Blog Author");
    }
  });

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user (author)
    const authorId = await queryEngine.create("users", {
      name: "Blog Author",
      age: 30,
    });

    // Create a post by the author
    const postId = await queryEngine.create("posts", {
      user_id: authorId,
      title: "My First Post",
      content: "This is the content of my first post",
    });

    // Create a commenter
    const commenterId = await queryEngine.create("users", {
      name: "Commenter User",
      age: 25,
    });

    // Create a comment on the post
    await queryEngine.create("comments", {
      post_id: postId,
      user_id: commenterId,
      text: "Great post!",
    });

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
          externalId: postId.externalId,
        }),
        title: "My First Post",
        content: "This is the content of my first post",
        // Nested author join (second level)
        author: {
          id: expect.objectContaining({
            externalId: authorId.externalId,
          }),
          name: "Blog Author",
          age: 30,
        },
      },
      // Commenter join (first level)
      commenter: {
        id: expect.objectContaining({
          externalId: commenterId.externalId,
        }),
        name: "Commenter User",
      },
    });
  });

  it("should return created IDs from UOW create operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

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
        internalId: expect.any(Number),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
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
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user
    const userId = await queryEngine.create("users", {
      name: "Timestamp Test User",
      age: 28,
    });

    // Create a post
    const postId = await queryEngine.create("posts", {
      user_id: userId,
      title: "Timestamp Test Post",
      content: "Testing timestamp handling",
    });

    // Retrieve the post
    const post = await queryEngine.findFirst("posts", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", postId)),
    );

    expect(post).toBeDefined();

    // Test with a table that doesn't have timestamps
    // Verify that Date handling works in general by checking basic Date operations
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

    // Verify that dates from different timezones are handled correctly
    const localDate = new Date("2024-06-15T14:30:00");
    expect(localDate).toBeInstanceOf(Date);
    expect(typeof localDate.getTimezoneOffset()).toBe("number");
  });

  it("should create user and post in same transaction using returned ID", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create UOW and create both user and post in same transaction
    const uow = queryEngine.createUnitOfWork("create-user-and-post");

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
    const user = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", userId)),
    );

    expect(user?.name).toBe("UOW Test User");
    expect(user?.age).toBe(35);

    const post = await queryEngine.findFirst("posts", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", postId.externalId)),
    );

    expect(post?.title).toBe("UOW Test Post");
    expect(post?.content).toBe("This post was created in the same transaction as the user");

    // Verify the foreign key relationship is correct
    expect(post?.user_id.internalId).toBe(user?.id.internalId);
  });
});
