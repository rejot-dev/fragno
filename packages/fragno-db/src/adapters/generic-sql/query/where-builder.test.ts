import { Kysely, PostgresDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../../schema/create";
import { fullSQLName, buildWhere, processReferenceSubqueries } from "./where-builder";
import { ReferenceSubquery } from "../../../query/value-encoding";
import { BetterSQLite3DriverConfig, NodePostgresDriverConfig } from "../driver-config";

describe("where-builder", () => {
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

    it("should work with table name mapper", () => {
      const mapper = {
        toPhysical: (ormName: string) => `prefix_${ormName}`,
        toLogical: (physicalName: string) => physicalName.replace("prefix_", ""),
      };
      const result = fullSQLName(usersTable.columns.name, mapper);
      expect(result).toBe("prefix_users.name");
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

      mockEB.selectFrom = (tableName: string) => {
        const query = {
          tableName,
          _select: null as string | null,
          _where: null as { col: string; op: string; val: unknown } | null,
          _limit: null as number | null,
          select: (col: string) => {
            query._select = col;
            return query;
          },
          where: (col: string, op: string, val: unknown) => {
            query._where = { col, op, val };
            return query;
          },
          limit: (n: number) => {
            query._limit = n;
            return query;
          },
        };
        return query;
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
        expect(result).toEqual({
          type: "compare",
          col: "users.isActive",
          op: "!=",
          val: true,
        });
      });

      it("should build greater than or equal comparison", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.age,
          operator: ">=" as const,
          b: 21,
        };

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
        expect(result).toEqual({
          type: "compare",
          col: "users.age",
          op: ">=",
          val: 21,
        });
      });

      it("should build less than or equal comparison", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.age,
          operator: "<=" as const,
          b: 65,
        };

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
        expect(result).toEqual({
          type: "compare",
          col: "users.age",
          op: "<=",
          val: 65,
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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
        const result = buildWhere(condition, eb, new NodePostgresDriverConfig());
        expect(result).toEqual({
          type: "compare",
          col: "users.name",
          op: "=",
          val: { type: "ref", name: "users.email" },
        });
      });

      it("should compare columns with string operators", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.name,
          operator: "contains" as const,
          b: usersTable.columns.email,
        };

        const eb = createMockEB();
        const result = buildWhere(condition, eb, new NodePostgresDriverConfig());
        // When comparing columns, the value should be wrapped with concat
        expect(result).toHaveProperty("type", "compare");
        expect(result).toHaveProperty("col", "users.name");
        expect(result).toHaveProperty("op", "like");
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
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

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
        expect(result).toHaveProperty("type", "and");
        expect(result).toHaveProperty("conditions");
        const conditions = (result as unknown as { conditions: unknown[] }).conditions;
        expect(conditions).toHaveLength(2);
        expect(conditions[0]).toHaveProperty("type", "compare");
        expect(conditions[1]).toHaveProperty("type", "or");
      });

      it("should build deeply nested conditions", () => {
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
                  type: "and" as const,
                  items: [
                    {
                      type: "compare" as const,
                      a: usersTable.columns.age,
                      operator: ">=" as const,
                      b: 18,
                    },
                    {
                      type: "compare" as const,
                      a: usersTable.columns.age,
                      operator: "<=" as const,
                      b: 30,
                    },
                  ],
                },
                {
                  type: "compare" as const,
                  a: usersTable.columns.age,
                  operator: ">" as const,
                  b: 65,
                },
              ],
            },
          ],
        };

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
        expect(result).toHaveProperty("type", "and");
        expect(result).toHaveProperty("conditions");
      });
    });

    describe("reference column handling", () => {
      it("should generate subquery for string reference in where clause", () => {
        const condition = {
          type: "compare" as const,
          a: postsTable.columns.userId,
          operator: "=" as const,
          b: "user-external-id-123",
        };

        const eb = createMockEB();
        const result = buildWhere(
          condition,
          eb,
          new NodePostgresDriverConfig(),
          undefined,
          undefined,
          postsTable,
        );

        // Should generate a subquery
        expect(result).toHaveProperty("type", "compare");
        expect(result).toHaveProperty("col", "posts.userId");
        expect(result).toHaveProperty("op", "=");
        // The value should be a subquery object
        const val = (result as unknown as { val: unknown }).val as Record<string, unknown>;
        expect(val).toHaveProperty("tableName", "users");
        expect(val).toHaveProperty("_select", "_internalId");
        expect(val).toHaveProperty("_where");
        expect(val["_where"]).toEqual({ col: "id", op: "=", val: "user-external-id-123" });
        expect(val).toHaveProperty("_limit", 1);
      });

      it("should not generate subquery for bigint reference", () => {
        const condition = {
          type: "compare" as const,
          a: postsTable.columns.userId,
          operator: "=" as const,
          b: 12345n,
        };

        const result = buildWhere(
          condition,
          createMockEB(),
          new NodePostgresDriverConfig(),
          undefined,
          undefined,
          postsTable,
        );

        // Should not generate a subquery for bigint
        expect(result).toEqual({
          type: "compare",
          col: "posts.userId",
          op: "=",
          val: 12345n,
        });
      });

      it("should generate subquery with table name mapper", () => {
        const mapper = {
          toPhysical: (ormName: string) => `prefix_${ormName}`,
          toLogical: (physicalName: string) => physicalName.replace("prefix_", ""),
        };

        const condition = {
          type: "compare" as const,
          a: postsTable.columns.userId,
          operator: "=" as const,
          b: "user-id-456",
        };

        const eb = createMockEB();
        const result = buildWhere(
          condition,
          eb,
          new NodePostgresDriverConfig(),
          undefined,
          mapper,
          postsTable,
        );

        // Should use the mapped table name in subquery
        const val = (result as unknown as { val: Record<string, unknown> }).val;
        expect(val).toHaveProperty("tableName", "prefix_users");
      });
    });

    describe("database-specific serialization", () => {
      it("should serialize boolean for postgresql", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.isActive,
          operator: "=" as const,
          b: true,
        };

        const result = buildWhere(condition, createMockEB(), new NodePostgresDriverConfig());
        expect(result).toHaveProperty("val", true);
      });

      it("should serialize boolean for sqlite", () => {
        const condition = {
          type: "compare" as const,
          a: usersTable.columns.isActive,
          operator: "=" as const,
          b: false,
        };

        const result = buildWhere(condition, createMockEB(), new BetterSQLite3DriverConfig());
        // SQLite might serialize booleans differently
        expect(result).toHaveProperty("op", "=");
      });
    });
  });

  describe("processReferenceSubqueries", () => {
    let kysely: Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fake Postgres connection information
      kysely = new Kysely({ dialect: new PostgresDialect({} as any) });
    });

    it("should process single reference subquery", () => {
      const values = {
        title: "My Post",
        content: "Post content",
        userId: new ReferenceSubquery(usersTable, "user-abc-123"),
      };

      const processed = processReferenceSubqueries(values, kysely);

      expect(processed["title"]).toBe("My Post");
      expect(processed["content"]).toBe("Post content");
      expect(processed["userId"]).toBeDefined();
      // The userId should now be a Kysely subquery
      expect(processed["userId"]).toHaveProperty("compile");
    });

    it("should process multiple reference subqueries", () => {
      const values = {
        ref1: new ReferenceSubquery(usersTable, "user-1"),
        ref2: new ReferenceSubquery(usersTable, "user-2"),
        regularValue: "test",
      };

      const processed = processReferenceSubqueries(values, kysely);

      expect(processed["ref1"]).toHaveProperty("compile");
      expect(processed["ref2"]).toHaveProperty("compile");
      expect(processed["regularValue"]).toBe("test");
    });

    it("should not modify non-reference values", () => {
      const values = {
        string: "test",
        number: 42,
        boolean: true,
        null: null,
        undefined: undefined,
        object: { nested: "value" },
      };

      const processed = processReferenceSubqueries(values, kysely);

      expect(processed).toEqual(values);
    });

    it("should use table name mapper when provided", () => {
      const mapper = {
        toPhysical: (ormName: string) => `prefix_${ormName}`,
        toLogical: (physicalName: string) => physicalName.replace("prefix_", ""),
      };

      const values = {
        userId: new ReferenceSubquery(usersTable, "user-123"),
      };

      const processed = processReferenceSubqueries(values, kysely, mapper);

      // Compile the subquery to check it uses the mapped table name
      const subquery = processed["userId"] as unknown as { compile: () => { sql: string } };
      expect(subquery).toHaveProperty("compile");
      const compiled = subquery.compile();
      expect(compiled.sql).toContain("prefix_users");
    });

    it("should handle empty values object", () => {
      const values = {};

      const processed = processReferenceSubqueries(values, kysely);

      expect(processed).toEqual({});
    });

    it("should generate correct subquery SQL", () => {
      const values = {
        userId: new ReferenceSubquery(usersTable, "external-id-789"),
      };

      const processed = processReferenceSubqueries(values, kysely);

      const subquery = processed["userId"] as unknown as {
        compile: () => { sql: string; parameters: unknown[] };
      };
      const compiled = subquery.compile();

      // Should select _internalId where id = externalId
      expect(compiled.sql).toContain("_internalId");
      expect(compiled.sql).toContain("users");
      expect(compiled.sql).toContain("id");
      expect(compiled.parameters).toContain("external-id-789");
    });

    it("should respect limit of 1 in generated subquery", () => {
      const values = {
        userId: new ReferenceSubquery(usersTable, "user-id"),
      };

      const processed = processReferenceSubqueries(values, kysely);

      const subquery = processed["userId"] as unknown as { compile: () => { sql: string } };
      const compiled = subquery.compile();

      expect(compiled.sql).toContain("limit");
    });
  });
});
