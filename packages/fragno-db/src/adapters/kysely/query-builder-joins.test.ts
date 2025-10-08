import { Kysely, PostgresDialect } from "kysely";
import { describe, it, beforeAll, assert, expect } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { Kysely as KyselyType } from "kysely";
import { createKyselyQueryCompiler } from "./kysely-query-compiler";

// SUMMARY OF JOIN FUNCTIONALITY AND LIMITATIONS:
//
// ✅ WORKING FEATURES:
// - Basic one-to-many joins (posts -> users)
// - Join with specific column selection
// - Join with WHERE conditions on joined table (using function call syntax: eb("column", "operator", value))
// - Self-referencing joins (users -> inviter)
// - Multiple joins in single query
// - Many-to-many joins through junction tables
// - Complex WHERE conditions with AND/OR logic
//
// ❌ LIMITATIONS:
// - Nested joins (join on joined table) are not supported - nested join options are ignored
// - orderBy and limit on join options are not applied to the joined table
// - Cross-table WHERE conditions are not supported (main table WHERE cannot reference joined columns)
// - Direct many-to-many relationships (without junction tables) are not supported
// - Condition builder uses function call syntax, not method chaining (eb("name", "contains", "john") not eb.name.contains("john"))
//
// 🔧 IMPLEMENTATION NOTES:
// - All joins are LEFT JOINs
// - Join conditions are automatically generated from schema references
// - Column aliases follow the pattern "relation:column" for joined data
// - String operators like "contains", "starts with", "ends with" are converted to SQL LIKE patterns

describe("query-builder-joins", () => {
  const userSchema = schema((s) => {
    return (
      s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"))
            .addColumn("invitedBy", referenceColumn());
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("content", column("string"))
            .addColumn("userId", referenceColumn())
            .addColumn("publishedAt", column("timestamp"));
        })
        .addTable("tags", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("post_tags", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("postId", referenceColumn())
            .addColumn("tagId", referenceColumn());
        })
        .addTable("comments", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("content", column("string"))
            .addColumn("postId", referenceColumn())
            .addColumn("authorId", referenceColumn());
        })
        // Basic one-to-many relationships
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
        // Many-to-many relationships
        .addReference("post_tags", "post", {
          columns: ["postId"],
          targetTable: "posts",
          targetColumns: ["id"],
        })
        .addReference("post_tags", "tag", {
          columns: ["tagId"],
          targetTable: "tags",
          targetColumns: ["id"],
        })
    );
  });

  let kysely: KyselyType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fake Postgres connection information
    kysely = new Kysely({ dialect: new PostgresDialect({} as any) });
  });

  describe("postgresql", () => {
    it("should compile select with join condition comparing columns", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "userId"],
        join: (b) => b.author(),
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."email" as "author:email", "author"."invitedBy" as "author:invitedBy", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."userId" as "userId", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should compile join with specific column selection", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => b.author({ select: ["name", "email"] }),
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."email" as "author:email", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should compile join with WHERE conditions on joined table", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) =>
          b.author({
            select: ["name"],
            where: (eb) => eb("name", "contains", "john"),
          }),
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."name" like $1)"`,
      );
    });

    it("should compile self-referencing join", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("users", {
        select: ["id", "name"],
        join: (b) => b.inviter({ select: ["name"] }),
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "inviter"."name" as "inviter:name", "inviter"."_internalId" as "inviter:_internalId", "inviter"."_version" as "inviter:_version", "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" left join "users" as "inviter" on "users"."invitedBy" = "inviter"."_internalId""`,
      );
    });

    it("should compile multiple joins in single query", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("comments", {
        select: ["id", "content"],
        join: (b) => {
          b.post({ select: ["title"] });
          b.author({ select: ["name"] });
        },
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "comments"."id" as "id", "comments"."content" as "content", "comments"."_internalId" as "_internalId", "comments"."_version" as "_version" from "comments" left join "posts" as "post" on "comments"."postId" = "post"."_internalId" left join "users" as "author" on "comments"."authorId" = "author"."_internalId""`,
      );
    });

    it("should compile many-to-many join through junction table", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("post_tags", {
        select: ["id"],
        join: (b) => {
          b.post({ select: ["title"] });
          b.tag({ select: ["name"] });
        },
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "tag"."name" as "tag:name", "tag"."_internalId" as "tag:_internalId", "tag"."_version" as "tag:_version", "post_tags"."id" as "id", "post_tags"."_internalId" as "_internalId", "post_tags"."_version" as "_version" from "post_tags" left join "posts" as "post" on "post_tags"."postId" = "post"."_internalId" left join "tags" as "tag" on "post_tags"."tagId" = "tag"."_internalId""`,
      );
    });

    it("should compile complex join with multiple WHERE conditions", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) =>
          b.author({
            select: ["name"],
            where: (eb) =>
              eb.and(eb("name", "contains", "john"), eb("email", "ends with", "@example.com")),
          }),
      });

      assert(query);
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and ("users"."name" like $1 and "users"."email" like $2))"`,
      );
    });

    it("should compile join with ordering on joined table - LIMITATION: orderBy not applied to joins", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) =>
          b.author({
            select: ["name"],
            orderBy: [["name", "asc"]],
          }),
      });

      assert(query);
      // LIMITATION: orderBy on join options is not applied to the joined table
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should compile join with limit on joined table - LIMITATION: limit not applied to joins", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) =>
          b.author({
            select: ["name"],
            limit: 1,
          }),
      });

      assert(query);
      // LIMITATION: limit on join options is not applied to the joined table
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    // Tests for complex scenarios that might not work as expected
    it.skip("should support nested joins (join on joined table) - NOT IMPLEMENTED", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      // EXPECTED BEHAVIOR: We want to join posts -> author, then join author -> inviter
      // This should create two separate joins, not just ignore the nested join
      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => {
          b.author({
            select: ["name"],
            join: (authorJoin) => authorJoin["inviter"]({ select: ["name"] }),
          });
        },
      });

      assert(query);
      // EXPECTED SQL: Should include both the author join AND the inviter join
      expect(query.sql).toMatchInlineSnapshot(
        `"select "inviter"."name" as "author:inviter:name", "author"."name" as "author:name", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId" left join "users" as "inviter" on "author"."invitedBy" = "inviter"."_internalId""`,
      );

      // CURRENT BEHAVIOR: Nested join is ignored, only the first level join is applied
      // Actual SQL: select "author"."name" as "author:name", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId"
    });

    it.skip("should support WHERE conditions referencing joined columns - NOT IMPLEMENTED", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      // EXPECTED BEHAVIOR: WHERE conditions should be able to reference joined table columns
      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => b.author({ select: ["name"] }),
        // We want to filter by the author's name from the joined table
        where: (eb) =>
          eb.and(
            eb("title", "contains", "test"),
            // This should work but doesn't:
            eb("author.name", "=", "John"),
          ),
      });

      assert(query);
      // EXPECTED SQL: Should include author.name in WHERE clause
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId" where ("posts"."title" like $1 and "author"."name" = $2)"`,
      );

      // CURRENT LIMITATION: WHERE conditions on the main table cannot reference joined columns
      // The condition builder doesn't have access to joined table columns
    });

    it.skip("should support many-to-many joins through junction tables - NOT IMPLEMENTED", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      // EXPECTED BEHAVIOR: Should be able to join through a junction table to get related entities
      // posts -> post_tags (junction) -> tags
      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => {
          b.author({ select: ["name"] });
          // We want to join posts to tags through the post_tags junction table
          b["tags"]({ select: ["name"] }); // This should work via the junction table
        },
      });

      assert(query);
      // EXPECTED SQL: Should include joins through the junction table
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "tags"."name" as "tags:name", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId" left join "post_tags" on "posts"."_internalId" = "post_tags"."postId" left join "tags" on "post_tags"."tagId" = "tags"."_internalId""`,
      );

      // CURRENT LIMITATION: Direct many-to-many relationships are not supported
      // There's no direct relation from posts to tags, it requires going through post_tags
      // The join builder doesn't have a 'tags' method on posts
    });
  });

  describe("id column selection in joins", () => {
    it("should properly transform id columns in joined tables to FragnoId objects", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => b.author({ select: ["id", "name"] }),
      });

      assert(query);
      expect(query.sql).toContain('"author"."id"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toContain('"author"."_version" as "author:_version"');
    });

    it("should select id columns from main table and joined table", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => b.author({ select: ["id", "name"] }),
      });

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
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id"],
        join: (b) => b.author({ select: ["id"] }),
      });

      assert(query);
      // When only id is selected, _internalId is still included for joined table
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should include _internalId for both main and joined table when id is selected", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => b.author({ select: ["id", "name"] }),
      });

      assert(query);
      // Both tables should have their _internalId included when id is selected
      expect(query.sql).toContain('"posts"."_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    it("should not include _internalId when id is not selected", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["title"],
        join: (b) => b.author({ select: ["name"] }),
      });

      assert(query);
      // Hidden columns (_internalId, _version) are always included for internal use
      expect(query.sql).toContain('"posts"."_internalId" as "_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toContain('"posts"."_version" as "_version"');
      expect(query.sql).toContain('"author"."_version" as "author:_version"');
    });

    it("should handle select true with joins - includes all columns including id", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: true,
        join: (b) => b.author({ select: true }),
      });

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
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) =>
          b.author({
            select: ["id", "name"],
            where: (eb) => eb("id", "=", "user-123"),
          }),
      });

      assert(query);
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."id" = $1)"`,
      );
    });

    it("should handle multiple joins with different id selections", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("comments", {
        select: ["id", "content"],
        join: (b) => {
          b.post({ select: ["id", "title"] });
          b.author({ select: ["name"] }); // No id for author
        },
      });

      assert(query);
      expect(query.sql).toContain('"comments"."id"');
      expect(query.sql).toContain('"post"."id"');
      expect(query.sql).not.toContain('"author"."id"');
      // Hidden columns are always included regardless of ID selection
      expect(query.sql).toContain('"post"."_internalId" as "post:_internalId"');
      expect(query.sql).toContain('"author"."_internalId" as "author:_internalId"');
      expect(query.sql).toContain('"post"."_version" as "post:_version"');
      expect(query.sql).toContain('"author"."_version" as "author:_version"');
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
            .addColumn("price", column("integer"));
        })
        .addTable("categories", (t) => {
          return t.addColumn("categoryId", idColumn()).addColumn("categoryName", column("string"));
        })
        .addTable("product_categories", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("prodRef", referenceColumn())
            .addColumn("catRef", referenceColumn());
        })
        .addReference("product_categories", "product", {
          columns: ["prodRef"],
          targetTable: "products",
          targetColumns: ["productId"],
        })
        .addReference("product_categories", "category", {
          columns: ["catRef"],
          targetTable: "categories",
          targetColumns: ["categoryId"],
        });
    });

    it("should compile join with custom id column names", () => {
      const compiler = createKyselyQueryCompiler(customIdSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("product_categories", {
        select: ["id"],
        join: (b) => {
          b.product({ select: ["productId", "name"] });
          b.category({ select: ["categoryId", "categoryName"] });
        },
      });

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
      const compiler = createKyselyQueryCompiler(customIdSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("product_categories", {
        select: ["id"],
        join: (b) =>
          b.product({
            select: ["productId", "name"],
            where: (eb) => eb("productId", "=", "prod-456"),
          }),
      });

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
      const compiler = createKyselyQueryCompiler(customIdSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("product_categories", {
        select: true,
        join: (b) => b.product({ select: true }),
      });

      assert(query);
      expect(query.sql).toContain('"product"."productId"');
      expect(query.sql).toContain('"product_categories"."id"');
      // With select true, _internalId IS now included when table has an id column (fixed bug #3)
      expect(query.sql).toContain('"product"."_internalId" as "product:_internalId"');
      // Join condition ALWAYS uses _internalId for performance
      expect(query.sql).toContain('"product_categories"."prodRef" = "product"."_internalId"');
      expect(query.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."price" as "product:price", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product_categories"."id" as "id", "product_categories"."prodRef" as "prodRef", "product_categories"."catRef" as "catRef", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId""`,
      );
    });

    it("should join tables with different custom id names", () => {
      const compiler = createKyselyQueryCompiler(customIdSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("product_categories", {
        select: ["id"],
        join: (b) => {
          b.product({ select: ["productId"] });
          b.category({ select: ["categoryId"] });
        },
      });

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
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id"],
        join: (b) => b.author({ select: ["id"] }),
      });

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
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "title"],
        join: (b) => b.author({ select: ["id", "name"] }),
      });

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
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("comments", {
        select: ["id"],
        join: (b) => {
          b.post({ select: ["id"] });
          b.author({ select: ["id"] });
        },
      });

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
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("users", {
        select: ["id", "name"],
        join: (b) => b.inviter({ select: ["id", "name"] }),
      });

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
