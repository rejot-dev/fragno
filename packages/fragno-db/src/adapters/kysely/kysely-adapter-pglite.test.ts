// FIXME: There should be no `any` in this file, but we need to fix join types.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
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
      .addReference("emails", "user", {
        columns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
      })
      .addReference("posts", "author", {
        columns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
      })
      .addReference("post_tags", "post", {
        columns: ["post_id"],
        targetTable: "posts",
        targetColumns: ["id"],
      })
      .addReference("post_tags", "tag", {
        columns: ["tag_id"],
        targetTable: "tags",
        targetColumns: ["id"],
      })
      .addReference("comments", "post", {
        columns: ["post_id"],
        targetTable: "posts",
        targetColumns: ["id"],
      })
      .addReference("comments", "commenter", {
        columns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
      });
  });

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
    const preparedMigration = await migrator.prepareMigration();
    assert(preparedMigration.getSQL);

    expect(preparedMigration.getSQL()).toMatchInlineSnapshot(`
      "create table "users" ("id" varchar(30) not null unique, "name" text not null, "age" integer, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "name_idx" on "users" ("name");

      create index "age_idx" on "users" ("age");

      create table "emails" ("id" varchar(30) not null unique, "user_id" bigint not null, "email" text not null, "is_primary" boolean default false not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create unique index "unique_email" on "emails" ("email");

      create index "user_emails" on "emails" ("user_id");

      create table "posts" ("id" varchar(30) not null unique, "user_id" bigint not null, "title" text not null, "content" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "posts_user_idx" on "posts" ("user_id");

      create table "tags" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "tag_name" on "tags" ("name");

      create table "post_tags" ("id" varchar(30) not null unique, "post_id" bigint not null, "tag_id" bigint not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "pt_post" on "post_tags" ("post_id");

      create index "pt_tag" on "post_tags" ("tag_id");

      create table "comments" ("id" varchar(30) not null unique, "post_id" bigint not null, "user_id" bigint not null, "text" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create index "comments_post_idx" on "comments" ("post_id");

      create index "comments_user_idx" on "comments" ("user_id");

      alter table "emails" add constraint "emails_users_user_fk" foreign key ("user_id") references "users" ("_internalId") on delete restrict on update restrict;

      alter table "posts" add constraint "posts_users_author_fk" foreign key ("user_id") references "users" ("_internalId") on delete restrict on update restrict;

      alter table "post_tags" add constraint "post_tags_posts_post_fk" foreign key ("post_id") references "posts" ("_internalId") on delete restrict on update restrict;

      alter table "post_tags" add constraint "post_tags_tags_tag_fk" foreign key ("tag_id") references "tags" ("_internalId") on delete restrict on update restrict;

      alter table "comments" add constraint "comments_posts_post_fk" foreign key ("post_id") references "posts" ("_internalId") on delete restrict on update restrict;

      alter table "comments" add constraint "comments_users_commenter_fk" foreign key ("user_id") references "users" ("_internalId") on delete restrict on update restrict;

      create table "fragno_db_settings" ("key" varchar(255) primary key, "value" text not null);

      insert into "fragno_db_settings" ("key", "value") values ('test.schema_version', '12');"
    `);

    await preparedMigration.execute();

    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user
    const userResult = await queryEngine.create("users", {
      name: "John Doe",
      age: 30,
    });

    expect(userResult).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      name: "John Doe",
      age: 30,
    });

    expect(userResult.id.version).toBe(0);

    const getUser = await queryEngine.findFirst("users", {
      select: ["id"],
      where: (b) => b("id", "=", userResult.id),
    });
    expect(getUser).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
    });

    // Create 2 emails for the user
    const email1Result = await queryEngine.create("emails", {
      user_id: userResult.id,
      email: "john.doe@example.com",
      is_primary: true,
    });

    const email2Result = await queryEngine.create("emails", {
      // Pass only the string (external ID) here, to make sure we generate the right sub-query.
      user_id: userResult.id.toString(),
      email: "john.doe.work@company.com",
      is_primary: false,
    });

    expect(email1Result).toEqual({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      email: "john.doe@example.com",
      is_primary: true,
    });

    expect(email2Result).toEqual({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      email: "john.doe.work@company.com",
      is_primary: false,
    });

    // Update user name
    await queryEngine.updateMany("users", {
      where: (b) => b("id", "=", userResult.id),
      set: {
        name: "Jane Doe",
      },
    });

    const updatedUser = await queryEngine.findFirst("users", {
      where: (b) => b("id", "=", userResult.id),
    });
    // Version has been incremented
    expect(updatedUser!.id.version).toBe(1);

    // Query emails with their users using join (since the relation is from emails to users)
    const emailsWithUsers = await queryEngine.findMany("emails", {
      join: (b) => b.user({ select: ["name", "age", "id"] }),
    });

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
    const userEmails = await queryEngine.findMany("emails", {
      where: (b) => b("user_id", "=", userResult.id),
      join: (b) => b.user({ select: ["name", "age"] }),
    });

    expect(userEmails).toHaveLength(2);
  });

  it("should execute Unit of Work with version checking", async () => {
    // Use the same namespace as the first test (migrations already ran)
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create initial user
    const initialUser = await queryEngine.create("users", {
      name: "Alice",
      age: 25,
    });

    expect(initialUser.id.version).toBe(0);

    // Build a UOW to update the user with optimistic locking
    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      // Retrieval phase: find the user
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUser.id)));

    // Execute retrieval and transition to mutation phase
    const [users] = await uow.executeRetrieve();

    // Mutation phase: update with version check
    uow.update("users", initialUser.id, (b) => b.set({ age: 26 }).check());

    // Execute mutations
    const { success } = await uow.executeMutations();

    // Should succeed
    expect(success).toBe(true);
    expect(users).toHaveLength(1);

    // Verify the user was updated
    const updatedUser = await queryEngine.findFirst("users", {
      where: (b) => b("id", "=", initialUser.id),
    });

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: initialUser.id.externalId,
        version: 1, // Version incremented
      }),
      name: "Alice",
      age: 26,
    });

    // Try to update again with stale version (should fail)
    const uow2 = queryEngine.createUnitOfWork("update-user-stale");

    // Use the old version (0) which is now stale
    uow2.update("users", initialUser.id, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();

    // Should fail due to version conflict
    expect(success2).toBe(false);

    // Verify the user was NOT updated
    const [[unchangedUser]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUser.id)))
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
    const user = await queryEngine.create("users", {
      name: "Blog Author",
      age: 28,
    });

    // Create posts
    const post1 = await queryEngine.create("posts", {
      title: "TypeScript Tips",
      content: "Learn TypeScript",
      user_id: user.id,
    });

    const post2 = await queryEngine.create("posts", {
      title: "Database Design",
      content: "Learn databases",
      user_id: user.id,
    });

    // Create tags
    const tagTypeScript = await queryEngine.create("tags", {
      name: "TypeScript",
    });

    const tagDatabase = await queryEngine.create("tags", {
      name: "Database",
    });

    const tagTutorial = await queryEngine.create("tags", {
      name: "Tutorial",
    });

    // Link posts to tags via junction table
    // Post 1 has tags: TypeScript, Tutorial
    await queryEngine.create("post_tags", {
      post_id: post1.id,
      tag_id: tagTypeScript.id,
    });

    await queryEngine.create("post_tags", {
      post_id: post1.id,
      tag_id: tagTutorial.id,
    });

    // Post 2 has tags: Database, Tutorial
    await queryEngine.create("post_tags", {
      post_id: post2.id,
      tag_id: tagDatabase.id,
    });

    await queryEngine.create("post_tags", {
      post_id: post2.id,
      tag_id: tagTutorial.id,
    });

    // Query post_tags with joined post and tag data using UOW
    const uow = queryEngine.createUnitOfWork("get-post-tags").find("post_tags", (b) =>
      b.whereIndex("primary").join((jb) => {
        jb.post((pb) => pb.select(["title"]));
        jb.tag((tb) => tb.select(["name"]));
      }),
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

    // Verify we can find specific combinations
    const typeScriptPosts = postTags.filter((pt: any) => pt["tag"].name === "TypeScript");
    expect(typeScriptPosts).toHaveLength(1);
    expect((typeScriptPosts[0] as any)["post"].title).toBe("TypeScript Tips");

    const tutorialPosts = postTags.filter((pt: any) => pt["tag"].name === "Tutorial");
    expect(tutorialPosts).toHaveLength(2);
    expect(tutorialPosts.map((pt: any) => pt["post"].title).sort()).toEqual([
      "Database Design",
      "TypeScript Tips",
    ]);

    // Test nested many-to-many join: post_tags -> post -> author
    const uow2 = queryEngine
      .createUnitOfWork("get-post-tags-with-authors")
      .find("post_tags", (b) =>
        b
          .whereIndex("pt_post", (eb) => eb("post_id", "=", post1.id))
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
      expect((pt as any)["post"].author.name).toBe("Blog Author");
    }
  });

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user (author)
    const author = await queryEngine.create("users", {
      name: "Blog Author",
      age: 30,
    });

    // Create a post by the author
    const post = await queryEngine.create("posts", {
      user_id: author.id,
      title: "My First Post",
      content: "This is the content of my first post",
    });

    // Create a commenter
    const commenter = await queryEngine.create("users", {
      name: "Commenter User",
      age: 25,
    });

    // Create a comment on the post
    await queryEngine.create("comments", {
      post_id: post.id,
      user_id: commenter.id,
      text: "Great post!",
    });

    // Now perform a complex nested join: comments -> post -> author, and comments -> commenter
    const uow = queryEngine.createUnitOfWork("test-complex-joins").find("comments", (b) =>
      b.whereIndex("primary").join((jb) => {
        jb.post((postBuilder) =>
          postBuilder
            .select(["id", "title", "content"])
            .orderByIndex("primary", "desc")
            .pageSize(1)
            .join((jb2) => {
              // Nested join to the post's author
              jb2.author((authorBuilder) =>
                authorBuilder.select(["id", "name", "age"]).orderByIndex("name_idx", "asc"),
              );
            }),
        ).commenter((commenterBuilder) => commenterBuilder.select(["id", "name"]));
      }),
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
});
