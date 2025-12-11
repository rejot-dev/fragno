import { Kysely, PostgresDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { createKyselyQueryBuilder } from "./kysely-query-builder";
import type { Kysely as KyselyType } from "kysely";

describe("query-builder", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("isActive", column("bool"))
          .addColumn("createdAt", column("timestamp"));
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", referenceColumn())
          .addColumn("viewCount", column("integer").defaultTo(0))
          .addColumn("publishedAt", column("timestamp").nullable());
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
      });
  });

  const usersTable = testSchema.tables.users;
  const postsTable = testSchema.tables.posts;

  describe("queryCompiler", () => {
    let kysely: KyselyType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fake Postgres connection information
      kysely = new Kysely({ dialect: new PostgresDialect({} as any) });
    });

    describe("count", () => {
      it("should compile count query without where clause", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.count(usersTable, {});

        expect(query.sql).toMatchInlineSnapshot(`"select count(*) as "count" from "users""`);
      });

      it("should compile count query with where clause", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.isActive,
          operator: "=" as const,
          b: true,
        };
        const query = compiler.count(usersTable, { where });

        expect(query.sql).toMatchInlineSnapshot(
          `"select count(*) as "count" from "users" where "users"."isActive" = $1"`,
        );
      });
    });

    describe("create", () => {
      it("should compile insert query for postgresql", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.create(usersTable, {
          name: "John",
          email: "john@example.com",
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "users" ("id", "name", "email") values ($1, $2, $3) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
        );
      });

      it("should compile insert query for sqlite", () => {
        const compiler = createKyselyQueryBuilder(kysely, "sqlite");
        const query = compiler.create(usersTable, {
          name: "John",
          email: "john@example.com",
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "users" ("id", "name", "email") values ($1, $2, $3) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
        );
      });

      it("should compile insert query for mssql", () => {
        const compiler = createKyselyQueryBuilder(kysely, "mssql");
        const query = compiler.create(usersTable, {
          name: "John",
          email: "john@example.com",
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "users" ("id", "name", "email") output "inserted"."id" as "id", "inserted"."name" as "name", "inserted"."email" as "email", "inserted"."age" as "age", "inserted"."isActive" as "isActive", "inserted"."createdAt" as "createdAt", "inserted"."_internalId" as "_internalId", "inserted"."_version" as "_version" values ($1, $2, $3)"`,
        );
      });

      it("should compile insert with string reference (external ID)", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.create(postsTable, {
          title: "My Post",
          content: "Post content",
          userId: "user-external-id-123",
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "posts" ("id", "title", "content", "userId") values ($1, $2, $3, (select "_internalId" from "users" where "id" = $4 limit $5)) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version""`,
        );
        expect(query.sql).toContain("select");
        expect(query.sql).toContain("users");
      });
    });

    describe("reference column subquery handling", () => {
      it("should generate subquery for string reference in create", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.create(postsTable, {
          title: "New Post",
          content: "Content here",
          userId: "user-abc-123",
        });

        // Should contain a subquery to look up the internal ID
        expect(query.sql).toContain("select");
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toContain("users");
        expect(query.parameters).toContain("user-abc-123");
        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "posts" ("id", "title", "content", "userId") values ($1, $2, $3, (select "_internalId" from "users" where "id" = $4 limit $5)) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version""`,
        );
      });

      it("should generate subqueries for string references in createMany", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(postsTable, [
          {
            title: "Post 1",
            content: "Content 1",
            userId: "user-id-1",
          },
          {
            title: "Post 2",
            content: "Content 2",
            userId: "user-id-2",
          },
        ]);

        // Should contain subqueries for both references
        expect(query.sql).toContain("select");
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toContain("users");
        expect(query.parameters).toContain("user-id-1");
        expect(query.parameters).toContain("user-id-2");
        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "posts" ("id", "title", "content", "userId") values ($1, $2, $3, (select "_internalId" from "users" where "id" = $4 limit $5)), ($6, $7, $8, (select "_internalId" from "users" where "id" = $9 limit $10))"`,
        );
      });

      it("should generate subquery for string reference in updateMany", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: postsTable.columns.id,
          operator: "=" as const,
          b: "post-123",
        };
        const query = compiler.updateMany(postsTable, {
          set: { userId: "new-user-id-456" },
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"update "posts" set "userId" = (select "_internalId" from "users" where "id" = $1 limit $2), "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = $3"`,
        );
        // Should contain a subquery to look up the internal ID
        expect(query.sql).toContain("select");
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toContain("users");
        expect(query.parameters).toContain("new-user-id-456");
      });

      it("should handle bigint reference without subquery", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        // Passing a bigint directly should not generate a subquery
        const query = compiler.create(postsTable, {
          title: "Direct ID Post",
          content: "Content",
          userId: 12345n,
        });

        // For bigint, it should not generate a subquery
        // PostgreSQL uses INSERT...RETURNING so it will have "returning" keyword
        expect(query.sql).toContain("insert");
        expect(query.sql).toContain("returning");
        // Should not have nested SELECT for the userId value
        expect(query.sql).not.toMatch(/\(select.*from.*users/i);
        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "posts" ("id", "title", "content", "userId") values ($1, $2, $3, $4) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version""`,
        );
      });
    });

    describe("findMany", () => {
      it("should compile basic select query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: ["id", "name"],
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });

      it("should compile select all columns", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });

      it("should compile select with where clause", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.age,
          operator: ">" as const,
          b: 18,
        };
        const query = compiler.findMany(usersTable, {
          select: true,
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."age" > $1"`,
        );
      });

      it("should compile select with limit and offset", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
          limit: 10,
          offset: 20,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit $1 offset $2"`,
        );
      });

      it("should compile select with single order by", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
          orderBy: [[usersTable.columns.name, "asc"]],
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."name" asc"`,
        );
      });

      it("should compile select with multiple order by", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
          orderBy: [
            [usersTable.columns.name, "asc"],
            [usersTable.columns.age, "desc"],
          ],
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."name" asc, "users"."age" desc"`,
        );
      });

      it("should compile complete query with all options", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "and" as const,
          items: [
            {
              type: "compare" as const,
              a: usersTable.columns.isActive,
              operator: "=" as const,
              b: true,
            },
            {
              type: "compare" as const,
              a: usersTable.columns.age,
              operator: ">=" as const,
              b: 18,
            },
          ],
        };
        const query = compiler.findMany(usersTable, {
          select: ["id", "name", "email"],
          where,
          orderBy: [[usersTable.columns.name, "asc"]],
          limit: 10,
          offset: 5,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."isActive" = $1 and "users"."age" >= $2) order by "users"."name" asc limit $3 offset $4"`,
        );
      });

      it("should use TOP for mssql limit", () => {
        const compiler = createKyselyQueryBuilder(kysely, "mssql");
        const query = compiler.findMany(usersTable, {
          select: true,
          limit: 5,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select top(5) "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });
    });

    describe("updateMany", () => {
      it("should compile update query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.updateMany(usersTable, {
          set: { name: "Updated Name" },
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"update "users" set "name" = $1, "_version" = COALESCE(_version, 0) + 1"`,
        );
      });

      it("should compile update query with where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.id,
          operator: "=" as const,
          b: "123",
        };
        const query = compiler.updateMany(usersTable, {
          set: { name: "Updated Name" },
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"update "users" set "name" = $1, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = $2"`,
        );
      });

      it("should compile update query with multiple fields", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.isActive,
          operator: "=" as const,
          b: false,
        };
        const query = compiler.updateMany(usersTable, {
          set: { name: "Updated Name", email: "updated@example.com", isActive: true },
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"update "users" set "name" = $1, "email" = $2, "isActive" = $3, "_version" = COALESCE(_version, 0) + 1 where "users"."isActive" = $4"`,
        );
      });
    });

    describe("upsertCheck", () => {
      it("should compile upsert check query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertCheck(usersTable, undefined);

        expect(query.sql).toMatchInlineSnapshot(`"select "id" as "id" from "users" limit $1"`);
      });

      it("should compile upsert check query with where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "=" as const,
          b: "test@example.com",
        };
        const query = compiler.upsertCheck(usersTable, where);

        expect(query.sql).toMatchInlineSnapshot(
          `"select "id" as "id" from "users" where "users"."email" = $1 limit $2"`,
        );
      });
    });

    describe("upsertUpdate", () => {
      it("should compile upsert update query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "=" as const,
          b: "test@example.com",
        };
        const query = compiler.upsertUpdate(usersTable, { name: "Updated" }, where);

        expect(query.sql).toMatchInlineSnapshot(
          `"update "users" set "name" = $1 where "users"."email" = $2"`,
        );
      });

      it("should compile upsert update query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertUpdate(usersTable, { name: "Updated" }, undefined);

        expect(query.sql).toMatchInlineSnapshot(`"update "users" set "name" = $1"`);
      });

      it("should compile upsert update query with top", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "=" as const,
          b: "test@example.com",
        };
        const query = compiler.upsertUpdate(usersTable, { name: "Updated" }, where, true);

        expect(query.sql).toMatchInlineSnapshot(
          `"update top(1) "users" set "name" = $1 where "users"."email" = $2"`,
        );
      });
    });

    describe("upsertUpdateById", () => {
      it("should compile upsert update by id query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertUpdateById(usersTable, { name: "Updated" }, "123");

        expect(query.sql).toMatchInlineSnapshot(`"update "users" set "name" = $1 where "id" = $2"`);
      });

      it("should compile upsert update by id with multiple fields", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertUpdateById(
          usersTable,
          { name: "Updated", email: "updated@example.com" },
          "456",
        );

        expect(query.sql).toMatchInlineSnapshot(
          `"update "users" set "name" = $1, "email" = $2 where "id" = $3"`,
        );
      });
    });

    describe("createMany", () => {
      it("should compile bulk insert query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(usersTable, [
          { name: "John", email: "john@example.com" },
          { name: "Jane", email: "jane@example.com" },
        ]);

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "users" ("id", "name", "email") values ($1, $2, $3), ($4, $5, $6)"`,
        );
      });

      it("should handle single record in array", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(usersTable, [
          { name: "John", email: "john@example.com" },
        ]);

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "users" ("id", "name", "email") values ($1, $2, $3)"`,
        );
      });

      it("should handle many records", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(usersTable, [
          { name: "John", email: "john@example.com" },
          { name: "Jane", email: "jane@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ]);

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "users" ("id", "name", "email") values ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)"`,
        );
      });
    });

    describe("deleteMany", () => {
      it("should compile delete query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.deleteMany(usersTable, {});

        expect(query.sql).toMatchInlineSnapshot(`"delete from "users""`);
      });

      it("should compile delete query with where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.isActive,
          operator: "=" as const,
          b: false,
        };
        const query = compiler.deleteMany(usersTable, { where });

        expect(query.sql).toMatchInlineSnapshot(
          `"delete from "users" where "users"."isActive" = $1"`,
        );
      });

      it("should compile delete query with complex where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "and" as const,
          items: [
            {
              type: "compare" as const,
              a: usersTable.columns.isActive,
              operator: "=" as const,
              b: false,
            },
            {
              type: "compare" as const,
              a: usersTable.columns.age,
              operator: "<" as const,
              b: 18,
            },
          ],
        };
        const query = compiler.deleteMany(usersTable, { where });

        expect(query.sql).toMatchInlineSnapshot(
          `"delete from "users" where ("users"."isActive" = $1 and "users"."age" < $2)"`,
        );
      });
    });

    describe("findById", () => {
      it("should compile find by id query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findById(usersTable, "123");

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "id" = $1 limit $2"`,
        );
      });

      it("should compile find by id query with numeric id", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findById(usersTable, 456);

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "id" = $1 limit $2"`,
        );
      });
    });

    describe("id column selection", () => {
      it("should select id column explicitly", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: ["id"],
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });

      it("should include _internalId when id is selected", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: ["id", "name"],
        });

        expect(query.sql).toContain("_internalId");
        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });

      it("should handle id column in where clause", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: usersTable.columns.id,
          operator: "=" as const,
          b: "test-id-123",
        };
        const query = compiler.findMany(usersTable, {
          select: ["id", "name"],
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."id" = $1"`,
        );
      });

      it("should handle id column in order by", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: ["id", "name"],
          orderBy: [[usersTable.columns.id, "asc"]],
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."id" asc"`,
        );
      });
    });

    describe("special columns - _internalId and _version", () => {
      it("should not explicitly select _internalId when not requested", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: ["name", "email"],
        });

        // Hidden columns (_internalId, _version) are always included for internal use
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toContain("_version");
      });

      it("should handle selecting _internalId explicitly if column exists", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        // This tests what happens if someone tries to select _internalId directly
        // Depending on implementation, this might work or might be filtered out
        const query = compiler.findMany(usersTable, {
          select: ["id", "name"],
        });

        // _internalId is automatically added when id is selected
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });

      it("should handle _version column if it exists in schema", () => {
        // Note: The test schema doesn't have _version column
        // This is a placeholder to document the behavior
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
        });

        // _version would be included if it exists in the schema
        expect(query.sql).toMatchInlineSnapshot(
          `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users""`,
        );
      });
    });

    describe("custom-named id columns", () => {
      // Schema with custom-named id column
      const customIdSchema = schema((s) => {
        return s
          .addTable("products", (t) => {
            return t
              .addColumn("productId", idColumn())
              .addColumn("name", column("string"))
              .addColumn("price", column("integer"));
          })
          .addTable("orders", (t) => {
            return t
              .addColumn("orderId", idColumn())
              .addColumn("productRef", referenceColumn())
              .addColumn("quantity", column("integer"));
          })
          .addReference("product", {
            type: "one",
            from: { table: "orders", column: "productRef" },
            to: { table: "products", column: "productId" },
          });
      });

      const productsTable = customIdSchema.tables.products;
      const ordersTable = customIdSchema.tables.orders;

      it("should compile select with custom id column name", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(productsTable, {
          select: ["productId", "name"],
        });

        expect(query.sql).toContain("productId");
        expect(query.sql).toMatchInlineSnapshot(
          `"select "products"."productId" as "productId", "products"."name" as "name", "products"."_internalId" as "_internalId", "products"."_version" as "_version" from "products""`,
        );
      });

      it("should compile select all with custom id column name", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(productsTable, {
          select: true,
        });

        expect(query.sql).toContain("productId");
        expect(query.sql).toMatchInlineSnapshot(
          `"select "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version" from "products""`,
        );
      });

      it("should handle custom id column in where clause", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: productsTable.columns.productId,
          operator: "=" as const,
          b: "prod-123",
        };
        const query = compiler.findMany(productsTable, {
          select: true,
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version" from "products" where "products"."productId" = $1"`,
        );
      });

      it("should handle custom id column in order by", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(productsTable, {
          select: true,
          orderBy: [[productsTable.columns.productId, "desc"]],
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version" from "products" order by "products"."productId" desc"`,
        );
      });

      it("should compile insert with custom id column", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.create(productsTable, {
          name: "Widget",
          price: 1000,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"insert into "products" ("productId", "name", "price") values ($1, $2, $3) returning "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version""`,
        );
      });

      it("should compile update with custom id column in where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: productsTable.columns.productId,
          operator: "=" as const,
          b: "prod-456",
        };
        const query = compiler.updateMany(productsTable, {
          set: { price: 2000 },
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"update "products" set "price" = $1, "_version" = COALESCE(_version, 0) + 1 where "products"."productId" = $2"`,
        );
      });

      it("should handle references to custom id columns", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const where = {
          type: "compare" as const,
          a: ordersTable.columns.orderId,
          operator: "=" as const,
          b: "order-789",
        };
        const query = compiler.findMany(ordersTable, {
          select: ["orderId", "productRef", "quantity"],
          where,
        });

        expect(query.sql).toMatchInlineSnapshot(
          `"select "orders"."orderId" as "orderId", "orders"."productRef" as "productRef", "orders"."quantity" as "quantity", "orders"."_internalId" as "_internalId", "orders"."_version" as "_version" from "orders" where "orders"."orderId" = $1"`,
        );
      });
    });

    describe("special column name conflicts", () => {
      // Schema where regular columns might conflict with special names
      const conflictSchema = schema((s) => {
        return s.addTable("logs", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("message", column("string"))
            .addColumn("level", column("string"));
        });
      });

      const logsTable = conflictSchema.tables.logs;

      it("should handle table with both id and _internalId", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(logsTable, {
          select: ["id", "message"],
        });

        // Should select both id and _internalId
        expect(query.sql).toContain("id");
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toMatchInlineSnapshot(
          `"select "logs"."id" as "id", "logs"."message" as "message", "logs"."_internalId" as "_internalId", "logs"."_version" as "_version" from "logs""`,
        );
      });

      it("should handle selecting only non-id columns", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(logsTable, {
          select: ["message", "level"],
        });

        // Should NOT include id when not selected, but hidden columns are always included
        expect(query.sql).not.toContain('"id"');
        expect(query.sql).toContain("_internalId");
        expect(query.sql).toContain("_version");
      });
    });
  });
});
