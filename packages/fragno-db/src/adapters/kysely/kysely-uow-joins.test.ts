import { Kysely, PostgresDialect } from "kysely";
import { describe, it, beforeAll, assert, expect } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { Kysely as KyselyType, PostgresDialectConfig } from "kysely";
import { UnitOfWork, type UOWDecoder } from "../../query/unit-of-work";
import { createKyselyUOWCompiler } from "./kysely-uow-compiler";
import type { ConnectionPool } from "../../shared/connection-pool";
import { createKyselyConnectionPool } from "./kysely-connection-pool";

describe("kysely-uow-joins", () => {
  const userSchema = schema((s) => {
    return (
      s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"))
            .addColumn("invitedBy", referenceColumn())
            .createIndex("idx_name", ["name"])
            .createIndex("idx_id", ["id"]);
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("content", column("string"))
            .addColumn("userId", referenceColumn())
            .addColumn("publishedAt", column("timestamp"))
            .createIndex("idx_title", ["title"])
            .createIndex("idx_id", ["id"]);
        })
        .addTable("tags", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .createIndex("idx_id", ["id"]);
        })
        .addTable("post_tags", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("postId", referenceColumn())
            .addColumn("tagId", referenceColumn())
            .createIndex("idx_post", ["postId"])
            .createIndex("idx_tag", ["tagId"]);
        })
        .addTable("comments", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("content", column("string"))
            .addColumn("postId", referenceColumn())
            .addColumn("authorId", referenceColumn())
            .createIndex("idx_post", ["postId"])
            .createIndex("idx_author", ["authorId"]);
        })
        // Basic one-to-many relationships
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        })
        .addReference("inviter", {
          type: "one",
          from: { table: "users", column: "invitedBy" },
          to: { table: "users", column: "id" },
        })
        .addReference("post", {
          type: "one",
          from: { table: "comments", column: "postId" },
          to: { table: "posts", column: "id" },
        })
        .addReference("author", {
          type: "one",
          from: { table: "comments", column: "authorId" },
          to: { table: "users", column: "id" },
        })
        // Many-to-many relationships
        .addReference("post", {
          type: "one",
          from: { table: "post_tags", column: "postId" },
          to: { table: "posts", column: "id" },
        })
        .addReference("tag", {
          type: "one",
          from: { table: "post_tags", column: "tagId" },
          to: { table: "tags", column: "id" },
        })
    );
  });

  let kysely: KyselyType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: ConnectionPool<Kysely<any>>;

  beforeAll(async () => {
    kysely = new Kysely({
      dialect: new PostgresDialect({} as PostgresDialectConfig),
    });

    // Wrap in connection pool
    pool = createKyselyConnectionPool(kysely);
  });

  // Helper to create UnitOfWork for testing
  function createTestUOW(name?: string) {
    const mockCompiler = createKyselyUOWCompiler(pool, "postgresql");
    const mockExecutor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };
    const mockDecoder: UOWDecoder = (rawResults, operations) => {
      if (rawResults.length !== operations.length) {
        throw new Error("rawResults and ops must have the same length");
      }
      return rawResults;
    };
    return new UnitOfWork(mockCompiler, mockExecutor, mockDecoder, name).forSchema(userSchema);
  }

  describe("postgresql", () => {
    it("should compile select with join condition comparing columns", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "userId"])
          .join((jb) => jb.author()),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."email" as "author:email", "author"."invitedBy" as "author:invitedBy", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."userId" as "userId", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should compile join with specific column selection", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["name", "email"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."email" as "author:email", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should compile join with WHERE conditions on joined table", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) =>
            jb.author((ab) =>
              ab.select(["name"]).whereIndex("idx_name", (eb) => eb("name", "contains", "john")),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."name" like $1)"`,
      );
    });

    it("should compile self-referencing join", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "name"])
          .join((jb) => jb.inviter((ib) => ib.select(["name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "inviter"."name" as "inviter:name", "inviter"."_internalId" as "inviter:_internalId", "inviter"."_version" as "inviter:_version", "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" left join "users" as "inviter" on "users"."invitedBy" = "inviter"."_internalId""`,
      );
    });

    it("should compile multiple joins in single query", () => {
      const uow = createTestUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "content"])
          .join((jb) => jb.post((pb) => pb.select(["title"])).author((ab) => ab.select(["name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "comments"."id" as "id", "comments"."content" as "content", "comments"."_internalId" as "_internalId", "comments"."_version" as "_version" from "comments" left join "posts" as "post" on "comments"."postId" = "post"."_internalId" left join "users" as "author" on "comments"."authorId" = "author"."_internalId""`,
      );
    });

    it("should compile many-to-many join through junction table", () => {
      const uow = createTestUOW();
      uow.find("post_tags", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) => jb.post((pb) => pb.select(["title"])).tag((tb) => tb.select(["name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "tag"."name" as "tag:name", "tag"."_internalId" as "tag:_internalId", "tag"."_version" as "tag:_version", "post_tags"."id" as "id", "post_tags"."_internalId" as "_internalId", "post_tags"."_version" as "_version" from "post_tags" left join "posts" as "post" on "post_tags"."postId" = "post"."_internalId" left join "tags" as "tag" on "post_tags"."tagId" = "tag"."_internalId""`,
      );
    });

    it("should compile complex join with multiple WHERE conditions", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) =>
            jb.author((ab) =>
              ab.select(["name"]).whereIndex("idx_name", (eb) =>
                eb.and(
                  eb("name", "contains", "john"),
                  // @ts-expect-error - email is not indexed
                  eb("email", "ends with", "@example.com"),
                ),
              ),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and ("users"."name" like $1 and "users"."email" like $2))"`,
      );
    });

    it("should compile join with ordering on joined table - LIMITATION: orderBy applied but may have limited effect", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["name"]).orderByIndex("idx_name", "asc"))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // LIMITATION: orderBy on join options is applied but has limited effect in SQL JOINs
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should compile join with pageSize on joined table - LIMITATION: pageSize applied but may have limited effect", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["name"]).pageSize(1))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // LIMITATION: pageSize on join options is applied but has limited effect in SQL JOINs
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    // Tests for nested joins - SUPPORTED in UOW API
    it("should support nested joins (join on joined table) - IMPLEMENTED in UOW API", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) =>
            jb.author((ab) =>
              ab
                .select(["name"])
                .join((authorJoin) => authorJoin["inviter"]((ib) => ib.select(["name"]))),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // EXPECTED SQL: Should include both the author join AND the inviter join
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author_inviter"."name" as "author:inviter:name", "author_inviter"."_internalId" as "author:inviter:_internalId", "author_inviter"."_version" as "author:inviter:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId" left join "users" as "author_inviter" on "author"."invitedBy" = "author_inviter"."_internalId""`,
      );
    });
  });

  describe("id column selection in joins", () => {
    it("should properly transform id columns in joined tables to FragnoId objects", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["id", "name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"author"."id"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toContain('"author"."_version" as "author:_version"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should select id columns from main table and joined table", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["id", "name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // Both main table id and joined table id should be in the query
      expect(query.sql).toContain('"posts"."id"');
      expect(query.sql).toContain('"author"."id"');
      // When id is selected from joined table, its _internalId is also included
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should handle id-only selection in join", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) => jb.author((ab) => ab.select(["id"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // When only id is selected, _internalId is still included for joined table
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should include _internalId for both main and joined table when id is selected", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["id", "name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // Both tables should have their _internalId included when id is selected
      expect(query.sql).toContain('"posts"."_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should not include _internalId when id is not selected", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["title"])
          .join((jb) => jb.author((ab) => ab.select(["name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // Hidden columns (_internalId, _version) are always included for internal use
      expect(query.sql).toContain('"posts"."_internalId" as "_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toContain('"posts"."_version" as "_version"');
      expect(query.sql).toContain('"author"."_version" as "author:_version"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should handle select true with joins - includes all columns including id", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) => b.whereIndex("primary").join((jb) => jb.author()));

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"posts"."id"');
      expect(query.sql).toContain('"author"."id"');
      expect(query.sql).toContain('"posts"."_internalId"');
      expect(query.sql).toContain('"author"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."email" as "author:email", "author"."invitedBy" as "author:invitedBy", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should handle id column in where clause on joined table", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) =>
            jb.author((ab) =>
              ab.select(["id", "name"]).whereIndex("idx_id", (eb) => eb("id", "=", "user-123")),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."id" = $1)"`,
      );
    });

    it("should handle multiple joins with different id selections", () => {
      const uow = createTestUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "content"])
          .join((jb) =>
            jb.post((pb) => pb.select(["id", "title"])).author((ab) => ab.select(["name"])),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"comments"."id"');
      expect(query.sql).toContain('"post"."id"');
      expect(query.sql).not.toContain('"author"."id"');
      // Hidden columns are always included regardless of ID selection
      expect(query.sql).toContain('"post"."_internalId" as "post:_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toContain('"post"."_version" as "post:_version"');
      expect(query.sql).toContain('"author"."_version" as "author:_version"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."id" as "post:id", "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "comments"."id" as "id", "comments"."content" as "content", "comments"."_internalId" as "_internalId", "comments"."_version" as "_version" from "comments" left join "posts" as "post" on "comments"."postId" = "post"."_internalId" left join "users" as "author" on "comments"."authorId" = "author"."_internalId""`,
      );
    });
  });

  describe("custom-named id columns in joins", () => {
    // Schema with custom id column names
    const customIdSchema = schema((s) => {
      return s
        .addTable("products", (t) => {
          return t
            .addColumn("productId", idColumn())
            .addColumn("name", column("string"))
            .addColumn("price", column("integer"))
            .createIndex("idx_product_id", ["productId"]);
        })
        .addTable("categories", (t) => {
          return t
            .addColumn("categoryId", idColumn())
            .addColumn("categoryName", column("string"))
            .createIndex("idx_category_id", ["categoryId"]);
        })
        .addTable("product_categories", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("prodRef", referenceColumn())
            .addColumn("catRef", referenceColumn())
            .createIndex("idx_prod", ["prodRef"])
            .createIndex("idx_cat", ["catRef"]);
        })
        .addReference("product", {
          type: "one",
          from: { table: "product_categories", column: "prodRef" },
          to: { table: "products", column: "productId" },
        })
        .addReference("category", {
          type: "one",
          from: { table: "product_categories", column: "catRef" },
          to: { table: "categories", column: "categoryId" },
        });
    });

    function createCustomIdTestUOW() {
      const mockCompiler = createKyselyUOWCompiler(pool, "postgresql");
      const mockExecutor = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const mockDecoder: UOWDecoder = (rawResults, operations) => {
        if (rawResults.length !== operations.length) {
          throw new Error("rawResults and ops must have the same length");
        }
        return rawResults;
      };
      return new UnitOfWork(mockCompiler, mockExecutor, mockDecoder).forSchema(customIdSchema);
    }

    it("should compile join with custom id column names", () => {
      const uow = createCustomIdTestUOW();
      uow.find("product_categories", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) =>
            jb
              .product((pb) => pb.select(["productId", "name"]))
              .category((cb) => cb.select(["categoryId", "categoryName"])),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"product"."productId"');
      expect(query.sql).toContain('"category"."categoryId"');
      // Custom id columns also get their _internalId included
      expect(query.sql).toContain('"product"."_internalId" as "product:_internalId"');
      expect(query.sql).toContain('"category"."_internalId" as "category:_internalId"');
      // Join conditions ALWAYS use _internalId (not custom column names) for performance
      expect(query.sql).toContain('"product_categories"."prodRef" = "product"."_internalId"');
      expect(query.sql).toContain('"product_categories"."catRef" = "category"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "category"."categoryId" as "category:categoryId", "category"."categoryName" as "category:categoryName", "category"."_internalId" as "category:_internalId", "category"."_version" as "category:_version", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId" left join "categories" as "category" on "product_categories"."catRef" = "category"."_internalId""`,
      );
    });

    it("should handle custom id in join where clause", () => {
      const uow = createCustomIdTestUOW();
      uow.find("product_categories", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) =>
            jb.product((pb) =>
              pb
                .select(["productId", "name"])
                .whereIndex("idx_product_id", (eb) => eb("productId", "=", "prod-456")),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"products"."productId" = $1');
      expect(query.sql).toContain('"product"."_internalId" as "product:_internalId"');
      // Join condition ALWAYS uses _internalId for performance
      expect(query.sql).toContain('"product_categories"."prodRef" = "product"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version" from "product_categories" left join "products" as "product" on ("product_categories"."prodRef" = "product"."_internalId" and "products"."productId" = $1)"`,
      );
    });

    it("should handle select true with custom id columns", () => {
      const uow = createCustomIdTestUOW();
      uow.find("product_categories", (b) => b.whereIndex("primary").join((jb) => jb.product()));

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"product"."productId"');
      expect(query.sql).toContain('"product_categories"."id"');
      // With select true, _internalId IS now included when table has an id column
      expect(query.sql).toContain('"product"."_internalId" as "product:_internalId"');
      // Join condition ALWAYS uses _internalId for performance
      expect(query.sql).toContain('"product_categories"."prodRef" = "product"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."price" as "product:price", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product_categories"."id" as "id", "product_categories"."prodRef" as "prodRef", "product_categories"."catRef" as "catRef", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId""`,
      );
    });

    it("should join tables with different custom id names", () => {
      const uow = createCustomIdTestUOW();
      uow.find("product_categories", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) =>
            jb
              .product((pb) => pb.select(["productId"]))
              .category((cb) => cb.select(["categoryId"])),
          ),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"product"."productId"');
      expect(query.sql).toContain('"category"."categoryId"');
      expect(query.sql).not.toContain('"product"."id"'); // Should not have 'id', only 'productId'
      expect(query.sql).not.toContain('"category"."id"'); // Should not have 'id', only 'categoryId'
      // _internalId included for both since custom id columns are selected
      expect(query.sql).toContain('"product"."_internalId" as "product:_internalId"');
      expect(query.sql).toContain('"category"."_internalId" as "category:_internalId"');
      // Join conditions ALWAYS use _internalId for performance
      expect(query.sql).toContain('"product_categories"."prodRef" = "product"."_internalId"');
      expect(query.sql).toContain('"product_categories"."catRef" = "category"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "category"."categoryId" as "category:categoryId", "category"."_internalId" as "category:_internalId", "category"."_version" as "category:_version", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId" left join "categories" as "category" on "product_categories"."catRef" = "category"."_internalId""`,
      );
    });
  });

  describe("special columns in joins - _internalId aliasing", () => {
    it("should properly alias _internalId for joined tables", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) => jb.author((ab) => ab.select(["id"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // Main table _internalId should be aliased as "_internalId"
      expect(query.sql).toContain('"posts"."_internalId" as "_internalId"');
      // Joined table _internalId should be aliased as "relation:_internalId" when id is selected
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should handle _internalId in join conditions", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title"])
          .join((jb) => jb.author((ab) => ab.select(["id", "name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // Join condition should use _internalId
      expect(query.sql).toContain('"posts"."userId" = "author"."_internalId"');
      // Joined table _internalId is included when id is selected
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should handle multiple joins with _internalId tracking", () => {
      const uow = createTestUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .select(["id"])
          .join((jb) => jb.post((pb) => pb.select(["id"])).author((ab) => ab.select(["id"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // All _internalId should be properly aliased
      expect(query.sql).toContain('"comments"."_internalId" as "_internalId"');
      // Joined tables with id selected also get _internalId
      expect(query.sql).toContain('"post"."_internalId" as "post:_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      // Join should use _internalId for connection
      expect(query.sql).toContain('"comments"."postId" = "post"."_internalId"');
      expect(query.sql).toContain('"comments"."authorId" = "author"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."id" as "post:id", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "author"."id" as "author:id", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "comments"."id" as "id", "comments"."_internalId" as "_internalId", "comments"."_version" as "_version" from "comments" left join "posts" as "post" on "comments"."postId" = "post"."_internalId" left join "users" as "author" on "comments"."authorId" = "author"."_internalId""`,
      );
    });

    it("should handle self-referencing join with _internalId", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "name"])
          .join((jb) => jb.inviter((ib) => ib.select(["id", "name"]))),
      );

      const compiler = createKyselyUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"users"."invitedBy" = "inviter"."_internalId"');
      expect(query.sql).toContain('"users"."_internalId" as "_internalId"');
      // Self-join with id selected also includes _internalId for joined instance
      expect(query.sql).toContain('"inviter"."_internalId" as "inviter:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "inviter"."id" as "inviter:id", "inviter"."name" as "inviter:name", "inviter"."_internalId" as "inviter:_internalId", "inviter"."_version" as "inviter:_version", "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" left join "users" as "inviter" on "users"."invitedBy" = "inviter"."_internalId""`,
      );
    });
  });
});
