import { assert, beforeAll, describe, expect, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "../../schema/create";
import { createDrizzleUOWCompiler } from "./drizzle-uow-compiler";
import type { DrizzleConfig } from "./drizzle-adapter";
import { drizzle } from "drizzle-orm/pglite";
import type { DBType } from "./shared";
import { UnitOfWork, type UOWDecoder } from "../../query/unit-of-work";
import { writeAndLoadSchema } from "./test-utils";

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
  let config: DrizzleConfig;

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

    config = {
      db,
      provider: "postgresql",
    };

    return async () => {
      await cleanup();
    };
  });

  function createTestUOW(name?: string) {
    const compiler = createDrizzleUOWCompiler(testSchema, config);
    const mockExecutor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({ success: true }),
    };
    const mockDecoder: UOWDecoder<typeof testSchema> = (rawResults, operations) => {
      if (rawResults.length !== operations.length) {
        throw new Error("rawResults and ops must have the same length");
      }
      return rawResults;
    };
    return new UnitOfWork(testSchema, compiler, mockExecutor, mockDecoder, name);
  }

  it("should create a compiler with the correct structure", () => {
    const compiler = createDrizzleUOWCompiler(testSchema, config);

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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" order by "users"."id" desc"`,
      );
    });

    it("should compile find operation with orderByIndex", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("idx_name").orderByIndex("idx_name", "desc"));

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select count(*) from "users" where "users"."name" like $1"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["John%"]);
    });

    it("should compile find operation with cursor pagination using after", () => {
      const uow = createTestUOW();
      const cursor = "eyJpbmRleFZhbHVlcyI6eyJuYW1lIjoiQWxpY2UifSwiZGlyZWN0aW9uIjoiZm9yd2FyZCJ9"; // {"indexValues":{"name":"Alice"},"direction":"forward"}
      uow.find("users", (b) =>
        b.whereIndex("idx_name").orderByIndex("idx_name", "asc").after(cursor).pageSize(10),
      );

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."name" > $1 order by "users"."name" asc limit $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["Alice", 10]);
    });

    it("should compile find operation with cursor pagination using before", () => {
      const uow = createTestUOW();
      const cursor = "eyJpbmRleFZhbHVlcyI6eyJuYW1lIjoiQm9iIn0sImRpcmVjdGlvbiI6ImJhY2t3YXJkIn0="; // {"indexValues":{"name":"Bob"},"direction":"backward"}
      uow.find("users", (b) =>
        b.whereIndex("idx_name").orderByIndex("idx_name", "desc").before(cursor).pageSize(10),
      );

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" where "users"."name" > $1 order by "users"."name" desc limit $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual(["Bob", 10]);
    });

    it("should compile find operation with cursor pagination and additional where conditions", () => {
      const uow = createTestUOW();
      const cursor = "eyJpbmRleFZhbHVlcyI6eyJuYW1lIjoiQWxpY2UifSwiZGlyZWN0aW9uIjoiZm9yd2FyZCJ9";
      uow.find("users", (b) =>
        b
          .whereIndex("idx_name", (eb) => eb("name", "starts with", "John"))
          .orderByIndex("idx_name", "asc")
          .after(cursor)
          .pageSize(5),
      );

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_internalId", "_version") values ($1, $2, $3, $4, default, $5)"`,
      );
      // params include auto-generated ID (first param), then the provided values, then version (0)
      expect(batch.query.params).toMatchObject([
        expect.any(String),
        "John Doe",
        "john@example.com",
        30,
        0, // version
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [createBatch, updateBatch, deleteBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(3);

      assert(createBatch);
      expect(createBatch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_internalId", "_version") values ($1, $2, $3, default, default, $4)"`,
      );
      expect(createBatch.query.params).toMatchObject([
        expect.any(String),
        "Alice",
        "alice@example.com",
        0, // version
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      // When condition is false, the operation should return null and not be added to batch
      expect(compiled.retrievalBatch).toHaveLength(0);
    });

    it("should handle always-true conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => true));

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(0);
    });

    it("should handle UOW with only retrieval operations", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary"));

      const compiler = createDrizzleUOWCompiler(testSchema, config);
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

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(1);
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
    let nestedConfig: DrizzleConfig;

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

      nestedConfig = {
        db: nestedDb,
        provider: "postgresql",
      };

      return async () => {
        await cleanup();
      };
    });

    function createNestedUOW(name?: string) {
      const compiler = createDrizzleUOWCompiler(nestedSchema, nestedConfig);
      const mockExecutor = {
        executeRetrievalPhase: async () => [],
        executeMutationPhase: async () => ({ success: true }),
      };
      const mockDecoder: UOWDecoder<typeof nestedSchema> = (rawResults, operations) => {
        if (rawResults.length !== operations.length) {
          throw new Error("rawResults and ops must have the same length");
        }
        return rawResults;
      };
      return new UnitOfWork(nestedSchema, compiler, mockExecutor, mockDecoder, name);
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

      const compiler = createDrizzleUOWCompiler(nestedSchema, nestedConfig);
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

      const compiler = createDrizzleUOWCompiler(nestedSchema, nestedConfig);
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

      const compiler = createDrizzleUOWCompiler(nestedSchema, nestedConfig);
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

      const compiler = createDrizzleUOWCompiler(nestedSchema, nestedConfig);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const sql = compiled.retrievalBatch[0].sql;
      expect(sql).toMatchInlineSnapshot(
        `"select "posts"."id", "posts"."title", "posts"."userId", "posts"."_internalId", "posts"."_version", "posts_author"."data" as "author" from "posts" "posts" left join lateral (select json_build_array("posts_author"."name", "posts_author"."email", "posts_author"."_internalId", "posts_author"."_version") as "data" from (select * from "users" "posts_author" where "posts_author"."_internalId" = "posts"."userId" limit $1) "posts_author") "posts_author" on true"`,
      );
    });
  });
});
