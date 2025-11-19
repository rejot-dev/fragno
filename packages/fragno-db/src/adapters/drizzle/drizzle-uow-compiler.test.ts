import { assert, beforeAll, describe, expect, it } from "vitest";
import {
  column,
  FragnoId,
  idColumn,
  referenceColumn,
  schema,
  type AnySchema,
} from "../../schema/create";
import { createDrizzleUOWCompiler } from "./drizzle-uow-compiler";
import { drizzle } from "drizzle-orm/pglite";
import type { DBType } from "./shared";
import { UnitOfWork, type UOWDecoder } from "../../query/unit-of-work";
import { writeAndLoadSchema } from "./test-utils";
import type { ConnectionPool } from "../../shared/connection-pool";
import { createDrizzleConnectionPool } from "./drizzle-connection-pool";
import { Cursor } from "../../query/cursor";

/**
 * Integration tests for Drizzle UOW compiler and executor.
 * These tests generate a real Drizzle schema and verify compilation works correctly.
 */
describe("drizzle-uow-compiler", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name", ["name"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", referenceColumn())
          .addColumn("viewCount", column("integer").defaultTo(0))
          .createIndex("idx_user", ["userId"])
          .createIndex("idx_title", ["title"]);
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
      });
  });

  let db: DBType;
  let pool: ConnectionPool<DBType>;

  beforeAll(async () => {
    // Write schema to file and dynamically import it
    const { schemaModule, cleanup } = await writeAndLoadSchema(
      "drizzle-uow-compiler",
      testSchema,
      "postgresql",
    );

    // Create Drizzle instance with PGLite (in-memory Postgres)
    db = drizzle({
      schema: schemaModule,
    }) as unknown as DBType;

    // Wrap in connection pool
    pool = createDrizzleConnectionPool(db);

    return async () => {
      await cleanup();
    };
  });

  function createTestUOWWithSchema<const T extends AnySchema>(schema: T) {
    const compiler = createDrizzleUOWCompiler(pool, "postgresql");
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
    return new UnitOfWork(compiler, mockExecutor, mockDecoder).forSchema(schema);
  }

  function createTestUOW(name?: string) {
    const compiler = createDrizzleUOWCompiler(pool, "postgresql");
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
    return new UnitOfWork(compiler, mockExecutor, mockDecoder, name).forSchema(testSchema);
  }

  it("should create a compiler with the correct structure", () => {
    const compiler = createDrizzleUOWCompiler(pool, "postgresql");

    expect(compiler).toBeDefined();
    expect(compiler.compileRetrievalOperation).toBeInstanceOf(Function);
    expect(compiler.compileMutationOperation).toBeInstanceOf(Function);
  });

  describe("compileRetrievalOperation", () => {
    it("should compile find operation with where clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_email", (eb) => eb("email", "=", "test@example.com")),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."email" = $1"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["test@example.com"]);
    });

    it("should compile find operation with select clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_name", (eb) => eb("name", "=", "Alice")).select(["id", "name"]),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "_internalId", "_version" from "users" "users" where "users"."name" = $1"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["Alice"]);
    });

    it("should compile find operation with pageSize", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").pageSize(10));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" limit $1"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual([10]);
    });

    it("should compile find operation with orderByIndex on primary index", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").orderByIndex("primary", "desc"));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" order by "users"."id" desc"`,
      );
    });

    it("should compile find operation with orderByIndex", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("idx_name").orderByIndex("idx_name", "desc"));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" order by "users"."name" desc"`,
      );
    });

    it("should compile multiple find operations", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_email", (eb) => eb("email", "=", "user1@example.com")),
      );
      uow.find("posts", (b) => b.whereIndex("idx_title", (eb) => eb("title", "contains", "test")));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(2);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."email" = $1"`,
      );
      expect(compiled.retrievalBatch[1].sql).toMatchInlineSnapshot(
        `"select "id", "title", "content", "userId", "viewCount", "_internalId", "_version" from "posts" "posts" where "posts"."title" like $1"`,
      );
    });

    it("should compile find operation with selectCount", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").selectCount());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select count(*) from "users""`,
      );
    });

    it("should compile find operation with selectCount and where clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_name", (eb) => eb("name", "starts with", "John")).selectCount(),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select count(*) from "users" where "users"."name" like $1"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["John%"]);
    });

    it("should compile find operation with cursor pagination using after", () => {
      const uow = createTestUOW();
      const cursor = new Cursor({
        indexName: "idx_name",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { name: "Alice" },
      });
      uow.find("users", (b) =>
        b.whereIndex("idx_name").orderByIndex("idx_name", "asc").after(cursor).pageSize(10),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."name" > $1 order by "users"."name" asc limit $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["Alice", 10]);
    });

    it("should compile find operation with cursor pagination using before", () => {
      const uow = createTestUOW();
      const cursor = new Cursor({
        indexName: "idx_name",
        orderDirection: "desc",
        pageSize: 10,
        indexValues: { name: "Bob" },
      });
      uow.find("users", (b) =>
        b.whereIndex("idx_name").orderByIndex("idx_name", "desc").before(cursor).pageSize(10),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."name" > $1 order by "users"."name" desc limit $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["Bob", 10]);
    });

    it("should compile find operation with cursor pagination and additional where conditions", () => {
      const uow = createTestUOW();
      const cursor = new Cursor({
        indexName: "idx_name",
        orderDirection: "asc",
        pageSize: 5,
        indexValues: { name: "Alice" },
      });
      uow.find("users", (b) =>
        b
          .whereIndex("idx_name", (eb) => eb("name", "starts with", "John"))
          .orderByIndex("idx_name", "asc")
          .after(cursor)
          .pageSize(5),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where ("users"."name" like $1 and "users"."name" > $2) order by "users"."name" asc limit $3"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["John%", "Alice", 5]);
    });

    it("should compile find operation with join", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("idx_title", (eb) => eb("title", "contains", "test"))
          .join((jb) => jb.author()),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      // This should generate SQL that joins posts with users and selects author name and email
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "posts"."id", "posts"."title", "posts"."content", "posts"."userId", "posts"."viewCount", "posts"."_internalId", "posts"."_version", "posts_author"."data" as "author" from "posts" "posts" left join lateral (select json_build_array("posts_author"."id", "posts_author"."name", "posts_author"."email", "posts_author"."age", "posts_author"."_internalId", "posts_author"."_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit $1) "posts_author") "posts_author" on true where "posts"."title" like $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual([1, "%test%"]);
    });

    it("should compile find operation with join filtering", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb.author((builder) =>
              builder.whereIndex("idx_name", (eb) => eb("name", "=", "Alice")).select(["name"]),
            ),
          ),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "posts"."id", "posts"."title", "posts"."content", "posts"."userId", "posts"."viewCount", "posts"."_internalId", "posts"."_version", "posts_author"."data" as "author" from "posts" "posts" left join lateral (select json_build_array("posts_author"."name", "posts_author"."_internalId", "posts_author"."_version") as "data" from (select * from "users" "posts_author" where ("posts_author"."_internalId" = "posts"."userId" and "posts_author"."name" = $1) limit $2) "posts_author") "posts_author" on true"`,
      );
    });

    it("should compile find operation with join ordering", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb.author((builder) => builder.orderByIndex("idx_name", "desc"))),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "posts"."id", "posts"."title", "posts"."content", "posts"."userId", "posts"."viewCount", "posts"."_internalId", "posts"."_version", "posts_author"."data" as "author" from "posts" "posts" left join lateral (select json_build_array("posts_author"."id", "posts_author"."name", "posts_author"."email", "posts_author"."age", "posts_author"."_internalId", "posts_author"."_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" order by "posts_author"."name" desc limit $1) "posts_author") "posts_author" on true"`,
      );
    });

    it("should compile find operation with join pageSize", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b.whereIndex("primary").join((jb) => jb.author((builder) => builder.pageSize(5))),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      // Should have limit in the joined query
      expect(sql).toMatchInlineSnapshot(
        `"select "posts"."id", "posts"."title", "posts"."content", "posts"."userId", "posts"."viewCount", "posts"."_internalId", "posts"."_version", "posts_author"."data" as "author" from "posts" "posts" left join lateral (select json_build_array("posts_author"."id", "posts_author"."name", "posts_author"."email", "posts_author"."age", "posts_author"."_internalId", "posts_author"."_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit $1) "posts_author") "posts_author" on true"`,
      );
    });
  });

  describe("compileMutationOperation", () => {
    it("should compile create operation", () => {
      const uow = createTestUOW();
      uow.create("users", {
        name: "John Doe",
        email: "john@example.com",
        age: 30,
      });

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_internalId", "_version") values ($1, $2, $3, $4, default, default)"`,
      );
      expect(batch.query.params).toMatchObject([
        expect.any(String),
        "John Doe",
        "john@example.com",
        30,
      ]);
    });

    it("should compile create operation with external id string for reference column", () => {
      const uow = createTestUOW();
      // Create a post with userId as just an external id string
      uow.create("posts", {
        title: "Test Post",
        content: "Post content",
        userId: "user_external_id_123",
        viewCount: 5,
      });

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId", "viewCount", "_internalId", "_version") values ($1, $2, $3, (select "_internalId" from "users" where "id" = $4 limit 1), $5, default, default)"`,
      );
      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated post ID
        "Test Post",
        "Post content",
        "user_external_id_123", // external id string
        5, // viewCount
      ]);
    });

    it("should compile create operation with bigint for reference column (no subquery)", () => {
      const uow = createTestUOW();
      // Create a post with userId as a bigint directly (internal ID)
      uow.create("posts", {
        title: "Direct ID Post",
        content: "Content with direct bigint",
        userId: 12345n,
      });

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should NOT have a subquery when using bigint directly
      expect(batch.query.sql).not.toMatch(/\(select.*from.*users/i);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId", "viewCount", "_internalId", "_version") values ($1, $2, $3, $4, default, default, default)"`,
      );
      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated post ID
        "Direct ID Post",
        "Content with direct bigint",
        12345n, // bigint internal ID directly
      ]);
    });

    it("should compile create operation with FragnoId object for reference column", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user_ext_789", 0);
      // Create a post with userId as a FragnoId object
      uow.create("posts", {
        title: "Post with FragnoId",
        content: "Content",
        userId,
      });

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // FragnoId should generate a subquery to lookup the internal ID from external ID
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId", "viewCount", "_internalId", "_version") values ($1, $2, $3, (select "_internalId" from "users" where "id" = $4 limit 1), default, default, default)"`,
      );
    });

    it("should compile update operation with external id string for reference column", () => {
      const uow = createTestUOW();
      const postId = FragnoId.fromExternal("post123", 0);
      uow.update("posts", postId, (b) =>
        b.set({
          userId: "new_user_external_id_456",
        }),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should generate a subquery for the string external ID in UPDATE
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = (select "_internalId" from "users" where "id" = $1 limit 1), "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = $2"`,
      );
      expect(batch.query.params).toMatchObject([
        "new_user_external_id_456", // external id string
        "post123", // post external id
      ]);
    });

    it("should compile update operation with bigint for reference column (no subquery)", () => {
      const uow = createTestUOW();
      const postId = FragnoId.fromExternal("post456", 0);
      uow.update("posts", postId, (b) =>
        b.set({
          userId: 99999n,
        }),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should NOT have a subquery when using bigint directly
      expect(batch.query.sql).not.toMatch(/\(select.*from.*users/i);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = $1, "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = $2"`,
      );
      expect(batch.query.params).toMatchObject([
        99999n, // bigint internal ID directly
        "post456", // post external id
      ]);
    });

    it("should compile update operation with ID", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 0);
      uow.update("users", userId, (b) =>
        b.set({
          name: "Jane Doe",
          age: 25,
        }),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = $1, "age" = $2, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = $3"`,
      );
      expect(batch.query.params).toMatchObject(["Jane Doe", 25, "user123"]);
    });

    it("should compile update operation with version check", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 5);
      uow.update("users", userId, (b) => b.set({ age: 18 }).check());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
      expect(batch.query.params).toMatchObject([18, "user123", 5]);
    });

    it("should compile delete operation with ID", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 0);
      uow.delete("users", userId);

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where "users"."id" = $1"`,
      );
      expect(batch.query.params).toMatchObject(["user123"]);
    });

    it("should compile delete operation with version check", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 3);
      uow.delete("users", userId, (b) => b.check());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = $1 and "users"."_version" = $2)"`,
      );
      expect(batch.query.params).toMatchObject(["user123", 3]);
    });

    it("should compile update operation with string ID", () => {
      const uow = createTestUOW();
      uow.update("users", "user123", (b) =>
        b.set({
          name: "Jane Doe",
          age: 25,
        }),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = $1, "age" = $2, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = $3"`,
      );
      expect(batch.query.params).toMatchObject(["Jane Doe", 25, "user123"]);
    });

    it("should compile delete operation with string ID", () => {
      const uow = createTestUOW();
      uow.delete("users", "user123");

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where "users"."id" = $1"`,
      );
      expect(batch.query.params).toMatchObject(["user123"]);
    });

    it("should throw when trying to check() with string ID on update", () => {
      const uow = createTestUOW();
      expect(() => {
        uow.update("users", "user123", (b) => b.set({ name: "Jane" }).check());
      }).toThrow(
        'Cannot use check() with a string ID on table "users". Version checking requires a FragnoId with version information.',
      );
    });

    it("should throw when trying to check() with string ID on delete", () => {
      const uow = createTestUOW();
      expect(() => {
        uow.delete("users", "user123", (b) => b.check());
      }).toThrow(
        'Cannot use check() with a string ID on table "users". Version checking requires a FragnoId with version information.',
      );
    });

    it("should compile multiple mutation operations", () => {
      const uow = createTestUOW();
      uow.create("users", {
        name: "Alice",
        email: "alice@example.com",
      });
      const postId = FragnoId.fromExternal("post123", 0);
      uow.update("posts", postId, (b) => b.set({ viewCount: 10 }));
      const userId = FragnoId.fromExternal("user456", 0);
      uow.delete("posts", userId);

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [createBatch, updateBatch, deleteBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(3);

      assert(createBatch);
      expect(createBatch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_internalId", "_version") values ($1, $2, $3, default, default, default)"`,
      );
      expect(createBatch.query.params).toMatchObject([
        expect.any(String), // auto-generated ID
        "Alice",
        "alice@example.com",
      ]);

      assert(updateBatch);
      expect(updateBatch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "viewCount" = $1, "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = $2"`,
      );

      assert(deleteBatch);
      expect(deleteBatch.query.sql).toMatchInlineSnapshot(
        `"delete from "posts" where "posts"."id" = $1"`,
      );
    });
  });

  describe("complete UOW workflow", () => {
    it("should compile retrieval and mutation phases together", () => {
      const uow = createTestUOW("update-user-balance");

      // Retrieval phase
      uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", "user123")));

      // Mutation phase
      const userId = FragnoId.fromExternal("user123", 3);
      uow.update("users", userId, (b) => b.set({ age: 31 }).check());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.name).toBe("update-user-balance");
      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.mutationBatch).toHaveLength(1);

      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."id" = $1"`,
      );

      // Update should include version check in WHERE clause
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
    });

    it("should handle complex where conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_email", (eb) =>
          eb.and(
            eb("email", "contains", "@example.com"),
            // @ts-expect-error - name is not indexed
            eb.or(eb("name", "=", "Alice"), eb("name", "=", "Bob")),
          ),
        ),
      );

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where ("users"."email" like $1 and ("users"."name" = $2 or "users"."name" = $3))"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["%@example.com%", "Alice", "Bob"]);
    });

    it("should return null for operations with always-false conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => false));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      // When condition is false, the operation should return null and not be added to batch
      expect(compiled.retrievalBatch).toHaveLength(0);
    });

    it("should handle always-true conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => true));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users""`,
      );
    });
  });

  describe("version checking", () => {
    it("should embed version check in update WHERE clause", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user123", 5);
      uow.update("users", userId, (b) => b.set({ age: 31 }).check());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
      expect(batch.query.params).toMatchObject([31, "user123", 5]);
    });

    it("should embed version check in delete WHERE clause", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user456", 3);
      uow.delete("users", userId, (b) => b.check());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = $1 and "users"."_version" = $2)"`,
      );
      expect(batch.query.params).toMatchObject(["user456", 3]);
    });

    it("should handle version checks on different tables", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user1", 2);
      const postId = FragnoId.fromExternal("post1", 1);

      uow.update("users", userId, (b) => b.set({ age: 30 }).check());
      uow.update("posts", postId, (b) => b.set({ viewCount: 100 }).check());

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [userBatch, postBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(2);

      assert(userBatch);
      expect(userBatch.expectedAffectedRows).toBe(1);
      expect(userBatch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
      expect(userBatch.query.params).toMatchObject([30, "user1", 2]);

      assert(postBatch);
      expect(postBatch.expectedAffectedRows).toBe(1);
      expect(postBatch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "viewCount" = $1, "_version" = COALESCE(_version, 0) + 1 where ("posts"."id" = $2 and "posts"."_version" = $3)"`,
      );
      expect(postBatch.query.params).toMatchObject([100, "post1", 1]);
    });

    it("should not affect updates without version checks", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user1", 0);
      uow.update("users", userId, (b) => b.set({ age: 25 }));

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should be normal update without version check
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = $2"`,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle UOW with no operations", () => {
      const uow = createTestUOW();

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(0);
    });

    it("should handle UOW with only retrieval operations", () => {
      const uow = createTestUOW();
      uow.find("users");

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.mutationBatch).toHaveLength(0);
    });

    it("should handle UOW with only mutation operations", () => {
      const uow = createTestUOW();
      uow.create("users", {
        name: "Test User",
        email: "test@example.com",
      });

      const compiler = createDrizzleUOWCompiler(pool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(1);
    });
  });

  describe("default value generation", () => {
    // Create a schema with columns that have different types of defaults
    const defaultsSchema = schema((s) => {
      return s.addTable("logs", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("message", column("string"))
          .addColumn(
            "sessionId",
            column("string").defaultTo$((b) => b.cuid()),
          ) // runtime cuid
          .addColumn(
            "timestamp",
            column("timestamp").defaultTo$((b) => b.now()),
          ) // runtime now
          .addColumn("counter", column("integer").defaultTo$(42)) // runtime function
          .addColumn("status", column("string").defaultTo("pending")) // static default
          .createIndex("idx_session", ["sessionId"]);
      });
    });

    let defaultsDb: DBType;
    let defaultsPool: ConnectionPool<DBType>;

    beforeAll(async () => {
      // Write schema to file and dynamically import it
      const { schemaModule, cleanup } = await writeAndLoadSchema(
        "drizzle-uow-compiler-defaults",
        defaultsSchema,
        "postgresql",
      );

      // Create Drizzle instance with PGLite (in-memory Postgres)
      defaultsDb = drizzle({
        schema: schemaModule,
      }) as unknown as DBType;

      // Wrap in connection pool
      defaultsPool = createDrizzleConnectionPool(defaultsDb);

      return async () => {
        await cleanup();
      };
    }, 12000);

    it("should generate runtime defaults for missing columns", () => {
      const uow = createTestUOWWithSchema(defaultsSchema);
      // Only provide message, all other columns should get defaults
      uow.create("logs", {
        message: "Test log",
      });

      const compiler = createDrizzleUOWCompiler(defaultsPool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);

      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "logs" ("id", "message", "sessionId", "timestamp", "counter", "status", "_internalId", "_version") values ($1, $2, $3, $4, $5, default, default, default)"`,
      );

      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated ID
        "Test log",
        expect.any(String), // auto-generated sessionId
        expect.any(String), // auto-generated timestamp (serialized)
        42, // function-generated counter
      ]);
    });

    it("should not override user-provided values with defaults", () => {
      const uow = createTestUOWWithSchema(defaultsSchema);
      const customTimestamp = new Date("2024-01-01");
      // Provide all values explicitly
      uow.create("logs", {
        message: "Test log",
        sessionId: "custom-session-id",
        timestamp: customTimestamp,
        counter: 100,
        status: "active",
      });

      const compiler = createDrizzleUOWCompiler(defaultsPool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);

      // All user-provided values should be used, not defaults
      const params = batch.query.params;
      expect(params[1]).toBe("Test log");
      expect(params[2]).toBe("custom-session-id");
      expect(params[3]).toEqual(customTimestamp.toISOString()); // serialized to ISO string
      expect(params[4]).toBe(100);
      expect(params[5]).toBe("active");
    });

    it("should handle mix of provided and default values", () => {
      const uow = createTestUOWWithSchema(defaultsSchema);
      // Provide some values, let others use defaults
      uow.create("logs", {
        message: "Partial log",
        counter: 999, // override the function default
      });

      const compiler = createDrizzleUOWCompiler(defaultsPool, "postgresql");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);

      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated ID
        "Partial log",
        expect.any(String), // auto-generated sessionId
        expect.any(String), // auto-generated timestamp (serialized)
        999, // user-provided counter
      ]);
      // status should use DB default (omitted from INSERT)
    });

    it("should generate unique values for auto defaults across multiple creates", () => {
      const uow = createTestUOWWithSchema(defaultsSchema);
      uow.create("logs", { message: "Log 1" });
      uow.create("logs", { message: "Log 2" });
      uow.create("logs", { message: "Log 3" });

      const compiler = createDrizzleUOWCompiler(defaultsPool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.mutationBatch).toHaveLength(3);

      // Extract sessionId from each create
      const sessionIds = compiled.mutationBatch.map((batch) => {
        assert(batch);
        return batch.query.params[2]; // sessionId is 3rd param (after id, message)
      });

      // All sessionIds should be unique
      const uniqueSessionIds = new Set(sessionIds);
      expect(uniqueSessionIds.size).toBe(3);
    });
  });

  describe("nested joins", () => {
    // Create a schema that supports nested joins
    const nestedSchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"))
            .createIndex("idx_name", ["name"]);
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("userId", referenceColumn())
            .createIndex("idx_user", ["userId"]);
        })
        .addTable("comments", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("text", column("string"))
            .addColumn("postId", referenceColumn())
            .createIndex("idx_post", ["postId"]);
        })
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        })
        .addReference("post", {
          type: "one",
          from: { table: "comments", column: "postId" },
          to: { table: "posts", column: "id" },
        });
    });

    let nestedDb: DBType;
    let nestedPool: ConnectionPool<DBType>;

    beforeAll(async () => {
      // Write schema to file and dynamically import it
      const { schemaModule, cleanup } = await writeAndLoadSchema(
        "drizzle-uow-compiler-nested",
        nestedSchema,
        "postgresql",
      );

      // Create Drizzle instance with PGLite (in-memory Postgres)
      nestedDb = drizzle({
        schema: schemaModule,
      }) as unknown as DBType;

      // Wrap in connection pool
      nestedPool = createDrizzleConnectionPool(nestedDb);

      return async () => {
        await cleanup();
      };
    }, 20000);

    function createNestedUOW(name?: string) {
      const compiler = createDrizzleUOWCompiler(nestedPool, "postgresql");
      const mockExecutor = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
      };
      const mockDecoder: UOWDecoder<typeof nestedSchema> = (rawResults, operations) => {
        if (rawResults.length !== operations.length) {
          throw new Error("rawResults and ops must have the same length");
        }
        return rawResults;
      };
      return new UnitOfWork(compiler, mockExecutor, mockDecoder, name).forSchema(nestedSchema);
    }

    it("should compile nested joins (comments -> post -> author)", () => {
      const uow = createNestedUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb.post((postBuilder) =>
              postBuilder
                .select(["title"])
                .join((jb2) => jb2.author((authorBuilder) => authorBuilder.select(["name"]))),
            ),
          ),
      );

      const compiler = createDrizzleUOWCompiler(nestedPool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;

      // Should contain nested lateral joins
      expect(sql).toContain("left join lateral");
      // Should join comments -> post
      expect(sql).toContain('"comments_post"');
      // Should join post -> author within the first join
      expect(sql).toContain('"comments_post_author"');
      // Should have the nested structure with proper lateral joins
      expect(sql).toMatchInlineSnapshot(
        `"select "comments"."id", "comments"."text", "comments"."postId", "comments"."_internalId", "comments"."_version", "comments_post"."data" as "post" from "comments" "comments" left join lateral (select json_build_array("comments_post"."title", "comments_post"."_internalId", "comments_post"."_version", "comments_post_author"."data") as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."postId" limit $1) "comments_post" left join lateral (select json_build_array("comments_post_author"."name", "comments_post_author"."_internalId", "comments_post_author"."_version") as "data" from (select * from "users" "comments_post_author" where "comments_post_author"."_internalId" = "comments_post"."userId" limit $2) "comments_post_author") "comments_post_author" on true) "comments_post" on true"`,
      );
    });

    it("should compile nested joins with filtering at each level", () => {
      const uow = createNestedUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb.post((postBuilder) =>
              postBuilder
                .select(["title"])
                .join((jb2) =>
                  jb2.author((authorBuilder) =>
                    authorBuilder
                      .whereIndex("idx_name", (eb) => eb("name", "=", "Alice"))
                      .select(["name"]),
                  ),
                ),
            ),
          ),
      );

      const compiler = createDrizzleUOWCompiler(nestedPool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;

      // Should have WHERE clause in the nested author join
      expect(sql).toContain('"comments_post_author"."name" = $');
      expect(sql).toMatchInlineSnapshot(
        `"select "comments"."id", "comments"."text", "comments"."postId", "comments"."_internalId", "comments"."_version", "comments_post"."data" as "post" from "comments" "comments" left join lateral (select json_build_array("comments_post"."title", "comments_post"."_internalId", "comments_post"."_version", "comments_post_author"."data") as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."postId" limit $1) "comments_post" left join lateral (select json_build_array("comments_post_author"."name", "comments_post_author"."_internalId", "comments_post_author"."_version") as "data" from (select * from "users" "comments_post_author" where ("comments_post_author"."_internalId" = "comments_post"."userId" and "comments_post_author"."name" = $2) limit $3) "comments_post_author") "comments_post_author" on true) "comments_post" on true"`,
      );
    });

    it("should compile nested joins with ordering and limits at each level", () => {
      const uow = createNestedUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .pageSize(10)
          .join((jb) =>
            jb.post((postBuilder) =>
              postBuilder
                .select(["title"])
                .pageSize(1)
                .join((jb2) =>
                  jb2.author((authorBuilder) =>
                    authorBuilder.orderByIndex("idx_name", "asc").pageSize(1),
                  ),
                ),
            ),
          ),
      );

      const compiler = createDrizzleUOWCompiler(nestedPool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;

      // Should have limits at all levels and ordering in nested author join
      expect(sql).toContain('order by "comments_post_author"."name" asc');
      expect(sql).toMatchInlineSnapshot(
        `"select "comments"."id", "comments"."text", "comments"."postId", "comments"."_internalId", "comments"."_version", "comments_post"."data" as "post" from "comments" "comments" left join lateral (select json_build_array("comments_post"."title", "comments_post"."_internalId", "comments_post"."_version", "comments_post_author"."data") as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."postId" limit $1) "comments_post" left join lateral (select json_build_array("comments_post_author"."id", "comments_post_author"."name", "comments_post_author"."email", "comments_post_author"."_internalId", "comments_post_author"."_version") as "data" from (select * from "users" "comments_post_author" where "comments_post_author"."_internalId" = "comments_post"."userId" order by "comments_post_author"."name" asc limit $2) "comments_post_author") "comments_post_author" on true) "comments_post" on true limit $3"`,
      );
    });

    it("should compile multiple nested joins from same table", () => {
      const uow = createNestedUOW();
      uow.find("posts", (b) =>
        b.whereIndex("primary").join((jb) =>
          // Join to author with nested structure
          jb.author((authorBuilder) => authorBuilder.select(["name", "email"])),
        ),
      );

      const compiler = createDrizzleUOWCompiler(nestedPool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "posts"."id", "posts"."title", "posts"."userId", "posts"."_internalId", "posts"."_version", "posts_author"."data" as "author" from "posts" "posts" left join lateral (select json_build_array("posts_author"."name", "posts_author"."email", "posts_author"."_internalId", "posts_author"."_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit $1) "posts_author") "posts_author" on true"`,
      );
    });
  });

  describe("auth schema with session joins", () => {
    const authSchema = schema((s) => {
      return s
        .addTable("user", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .addColumn("passwordHash", column("string"))
            .addColumn(
              "createdAt",
              column("timestamp").defaultTo$((b) => b.now()),
            )
            .createIndex("idx_user_email", ["email"]);
        })
        .addTable("session", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("userId", referenceColumn())
            .addColumn("expiresAt", column("timestamp"))
            .addColumn(
              "createdAt",
              column("timestamp").defaultTo$((b) => b.now()),
            )
            .createIndex("idx_session_user", ["userId"]);
        })
        .addReference("sessionOwner", {
          from: {
            table: "session",
            column: "userId",
          },
          to: {
            table: "user",
            column: "id",
          },
          type: "one",
        });
    });

    let authDb: DBType;
    let authPool: ConnectionPool<DBType>;

    beforeAll(async () => {
      // Write schema to file and dynamically import it
      const { schemaModule, cleanup } = await writeAndLoadSchema(
        "drizzle-uow-compiler-auth",
        authSchema,
        "postgresql",
      );

      // Create Drizzle instance with PGLite (in-memory Postgres)
      authDb = drizzle({
        schema: schemaModule,
      }) as unknown as DBType;

      // Wrap in connection pool
      authPool = createDrizzleConnectionPool(authDb);

      return async () => {
        await cleanup();
      };
    }, 12000);

    function createAuthUOW(name?: string) {
      const compiler = createDrizzleUOWCompiler(authPool, "postgresql");
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
      return new UnitOfWork(compiler, mockExecutor, mockDecoder, name).forSchema(authSchema);
    }

    it("should compile find session with user join", () => {
      const uow = createAuthUOW();
      const sessionId = "session123";
      uow.find("session", (b) =>
        b
          .whereIndex("primary", (eb) => eb("id", "=", sessionId))
          .join((j) => j.sessionOwner((b) => b.select(["id", "email"]))),
      );

      const compiler = createDrizzleUOWCompiler(authPool, "postgresql");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "session"."id", "session"."userId", "session"."expiresAt", "session"."createdAt", "session"."_internalId", "session"."_version", "session_sessionOwner"."data" as "sessionOwner" from "session" "session" left join lateral (select json_build_array("session_sessionOwner"."id", "session_sessionOwner"."email", "session_sessionOwner"."_internalId", "session_sessionOwner"."_version") as "data" from (select * from "user" "session_sessionOwner" where "session_sessionOwner"."_internalId" = "session"."userId" limit $1) "session_sessionOwner") "session_sessionOwner" on true where "session"."id" = $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual([1, sessionId]);
    });

    it("should support creating and using ID in same UOW", () => {
      const uow = createAuthUOW("create-user-and-session");

      // Create user and capture the returned ID
      const userId = uow.create("user", {
        email: "test@example.com",
        passwordHash: "hashed_password",
      });

      // Use the returned FragnoId directly to create a session
      // The compiler should extract externalId and generate a subquery
      uow.create("session", {
        userId: userId,
        expiresAt: new Date("2025-12-31"),
      });

      const compiler = createDrizzleUOWCompiler(authPool, "postgresql");
      const compiled = uow.compile(compiler);

      // Should have no retrieval operations
      expect(compiled.retrievalBatch).toHaveLength(0);

      // Should have 2 mutation operations (create user, create session)
      expect(compiled.mutationBatch).toHaveLength(2);

      const [userCreate, sessionCreate] = compiled.mutationBatch;
      assert(userCreate);
      assert(sessionCreate);

      // Verify user create SQL
      expect(userCreate.query.sql).toMatchInlineSnapshot(
        `"insert into "user" ("id", "email", "passwordHash", "createdAt", "_internalId", "_version") values ($1, $2, $3, $4, default, default)"`,
      );
      expect(userCreate.query.params).toMatchObject([
        userId.externalId, // The generated ID
        "test@example.com",
        "hashed_password",
        expect.any(String), // timestamp
      ]);
      expect(userCreate.expectedAffectedRows).toBeNull();

      // Verify session create SQL - FragnoId generates subquery to lookup internal ID
      expect(sessionCreate.query.sql).toMatchInlineSnapshot(
        `"insert into "session" ("id", "userId", "expiresAt", "createdAt", "_internalId", "_version") values ($1, (select "_internalId" from "user" where "id" = $2 limit 1), $3, $4, default, default)"`,
      );
      expect(sessionCreate.query.params).toMatchObject([
        expect.any(String), // generated session ID
        userId.externalId, // FragnoId's externalId is used in the subquery
        expect.any(String), // expiresAt timestamp
        expect.any(String), // createdAt timestamp
      ]);
      expect(sessionCreate.expectedAffectedRows).toBeNull();

      // Verify the returned FragnoId has the expected structure
      expect(userId).toMatchObject({
        externalId: expect.any(String),
        version: 0,
        internalId: undefined,
      });
    });
  });
});
