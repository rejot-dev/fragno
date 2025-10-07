import { Kysely, PostgresDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import {
  fullSQLName,
  buildWhere,
  mapSelect,
  extendSelect,
  createKyselyQueryBuilder,
} from "./query-builder";
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
      .addReference("posts", "author", {
        columns: ["userId"],
        targetTable: "users",
        targetColumns: ["id"],
      });
  });

  const usersTable = testSchema.tables.users;
  const postsTable = testSchema.tables.posts;

  describe("fullSQLName", () => {
    it("should return fully qualified column name", () => {
      const result = fullSQLName(usersTable.columns.name);
      expect(result).toBe("users.name");
    });

    it("should work with different tables", () => {
      const result = fullSQLName(postsTable.columns.title);
      expect(result).toBe("posts.title");
    });

    it("should work with id column", () => {
      const result = fullSQLName(usersTable.columns.id);
      expect(result).toBe("users.id");
    });
  });

  describe("buildWhere", () => {
    // Mock expression builder for testing
    const createMockEB = () => {
      const mockEB = ((col: string, op: string, val: unknown) => {
        return { type: "compare", col, op, val };
      }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      mockEB.and = (conditions: unknown[]) => {
        return { type: "and", conditions };
      };

      mockEB.or = (conditions: unknown[]) => {
        return { type: "or", conditions };
      };

      mockEB.not = (condition: unknown) => {
        return { type: "not", condition };
      };

      mockEB.ref = (name: string) => {
        return { type: "ref", name };
      };

      return mockEB;
    };

    describe("comparison operators", () => {
      it("should build simple equality comparison", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.name,
          operator: "=" as const,
          b: "John",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.name",
          op: "=",
          val: "John",
        });
      });

      it("should build greater than comparison", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.age,
          operator: ">" as const,
          b: 18,
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.age",
          op: ">",
          val: 18,
        });
      });

      it("should build less than comparison", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.age,
          operator: "<" as const,
          b: 65,
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.age",
          op: "<",
          val: 65,
        });
      });

      it("should build not equals comparison", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.isActive,
          operator: "!=" as const,
          b: true,
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.isActive",
          op: "!=",
          val: true,
        });
      });
    });

    describe("string operators", () => {
      it("should build contains operator", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.name,
          operator: "contains" as const,
          b: "john",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.name",
          op: "like",
          val: "%john%",
        });
      });

      it("should build not contains operator", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.name,
          operator: "not contains" as const,
          b: "admin",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.name",
          op: "not like",
          val: "%admin%",
        });
      });

      it("should build starts with operator", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "starts with" as const,
          b: "admin",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.email",
          op: "like",
          val: "admin%",
        });
      });

      it("should build not starts with operator", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "not starts with" as const,
          b: "test",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.email",
          op: "not like",
          val: "test%",
        });
      });

      it("should build ends with operator", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "ends with" as const,
          b: "@example.com",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.email",
          op: "like",
          val: "%@example.com",
        });
      });

      it("should build not ends with operator", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.email,
          operator: "not ends with" as const,
          b: "@spam.com",
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.email",
          op: "not like",
          val: "%@spam.com",
        });
      });
    });

    describe("column to column comparison", () => {
      it("should compare two columns", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.name,
          operator: "=" as const,
          b: usersTable.columns.email,
        };

        const eb = createMockEB();
        const result = buildWhere(condition, eb, "postgresql");
        expect(result).toEqual({
          type: "compare",
          col: "users.name",
          op: "=",
          val: { type: "ref", name: "users.email" },
        });
      });
    });

    describe("logical operators", () => {
      it("should build AND condition", () => {
        const condition = {
          type: "and" as const,
          items: [
            {
              type: "compare" as const,
              a: usersTable.columns.age,
              operator: ">" as const,
              b: 18,
            },
            {
              type: "compare" as const,
              a: usersTable.columns.isActive,
              operator: "=" as const,
              b: true,
            },
          ],
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "and",
          conditions: [
            { type: "compare", col: "users.age", op: ">", val: 18 },
            { type: "compare", col: "users.isActive", op: "=", val: true },
          ],
        });
      });

      it("should build OR condition", () => {
        const condition = {
          type: "or" as const,
          items: [
            {
              type: "compare" as const,
              a: usersTable.columns.name,
              operator: "=" as const,
              b: "John",
            },
            {
              type: "compare" as const,
              a: usersTable.columns.name,
              operator: "=" as const,
              b: "Jane",
            },
          ],
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "or",
          conditions: [
            { type: "compare", col: "users.name", op: "=", val: "John" },
            { type: "compare", col: "users.name", op: "=", val: "Jane" },
          ],
        });
      });

      it("should build NOT condition", () => {
        const condition = {
          type: "not" as const,
          item: {
            type: "compare" as const,
            a: usersTable.columns.isActive,
            operator: "=" as const,
            b: false,
          },
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toEqual({
          type: "not",
          condition: { type: "compare", col: "users.isActive", op: "=", val: false },
        });
      });

      it("should build nested conditions", () => {
        const condition = {
          type: "and" as const,
          items: [
            {
              type: "compare" as const,
              a: usersTable.columns.isActive,
              operator: "=" as const,
              b: true,
            },
            {
              type: "or" as const,
              items: [
                {
                  type: "compare" as const,
                  a: usersTable.columns.age,
                  operator: ">" as const,
                  b: 18,
                },
                {
                  type: "compare" as const,
                  a: usersTable.columns.age,
                  operator: "<" as const,
                  b: 65,
                },
              ],
            },
          ],
        };

        const result = buildWhere(condition, createMockEB(), "postgresql");
        expect(result).toHaveProperty("type", "and");
        expect(result).toHaveProperty("conditions");
      });
    });
  });

  describe("mapSelect", () => {
    it("should map select clause with array of keys", () => {
      const result = mapSelect(["id", "name", "email"], usersTable);
      expect(result).toEqual(["users.id as id", "users.name as name", "users.email as email"]);
    });

    it("should map select all columns when true", () => {
      const result = mapSelect(true, usersTable);
      expect(result).toEqual([
        "users.id as id",
        "users.name as name",
        "users.email as email",
        "users.age as age",
        "users.isActive as isActive",
        "users.createdAt as createdAt",
      ]);
    });

    it("should map select with relation prefix", () => {
      const result = mapSelect(["id", "name"], usersTable, { relation: "author" });
      expect(result).toEqual(["users.id as author:id", "users.name as author:name"]);
    });

    it("should map select with custom table name", () => {
      const result = mapSelect(["id", "title"], postsTable, { tableName: "p" });
      expect(result).toEqual(["p.id as id", "p.title as title"]);
    });

    it("should map select with both relation and custom table name", () => {
      const result = mapSelect(["id", "title"], postsTable, {
        relation: "posts",
        tableName: "p",
      });
      expect(result).toEqual(["p.id as posts:id", "p.title as posts:title"]);
    });

    it("should handle single column select", () => {
      const result = mapSelect(["name"], usersTable);
      expect(result).toEqual(["users.name as name"]);
    });
  });

  describe("extendSelect", () => {
    it("should extend array select with new key", () => {
      const builder = extendSelect(["name", "email"]);
      builder.extend("id");
      const compiled = builder.compile();

      expect(compiled.result).toEqual(["name", "email", "id"]);
      expect(compiled.extendedKeys).toEqual(["id"]);
    });

    it("should not duplicate existing keys", () => {
      const builder = extendSelect(["name", "email"]);
      builder.extend("name");
      const compiled = builder.compile();

      expect(compiled.result).toEqual(["name", "email"]);
      expect(compiled.extendedKeys).toEqual([]);
    });

    it("should handle true select clause", () => {
      const builder = extendSelect(true);
      builder.extend("id");
      const compiled = builder.compile();

      expect(compiled.result).toBe(true);
      expect(compiled.extendedKeys).toEqual([]);
    });

    it("should track multiple extended keys", () => {
      const builder = extendSelect(["name"]);
      builder.extend("id");
      builder.extend("email");
      builder.extend("age");
      const compiled = builder.compile();

      expect(compiled.result).toEqual(["name", "id", "email", "age"]);
      expect(compiled.extendedKeys).toEqual(["id", "email", "age"]);
    });

    it("should remove extended keys from record", () => {
      const builder = extendSelect(["name", "email"]);
      builder.extend("id");
      const compiled = builder.compile();

      const record = { id: "123", name: "John", email: "john@example.com", age: 30 };
      compiled.removeExtendedKeys(record);

      expect(record).toEqual({ name: "John", email: "john@example.com", age: 30 });
    });

    it("should not remove non-extended keys", () => {
      const builder = extendSelect(["name", "email", "id"]);
      builder.extend("age");
      const compiled = builder.compile();

      const record = { id: "123", name: "John", email: "john@example.com", age: 30 };
      compiled.removeExtendedKeys(record);

      expect(record).toEqual({ id: "123", name: "John", email: "john@example.com" });
    });

    it("should handle empty extended keys", () => {
      const builder = extendSelect(["name", "email"]);
      const compiled = builder.compile();

      const record = { name: "John", email: "john@example.com" };
      compiled.removeExtendedKeys(record);

      expect(record).toEqual({ name: "John", email: "john@example.com" });
    });
  });

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

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("create", () => {
      it("should compile insert query for postgresql", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.create(usersTable, {
          name: "John",
          email: "john@example.com",
        });

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile insert query for sqlite", () => {
        const compiler = createKyselyQueryBuilder(kysely, "sqlite");
        const query = compiler.create(usersTable, {
          name: "John",
          email: "john@example.com",
        });

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile insert query for mssql", () => {
        const compiler = createKyselyQueryBuilder(kysely, "mssql");
        const query = compiler.create(usersTable, {
          name: "John",
          email: "john@example.com",
        });

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("findMany", () => {
      it("should compile basic select query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: ["id", "name"],
        });

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile select all columns", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
        });

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile select with limit and offset", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
          limit: 10,
          offset: 20,
        });

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile select with single order by", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findMany(usersTable, {
          select: true,
          orderBy: [[usersTable.columns.name, "asc"]],
        });

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });

      it("should use TOP for mssql limit", () => {
        const compiler = createKyselyQueryBuilder(kysely, "mssql");
        const query = compiler.findMany(usersTable, {
          select: true,
          limit: 5,
        });

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("updateMany", () => {
      it("should compile update query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.updateMany(usersTable, {
          set: { name: "Updated Name" },
        });

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("upsertCheck", () => {
      it("should compile upsert check query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertCheck(usersTable, undefined);

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile upsert update query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertUpdate(usersTable, { name: "Updated" }, undefined);

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("upsertUpdateById", () => {
      it("should compile upsert update by id query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertUpdateById(usersTable, { name: "Updated" }, "123");

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile upsert update by id with multiple fields", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.upsertUpdateById(
          usersTable,
          { name: "Updated", email: "updated@example.com" },
          "456",
        );

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("createMany", () => {
      it("should compile bulk insert query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(usersTable, [
          { name: "John", email: "john@example.com" },
          { name: "Jane", email: "jane@example.com" },
        ]);

        expect(query.sql).toMatchSnapshot();
      });

      it("should handle single record in array", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(usersTable, [
          { name: "John", email: "john@example.com" },
        ]);

        expect(query.sql).toMatchSnapshot();
      });

      it("should handle many records", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.createMany(usersTable, [
          { name: "John", email: "john@example.com" },
          { name: "Jane", email: "jane@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ]);

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("deleteMany", () => {
      it("should compile delete query without where", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.deleteMany(usersTable, {});

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
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

        expect(query.sql).toMatchSnapshot();
      });
    });

    describe("findById", () => {
      it("should compile find by id query", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findById(usersTable, "123");

        expect(query.sql).toMatchSnapshot();
      });

      it("should compile find by id query with numeric id", () => {
        const compiler = createKyselyQueryBuilder(kysely, "postgresql");
        const query = compiler.findById(usersTable, 456);

        expect(query.sql).toMatchSnapshot();
      });
    });
  });
});
