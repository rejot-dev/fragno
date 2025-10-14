import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "../../schema/create";
import { createDrizzleUOWCompiler } from "./drizzle-uow-compiler";
import type { DrizzleConfig } from "./drizzle-adapter";
import { generateSchema } from "./generate";
import { join } from "node:path";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import type { DBType } from "./shared";
import { UnitOfWork, type UOWDecoder } from "../../query/unit-of-work";

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
      .addReference("posts", "author", {
        columns: ["userId"],
        targetTable: "users",
        targetColumns: ["id"],
      });
  });

  let schemaFilePath: string;
  let db: DBType;
  let config: DrizzleConfig;
  const tmpDir = join(import.meta.dirname, "_generated");

  beforeAll(async () => {
    // Create tmp directory
    await mkdir(tmpDir, { recursive: true });

    // Generate schema file path
    schemaFilePath = join(tmpDir, `test-uow-schema-${Date.now()}.ts`);

    // Generate and write the Drizzle schema to file (using PostgreSQL)
    const drizzleSchemaTs = generateSchema(testSchema, "postgresql");
    await writeFile(schemaFilePath, drizzleSchemaTs, "utf-8");

    // Dynamically import the generated schema
    const schemaModule = await import(schemaFilePath);

    // Create Drizzle instance with PGLite (in-memory Postgres)
    db = drizzle({
      schema: schemaModule,
    }) as unknown as DBType;

    config = {
      db,
      provider: "postgresql",
    };
  });

  afterAll(async () => {
    // Clean up the temp directory
    await rm(tmpDir, { recursive: true, force: true });
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

    it("should compile find operation with limit and offset", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").limit(10).offset(5));

      const compiler = createDrizzleUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "id", "name", "email", "age", "_internalId", "_version" from "users" "users" limit $1 offset $2"`,
      );
      expect(compiled.retrievalBatch[0].params).toEqual([10, 5]);
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
});
