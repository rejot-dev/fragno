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
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
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
      "drizzle-uow-compiler-sqlite",
      testSchema,
      "sqlite",
    );

    // Create Drizzle instance with libsql (in-memory SQLite)
    const client = createClient({
      url: ":memory:",
    });
    db = drizzle({ client, schema: schemaModule }) as unknown as DBType;

    // Wrap in connection pool
    pool = createDrizzleConnectionPool(db);

    return async () => {
      await cleanup();
    };
  });

  function createTestUOWWithSchema<const T extends AnySchema>(schema: T) {
    const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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
    const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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
    const uow = new UnitOfWork(compiler, mockExecutor, mockDecoder, name).forSchema(testSchema);

    return uow;
  }

  it("should create a compiler with the correct structure", () => {
    const compiler = createDrizzleUOWCompiler(pool, "sqlite");

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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."email" = ?"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["test@example.com"]);
    });

    it("should compile find operation with select clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_name", (eb) => eb("name", "=", "Alice")).select(["id", "name"]),
      );

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "_internalId", "_version" from "users" "users" where "users"."name" = ?"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["Alice"]);
    });

    it("should compile find operation with pageSize", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").pageSize(10));

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" limit ?"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual([10]);
    });

    it("should compile find operation with orderByIndex on primary index", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").orderByIndex("primary", "desc"));

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" order by "users"."id" desc"`,
      );
    });

    it("should compile find operation with orderByIndex", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("idx_name").orderByIndex("idx_name", "desc"));

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(2);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."email" = ?"`,
      );
      expect(compiled.retrievalBatch[1].sql).toMatchInlineSnapshot(
        `"select "id", "title", "content", "userId", "viewCount", "_internalId", "_version" from "posts" "posts" where "posts"."title" like ?"`,
      );
    });

    it("should compile find operation with selectCount", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").selectCount());

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select count(*) from "users" where "users"."name" like ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."name" > ? order by "users"."name" asc limit ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."name" > ? order by "users"."name" desc limit ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where ("users"."name" like ? and "users"."name" > ?) order by "users"."name" asc limit ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      // This should generate SQL that joins posts with users and selects author name and email
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "title", "content", "userId", "viewCount", "_internalId", "_version", (select json_array("id", "name", "email", "age", "_internalId", "_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit ?) "posts_author") as "author" from "posts" "posts" where "posts"."title" like ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "id", "title", "content", "userId", "viewCount", "_internalId", "_version", (select json_array("name", "_internalId", "_version") as "data" from (select * from "users" "posts_author" where ("posts_author"."_internalId" = "posts"."userId" and "posts_author"."name" = ?) limit ?) "posts_author") as "author" from "posts" "posts""`,
      );
    });

    it("should compile find operation with join ordering", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb.author((builder) => builder.orderByIndex("idx_name", "desc"))),
      );

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "id", "title", "content", "userId", "viewCount", "_internalId", "_version", (select json_array("id", "name", "email", "age", "_internalId", "_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" order by "posts_author"."name" desc limit ?) "posts_author") as "author" from "posts" "posts""`,
      );
    });

    it("should compile find operation with join pageSize", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b.whereIndex("primary").join((jb) => jb.author((builder) => builder.pageSize(5))),
      );

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      // Should have limit in the joined query
      expect(sql).toMatchInlineSnapshot(
        `"select "id", "title", "content", "userId", "viewCount", "_internalId", "_version", (select json_array("id", "name", "email", "age", "_internalId", "_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit ?) "posts_author") as "author" from "posts" "posts""`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_internalId", "_version") values (?, ?, ?, ?, null, ?)"`,
      );
      expect(batch.query.params).toMatchObject([
        expect.any(String),
        "John Doe",
        "john@example.com",
        30,
        0, // _version default
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId", "viewCount", "_internalId", "_version") values (?, ?, ?, (select "_internalId" from "users" where "id" = ? limit 1), ?, null, ?)"`,
      );
      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated post ID
        "Test Post",
        "Post content",
        "user_external_id_123", // external id string
        5, // viewCount
        0, // _version default
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should NOT have a subquery when using bigint directly
      expect(batch.query.sql).not.toMatch(/\(select.*from.*users/i);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId", "viewCount", "_internalId", "_version") values (?, ?, ?, ?, ?, null, ?)"`,
      );
      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated post ID
        "Direct ID Post",
        "Content with direct bigint",
        12345n, // bigint stays as bigint for Drizzle (Drizzle handles conversion)
        0, // viewCount default
        0, // _version default
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // FragnoId should generate a subquery to lookup the internal ID from external ID
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId", "viewCount", "_internalId", "_version") values (?, ?, ?, (select "_internalId" from "users" where "id" = ? limit 1), ?, null, ?)"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should generate a subquery for the string external ID in UPDATE
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = (select "_internalId" from "users" where "id" = ? limit 1), "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should NOT have a subquery when using bigint directly
      expect(batch.query.sql).not.toMatch(/\(select.*from.*users/i);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = ?, "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = ?"`,
      );
      expect(batch.query.params).toMatchObject([
        99999n, // bigint stays as bigint for Drizzle (Drizzle handles conversion)
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = ?, "age" = ?, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = ?"`,
      );
      expect(batch.query.params).toMatchObject(["Jane Doe", 25, "user123"]);
    });

    it("should compile update operation with version check", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 5);
      uow.update("users", userId, (b) => b.set({ age: 18 }).check());

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = ?, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
      );
      expect(batch.query.params).toMatchObject([18, "user123", 5]);
    });

    it("should compile delete operation with ID", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 0);
      uow.delete("users", userId);

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(`"delete from "users" where "users"."id" = ?"`);
      expect(batch.query.params).toMatchObject(["user123"]);
    });

    it("should compile delete operation with version check", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 3);
      uow.delete("users", userId, (b) => b.check());

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = ? and "users"."_version" = ?)"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = ?, "age" = ?, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = ?"`,
      );
      expect(batch.query.params).toMatchObject(["Jane Doe", 25, "user123"]);
    });

    it("should compile delete operation with string ID", () => {
      const uow = createTestUOW();
      uow.delete("users", "user123");

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(`"delete from "users" where "users"."id" = ?"`);
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [createBatch, updateBatch, deleteBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(3);

      assert(createBatch);
      expect(createBatch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_internalId", "_version") values (?, ?, ?, null, null, ?)"`,
      );
      expect(createBatch.query.params).toMatchObject([
        expect.any(String), // auto-generated ID
        "Alice",
        "alice@example.com",
        0, // _version default
      ]);

      assert(updateBatch);
      expect(updateBatch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "viewCount" = ?, "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = ?"`,
      );

      assert(deleteBatch);
      expect(deleteBatch.query.sql).toMatchInlineSnapshot(
        `"delete from "posts" where "posts"."id" = ?"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.name).toBe("update-user-balance");
      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.mutationBatch).toHaveLength(1);

      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."id" = ?"`,
      );

      // Update should include version check in WHERE clause
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = ?, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where ("users"."email" like ? and ("users"."name" = ? or "users"."name" = ?))"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["%@example.com%", "Alice", "Bob"]);
    });

    it("should return null for operations with always-false conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => false));

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      // When condition is false, the operation should return null and not be added to batch
      expect(compiled.retrievalBatch).toHaveLength(0);
    });

    it("should handle always-true conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => true));

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = ?, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
      );
      expect(batch.query.params).toMatchObject([31, "user123", 5]);
    });

    it("should embed version check in delete WHERE clause", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user456", 3);
      uow.delete("users", userId, (b) => b.check());

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = ? and "users"."_version" = ?)"`,
      );
      expect(batch.query.params).toMatchObject(["user456", 3]);
    });

    it("should handle version checks on different tables", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user1", 2);
      const postId = FragnoId.fromExternal("post1", 1);

      uow.update("users", userId, (b) => b.set({ age: 30 }).check());
      uow.update("posts", postId, (b) => b.set({ viewCount: 100 }).check());

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [userBatch, postBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(2);

      assert(userBatch);
      expect(userBatch.expectedAffectedRows).toBe(1);
      expect(userBatch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = ?, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
      );
      expect(userBatch.query.params).toMatchObject([30, "user1", 2]);

      assert(postBatch);
      expect(postBatch.expectedAffectedRows).toBe(1);
      expect(postBatch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "viewCount" = ?, "_version" = COALESCE(_version, 0) + 1 where ("posts"."id" = ? and "posts"."_version" = ?)"`,
      );
      expect(postBatch.query.params).toMatchObject([100, "post1", 1]);
    });

    it("should not affect updates without version checks", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user1", 0);
      uow.update("users", userId, (b) => b.set({ age: 25 }));

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      // Should be normal update without version check
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = ?, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = ?"`,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle UOW with no operations", () => {
      const uow = createTestUOW();

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(0);
    });

    it("should handle UOW with only retrieval operations", () => {
      const uow = createTestUOW();
      uow.find("users");

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
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
        "sqlite",
      );

      // Create Drizzle instance with libsql (in-memory SQLite)
      const defaultsClient = createClient({
        url: ":memory:",
      });
      defaultsDb = drizzle({ client: defaultsClient, schema: schemaModule }) as unknown as DBType;

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

      const compiler = createDrizzleUOWCompiler(defaultsPool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);

      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "logs" ("id", "message", "sessionId", "timestamp", "counter", "status", "_internalId", "_version") values (?, ?, ?, ?, ?, ?, null, ?)"`,
      );

      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated ID
        "Test log",
        expect.any(String), // auto-generated sessionId
        expect.any(Number), // auto-generated timestamp (Drizzle serializes Date to Unix timestamp)
        42, // function-generated counter
        "pending", // status default
        0, // _version default
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

      const compiler = createDrizzleUOWCompiler(defaultsPool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);

      // All user-provided values should be used, not defaults
      const params = batch.query.params;
      expect(params[1]).toBe("Test log");
      expect(params[2]).toBe("custom-session-id");
      expect(params[3]).toBe(customTimestamp.getTime() / 1000); // Drizzle converts Date to Unix timestamp (seconds)
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

      const compiler = createDrizzleUOWCompiler(defaultsPool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);

      expect(batch.query.params).toMatchObject([
        expect.any(String), // auto-generated ID
        "Partial log",
        expect.any(String), // auto-generated sessionId
        expect.any(Number), // auto-generated timestamp (Drizzle converts Date to Unix timestamp)
        999, // user-provided counter
        expect.any(String), // status default
        0, // _version default
      ]);
      // All defaults are included in the INSERT for SQLite
    });

    it("should generate unique values for auto defaults across multiple creates", () => {
      const uow = createTestUOWWithSchema(defaultsSchema);
      uow.create("logs", { message: "Log 1" });
      uow.create("logs", { message: "Log 2" });
      uow.create("logs", { message: "Log 3" });

      const compiler = createDrizzleUOWCompiler(defaultsPool, "sqlite");
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
        "sqlite",
      );

      // Create Drizzle instance with libsql (in-memory SQLite)
      const nestedClient = createClient({
        url: ":memory:",
      });
      nestedDb = drizzle({ client: nestedClient, schema: schemaModule }) as unknown as DBType;

      // Wrap in connection pool
      nestedPool = createDrizzleConnectionPool(nestedDb);

      return async () => {
        await cleanup();
      };
    }, 20000);

    function createNestedUOW(name?: string) {
      const compiler = createDrizzleUOWCompiler(nestedPool, "sqlite");
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

      const compiler = createDrizzleUOWCompiler(nestedPool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;

      // Should contain nested lateral joins

      // Should join comments -> post

      // Should join post -> author within the first join

      // Should have the nested structure with proper lateral joins
      expect(sql).toMatchInlineSnapshot(
        `"select "id", "text", "postId", "_internalId", "_version", (select json_array("title", "_internalId", "_version", (select json_array("name", "_internalId", "_version") as "data" from (select * from "users" "comments_post_author" where "comments_post_author"."_internalId" = "comments_post"."userId" limit ?) "comments_post_author")) as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."postId" limit ?) "comments_post") as "post" from "comments" "comments""`,
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

      const compiler = createDrizzleUOWCompiler(nestedPool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;

      // Should have WHERE clause in the nested author join

      expect(sql).toMatchInlineSnapshot(
        `"select "id", "text", "postId", "_internalId", "_version", (select json_array("title", "_internalId", "_version", (select json_array("name", "_internalId", "_version") as "data" from (select * from "users" "comments_post_author" where ("comments_post_author"."_internalId" = "comments_post"."userId" and "comments_post_author"."name" = ?) limit ?) "comments_post_author")) as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."postId" limit ?) "comments_post") as "post" from "comments" "comments""`,
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

      const compiler = createDrizzleUOWCompiler(nestedPool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;

      // Should have limits at all levels and ordering in nested author join

      expect(sql).toMatchInlineSnapshot(
        `"select "id", "text", "postId", "_internalId", "_version", (select json_array("title", "_internalId", "_version", (select json_array("id", "name", "email", "_internalId", "_version") as "data" from (select * from "users" "comments_post_author" where "comments_post_author"."_internalId" = "comments_post"."userId" order by "comments_post_author"."name" asc limit ?) "comments_post_author")) as "data" from (select * from "posts" "comments_post" where "comments_post"."_internalId" = "comments"."postId" limit ?) "comments_post") as "post" from "comments" "comments" limit ?"`,
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

      const compiler = createDrizzleUOWCompiler(nestedPool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "id", "title", "userId", "_internalId", "_version", (select json_array("name", "email", "_internalId", "_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit ?) "posts_author") as "author" from "posts" "posts""`,
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
        "sqlite",
      );

      // Create Drizzle instance with libsql (in-memory SQLite)
      const authClient = createClient({
        url: ":memory:",
      });
      authDb = drizzle({ client: authClient, schema: schemaModule }) as unknown as DBType;

      // Wrap in connection pool
      authPool = createDrizzleConnectionPool(authDb);

      return async () => {
        await cleanup();
      };
    }, 12000);

    function createAuthUOW(name?: string) {
      const compiler = createDrizzleUOWCompiler(authPool, "sqlite");
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

      const compiler = createDrizzleUOWCompiler(authPool, "sqlite");
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "userId", "expiresAt", "createdAt", "_internalId", "_version", (select json_array("id", "email", "_internalId", "_version") as "data" from (select * from "user" "session_sessionOwner" where "session_sessionOwner"."_internalId" = "session"."userId" limit ?) "session_sessionOwner") as "sessionOwner" from "session" "session" where "session"."id" = ?"`,
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

      const compiler = createDrizzleUOWCompiler(authPool, "sqlite");
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
        `"insert into "user" ("id", "email", "passwordHash", "createdAt", "_internalId", "_version") values (?, ?, ?, ?, null, ?)"`,
      );
      expect(userCreate.query.params).toMatchObject([
        userId.externalId, // The generated ID
        "test@example.com",
        "hashed_password",
        expect.any(Number), // timestamp (Drizzle converts Date to Unix timestamp)
        0, // _version default
      ]);
      expect(userCreate.expectedAffectedRows).toBeNull();

      // Verify session create SQL - FragnoId generates subquery to lookup internal ID
      expect(sessionCreate.query.sql).toMatchInlineSnapshot(
        `"insert into "session" ("id", "userId", "expiresAt", "createdAt", "_internalId", "_version") values (?, (select "_internalId" from "user" where "id" = ? limit 1), ?, ?, null, ?)"`,
      );
      expect(sessionCreate.query.params).toMatchObject([
        expect.any(String), // generated session ID
        userId.externalId, // FragnoId's externalId is used in the subquery
        expect.any(Number), // expiresAt timestamp (Drizzle converts Date to Unix timestamp)
        expect.any(Number), // createdAt timestamp (Drizzle converts Date to Unix timestamp)
        0, // _version default
      ]);
      expect(sessionCreate.expectedAffectedRows).toBeNull();

      // Verify the returned FragnoId has the expected structure
      expect(userId).toMatchObject({
        externalId: expect.any(String),
        version: 0,
        internalId: undefined,
      });
    });

    it("should compile check operation", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 5);
      uow.check("users", userId);

      const compiler = createDrizzleUOWCompiler(pool, "sqlite");
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(null);
      expect(batch.expectedReturnedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"select 1 as "exists" from "users" where ("users"."id" = ? and "users"."_version" = ?) limit ?"`,
      );
      expect(batch.query.params).toMatchObject(["user123", 5, 1]);
    });
  });
});
