import { Kysely, PostgresDialect } from "kysely";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "../../schema/create";
import { UnitOfWork, type UOWDecoder } from "../../query/unit-of-work";
import { createKyselyUOWCompiler } from "./kysely-uow-compiler";
import type { KyselyConfig } from "./kysely-adapter";

describe("kysely-uow-compiler", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("invitedBy", referenceColumn().nullable())
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name", ["name"])
          .createIndex("idx_age", ["age"]);
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
      .addTable("comments", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("content", column("string"))
          .addColumn("postId", referenceColumn())
          .addColumn("authorId", referenceColumn())
          .createIndex("idx_post", ["postId"])
          .createIndex("idx_author", ["authorId"]);
      })
      .addTable("tags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .createIndex("idx_name", ["name"]);
      })
      .addTable("post_tags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("postId", referenceColumn())
          .addColumn("tagId", referenceColumn())
          .createIndex("idx_post", ["postId"])
          .createIndex("idx_tag", ["tagId"]);
      })
      .addReference("posts", "author", {
        columns: ["userId"],
        targetTable: "users",
        targetColumns: ["id"],
      })
      .addReference("users", "inviter", {
        columns: ["invitedBy"],
        targetTable: "users",
        targetColumns: ["id"],
      })
      .addReference("comments", "post", {
        columns: ["postId"],
        targetTable: "posts",
        targetColumns: ["id"],
      })
      .addReference("comments", "author", {
        columns: ["authorId"],
        targetTable: "users",
        targetColumns: ["id"],
      })
      .addReference("post_tags", "post", {
        columns: ["postId"],
        targetTable: "posts",
        targetColumns: ["id"],
      })
      .addReference("post_tags", "tag", {
        columns: ["tagId"],
        targetTable: "tags",
        targetColumns: ["id"],
      });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let config: KyselyConfig;

  beforeAll(() => {
    // Create a mock Kysely instance (we won't execute queries, just compile them)
    // We need a minimal pool that won't actually connect
    const mockPool = {
      connect: () => Promise.reject(new Error("Mock pool - no actual connections")),
      end: () => Promise.resolve(),
      on: () => {},
    };

    kysely = new Kysely({
      dialect: new PostgresDialect({
        // Safe: we're only compiling queries, not executing them
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: mockPool as any,
      }),
    });

    config = {
      db: kysely,
      provider: "postgresql",
    };
  });

  // Helper to create UnitOfWork for testing
  function createTestUOW(name?: string) {
    const mockCompiler = createKyselyUOWCompiler(testSchema, config);
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
    // Pass undefined for decoder since we're only testing compilation, not execution
    return new UnitOfWork(testSchema, mockCompiler, mockExecutor, mockDecoder, name);
  }

  describe("compileRetrievalOperation", () => {
    it("should compile find operation with where clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_email", (eb) => eb("email", "=", "test@example.com")),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."email" = $1"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual(["test@example.com"]);
    });

    it("should compile find operation with select clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_name", (eb) => eb("name", "=", "Alice")).select(["id", "name"]),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."name" = $1"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual(["Alice"]);
    });

    it("should compile find operation with pageSize", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").pageSize(10));

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit $1"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual([10]);
    });

    it("should compile find operation with orderByIndex on primary index", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary").orderByIndex("primary", "desc"));

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."id" desc"`,
      );
    });

    it("should compile find operation with orderByIndex", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("idx_name").orderByIndex("idx_name", "desc"));

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."name" desc"`,
      );
    });

    it("should compile multiple find operations", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("idx_email", (eb) => eb("email", "=", "user1@example.com")),
      );
      uow.find("posts", (b) => b.whereIndex("idx_title", (eb) => eb("title", "contains", "test")));

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(2);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."email" = $1"`,
      );
      expect(compiled.retrievalBatch[1].sql).toMatchInlineSnapshot(
        `"select "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" where "posts"."title" like $1"`,
      );
    });

    it("should compile find operation with selectCount", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => {
        b.whereIndex("primary").selectCount();
        return b;
      });

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select count(*) as "count" from "users""`,
      );
    });

    it("should compile find operation with selectCount and where clause", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("idx_age", (eb) => eb("age", ">", 25)).selectCount());

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select count(*) as "count" from "users" where "users"."age" > $1"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual([25]);
    });

    it("should compile find operation with cursor pagination using after", () => {
      const uow = createTestUOW();
      const cursor = "eyJpbmRleFZhbHVlcyI6eyJuYW1lIjoiQWxpY2UifSwiZGlyZWN0aW9uIjoiZm9yd2FyZCJ9"; // {"indexValues":{"name":"Alice"},"direction":"forward"}
      uow.find("users", (b) =>
        b.whereIndex("idx_name").orderByIndex("idx_name", "asc").after(cursor).pageSize(10),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."name" > $1 order by "users"."name" asc limit $2"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual(["Alice", 10]);
    });

    it("should compile find operation with cursor pagination using before", () => {
      const uow = createTestUOW();
      const cursor = "eyJpbmRleFZhbHVlcyI6eyJuYW1lIjoiQm9iIn0sImRpcmVjdGlvbiI6ImJhY2t3YXJkIn0="; // {"indexValues":{"name":"Bob"},"direction":"backward"}
      uow.find("users", (b) =>
        b.whereIndex("idx_name").orderByIndex("idx_name", "desc").before(cursor).pageSize(10),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."name" > $1 order by "users"."name" desc limit $2"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual(["Bob", 10]);
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."name" like $1 and "users"."name" > $2) order by "users"."name" asc limit $3"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual(["John%", "Alice", 5]);
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age", "_version") values ($1, $2, $3, $4, $5) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
      );
      // Parameters include auto-generated ID (first param), then the provided values, then version
      expect(batch.query.parameters).toMatchObject([
        expect.any(String),
        "John Doe",
        "john@example.com",
        30,
        0,
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = $1, "age" = $2, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = $3"`,
      );
      expect(batch.query.parameters).toMatchObject(["Jane Doe", 25, "user123"]);
    });

    it("should compile update operation with version check", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 5);
      uow.update("users", userId, (b) => b.set({ age: 18 }).check());

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
      expect(batch.query.parameters).toMatchObject([18, "user123", 5]);
    });

    it("should compile delete operation with ID", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 0);
      uow.delete("users", userId);

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where "users"."id" = $1"`,
      );
      expect(batch.query.parameters).toMatchObject(["user123"]);
    });

    it("should compile delete operation with version check", () => {
      const uow = createTestUOW();
      const userId = FragnoId.fromExternal("user123", 3);
      uow.delete("users", userId, (b) => b.check());

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = $1 and "users"."_version" = $2)"`,
      );
      expect(batch.query.parameters).toMatchObject(["user123", 3]);
    });

    it("should compile update operation with string ID", () => {
      const uow = createTestUOW();
      uow.update("users", "user123", (b) =>
        b.set({
          name: "Jane Doe",
          age: 25,
        }),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = $1, "age" = $2, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = $3"`,
      );
      expect(batch.query.parameters).toMatchObject(["Jane Doe", 25, "user123"]);
    });

    it("should compile delete operation with string ID", () => {
      const uow = createTestUOW();
      uow.delete("users", "user123");

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBeNull();
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where "users"."id" = $1"`,
      );
      expect(batch.query.parameters).toMatchObject(["user123"]);
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [createBatch, updateBatch, deleteBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(3);

      assert(createBatch);
      expect(createBatch.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "_version") values ($1, $2, $3, $4) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
      );
      expect(createBatch.query.parameters).toMatchObject([
        expect.any(String),
        "Alice",
        "alice@example.com",
        0,
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.name).toBe("update-user-balance");
      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.mutationBatch).toHaveLength(1);

      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."id" = $1"`,
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."email" like $1 and ("users"."name" = $2 or "users"."name" = $3))"`,
      );
      expect(compiled.retrievalBatch[0].parameters).toEqual(["%@example.com%", "Alice", "Bob"]);
    });

    it("should return null for operations with always-false conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => false));

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      // When condition is false, the operation should return null and not be added to batch
      expect(compiled.retrievalBatch).toHaveLength(0);
    });

    it("should handle always-true conditions", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary", () => true));

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      expect(compiled.retrievalBatch[0].sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
      );
    });
  });

  describe("version checking", () => {
    it("should embed version check in update WHERE clause", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user123", 5);
      uow.update("users", userId, (b) => b.set({ age: 31 }).check());

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
      expect(batch.query.parameters).toMatchObject([31, "user123", 5]);
    });

    it("should embed version check in delete WHERE clause", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user456", 3);
      uow.delete("users", userId, (b) => b.check());

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [batch] = compiled.mutationBatch;
      assert(batch);
      expect(batch.expectedAffectedRows).toBe(1);
      expect(batch.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = $1 and "users"."_version" = $2)"`,
      );
      expect(batch.query.parameters).toMatchObject(["user456", 3]);
    });

    it("should handle version checks on different tables", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user1", 2);
      const postId = FragnoId.fromExternal("post1", 1);

      uow.update("users", userId, (b) => b.set({ age: 30 }).check());
      uow.update("posts", postId, (b) => b.set({ viewCount: 100 }).check());

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);
      const [userBatch, postBatch] = compiled.mutationBatch;

      expect(compiled.mutationBatch).toHaveLength(2);

      assert(userBatch);
      expect(userBatch.expectedAffectedRows).toBe(1);
      expect(userBatch.query.sql).toMatchInlineSnapshot(
        `"update "users" set "age" = $1, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = $2 and "users"."_version" = $3)"`,
      );
      expect(userBatch.query.parameters).toMatchObject([30, "user1", 2]);

      assert(postBatch);
      expect(postBatch.expectedAffectedRows).toBe(1);
      expect(postBatch.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "viewCount" = $1, "_version" = COALESCE(_version, 0) + 1 where ("posts"."id" = $2 and "posts"."_version" = $3)"`,
      );
      expect(postBatch.query.parameters).toMatchObject([100, "post1", 1]);
    });

    it("should not affect updates without version checks", () => {
      const uow = createTestUOW();

      const userId = FragnoId.fromExternal("user1", 0);
      uow.update("users", userId, (b) => b.set({ age: 25 }));

      const compiler = createKyselyUOWCompiler(testSchema, config);
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

  describe("join operations", () => {
    it("should compile find operation with basic join", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b.whereIndex("primary").join((jb) => jb.author((ab) => ab.select(["name", "email"]))),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain("left join");
      expect(query.sql).toContain('"users" as "author"');
      expect(query.sql).toContain('"author"."name"');
      expect(query.sql).toContain('"author"."email"');
    });

    it("should compile join with whereIndex filtering", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb.author((ab) =>
              ab.select(["name"]).whereIndex("idx_name", (eb) => eb("name", "=", "Alice")),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain("left join");
      expect(query.sql).toContain('"users"."name" = $1');
      expect(query.parameters).toContain("Alice");
    });

    it("should compile join with orderByIndex", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb.author((ab) => ab.select(["name"]).orderByIndex("idx_name", "desc"))),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain("left join");
      expect(query.sql).toContain('"users" as "author"');
    });

    it("should compile join with pageSize", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b.whereIndex("primary").join((jb) => jb.author((ab) => ab.select(["name"]).pageSize(5))),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain("left join");
    });

    it("should compile nested joins", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b.whereIndex("primary").join((jb) =>
          jb.author((ab) =>
            // FIXME: inviter should be strongly typed
            ab.select(["name"]).join((jb2) => {
              // type Prettify<T> = {
              //   [K in keyof T]: T[K];
              // } & {};

              // type InviterFn = Prettify<(typeof jb2)["inviter"]>;
              // expectTypeOf<InviterFn>().toEqualTypeOf<{ [x: string]: any }>();
              // type BuilderKeys = Prettify<keyof typeof jb2>;
              // expectTypeOf<BuilderKeys>().toEqualTypeOf<string | symbol | number>();

              return jb2["inviter"]((ib) => ib.select(["name"]));
            }),
          ),
        ),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author_inviter"."name" as "author:inviter:name", "author_inviter"."_internalId" as "author:inviter:_internalId", "author_inviter"."_version" as "author:inviter:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId" left join "users" as "author_inviter" on "author"."invitedBy" = "author_inviter"."_internalId""`,
      );
    });

    it("should compile multiple joins", () => {
      const uow = createTestUOW();
      uow.find("comments", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb.post((pb) => pb.select(["title"])).author((ab) => ab.select(["name"]))),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"posts" as "post"');
      expect(query.sql).toContain('"users" as "author"');
      expect(query.sql).toContain('"post"."title"');
      expect(query.sql).toContain('"author"."name"');
    });

    it("should compile self-referencing join", () => {
      const uow = createTestUOW();
      uow.find("users", (b) =>
        b.whereIndex("primary").join((jb) => jb.inviter((ib) => ib.select(["name", "email"]))),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toContain('"users" as "inviter"');
      expect(query.sql).toContain('"inviter"."name"');
      expect(query.sql).toContain('"inviter"."email"');
    });

    it("should compile join with all builder features combined", () => {
      const uow = createTestUOW();
      uow.find("posts", (b) =>
        b
          .whereIndex("idx_title", (eb) => eb("title", "contains", "test"))
          .select(["id", "title"])
          .orderByIndex("idx_title", "asc")
          .pageSize(10)
          .join((jb) =>
            jb.author((ab) =>
              ab
                .select(["name", "email"])
                .whereIndex("idx_name", (eb) => eb("name", "starts with", "A"))
                .orderByIndex("idx_name", "desc")
                .pageSize(5),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      // Main query features
      expect(query.sql).toContain('"posts"."title" like');
      expect(query.sql).toContain("order by");
      expect(query.sql).toContain("limit");
      // Join features
      expect(query.sql).toContain('"users" as "author"');
      expect(query.sql).toContain('"users"."name" like');
    });

    it("should compile many-to-many join through junction table", () => {
      const uow = createTestUOW();
      uow.find("post_tags", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb.post((pb) => pb.select(["title"])).tag((tb) => tb.select(["name"]))),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "tag"."name" as "tag:name", "tag"."_internalId" as "tag:_internalId", "tag"."_version" as "tag:_version", "post_tags"."id" as "id", "post_tags"."postId" as "postId", "post_tags"."tagId" as "tagId", "post_tags"."_internalId" as "_internalId", "post_tags"."_version" as "_version" from "post_tags" left join "posts" as "post" on "post_tags"."postId" = "post"."_internalId" left join "tags" as "tag" on "post_tags"."tagId" = "tag"."_internalId""`,
      );
    });

    it("should compile nested many-to-many join (post_tags -> post -> author)", () => {
      const uow = createTestUOW();
      uow.find("post_tags", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb.post((pb) =>
              pb
                .select(["title"])
                .join((jb2) => jb2["author"]((ab) => ab.select(["name", "email"]))),
            ),
          ),
      );

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(1);
      const query = compiled.retrievalBatch[0];
      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "post_author"."name" as "post:author:name", "post_author"."email" as "post:author:email", "post_author"."_internalId" as "post:author:_internalId", "post_author"."_version" as "post:author:_version", "post_tags"."id" as "id", "post_tags"."postId" as "postId", "post_tags"."tagId" as "tagId", "post_tags"."_internalId" as "_internalId", "post_tags"."_version" as "_version" from "post_tags" left join "posts" as "post" on "post_tags"."postId" = "post"."_internalId" left join "users" as "post_author" on "post"."userId" = "post_author"."_internalId""`,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle UOW with no operations", () => {
      const uow = createTestUOW();

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(0);
    });

    it("should handle UOW with only retrieval operations", () => {
      const uow = createTestUOW();
      uow.find("users", (b) => b.whereIndex("primary"));

      const compiler = createKyselyUOWCompiler(testSchema, config);
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

      const compiler = createKyselyUOWCompiler(testSchema, config);
      const compiled = uow.compile(compiler);

      expect(compiled.retrievalBatch).toHaveLength(0);
      expect(compiled.mutationBatch).toHaveLength(1);
    });
  });
});
