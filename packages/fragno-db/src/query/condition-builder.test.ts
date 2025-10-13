import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "../schema/create";
import { createBuilder, createIndexedBuilder } from "./condition-builder";

describe("ConditionBuilder", () => {
  const testSchema = schema((s) =>
    s
      .addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("email", column("string"))
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("_primary", ["id"], { unique: true })
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name_age", ["name", "age"]),
      )
      .addTable("posts", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("published", column("bool"))
          .createIndex("_primary", ["id"], { unique: true })
          .createIndex("idx_published", ["published"]),
      ),
  );

  const usersTable = testSchema.tables.users;

  describe("createBuilder", () => {
    it("should create conditions with all columns", () => {
      const builder = createBuilder(usersTable.columns);

      const condition = builder("email", "=", "test@example.com");
      expect(condition).toEqual({
        type: "compare",
        a: usersTable.columns.email,
        operator: "=",
        b: "test@example.com",
      });
    });

    it("should support comparison operators", () => {
      const builder = createBuilder(usersTable.columns);

      expect(builder("age", ">", 18)).toEqual({
        type: "compare",
        a: usersTable.columns.age,
        operator: ">",
        b: 18,
      });

      expect(builder("age", "<=", 65)).toEqual({
        type: "compare",
        a: usersTable.columns.age,
        operator: "<=",
        b: 65,
      });
    });

    it("should support array operators", () => {
      const builder = createBuilder(usersTable.columns);

      const condition = builder("name", "in", ["Alice", "Bob"]);
      expect(condition).toEqual({
        type: "compare",
        a: usersTable.columns.name,
        operator: "in",
        b: ["Alice", "Bob"],
      });
    });

    it("should support string operators", () => {
      const builder = createBuilder(usersTable.columns);

      const condition = builder("email", "contains", "example");
      expect(condition).toEqual({
        type: "compare",
        a: usersTable.columns.email,
        operator: "contains",
        b: "example",
      });
    });

    it("should support null checks", () => {
      const builder = createBuilder(usersTable.columns);

      expect(builder.isNull("age")).toEqual({
        type: "compare",
        a: usersTable.columns.age,
        operator: "is",
        b: null,
      });

      expect(builder.isNotNull("age")).toEqual({
        type: "compare",
        a: usersTable.columns.age,
        operator: "is not",
        b: null,
      });
    });

    it("should support boolean columns", () => {
      const postsTable = testSchema.tables.posts;
      const builder = createBuilder(postsTable.columns);

      expect(builder("published")).toEqual({
        type: "compare",
        a: postsTable.columns.published,
        operator: "=",
        b: true,
      });
    });

    it("should support AND conditions", () => {
      const builder = createBuilder(usersTable.columns);

      const condition = builder.and(builder("age", ">", 18), builder("age", "<", 65));

      expect(condition).toEqual({
        type: "and",
        items: [
          {
            type: "compare",
            a: usersTable.columns.age,
            operator: ">",
            b: 18,
          },
          {
            type: "compare",
            a: usersTable.columns.age,
            operator: "<",
            b: 65,
          },
        ],
      });
    });

    it("should support OR conditions", () => {
      const builder = createBuilder(usersTable.columns);

      const condition = builder.or(
        builder("email", "contains", "gmail"),
        builder("email", "contains", "yahoo"),
      );

      expect(condition).toEqual({
        type: "or",
        items: [
          {
            type: "compare",
            a: usersTable.columns.email,
            operator: "contains",
            b: "gmail",
          },
          {
            type: "compare",
            a: usersTable.columns.email,
            operator: "contains",
            b: "yahoo",
          },
        ],
      });
    });

    it("should support NOT conditions", () => {
      const builder = createBuilder(usersTable.columns);

      const condition = builder.not(builder("age", ">", 65));

      expect(condition).toEqual({
        type: "not",
        item: {
          type: "compare",
          a: usersTable.columns.age,
          operator: ">",
          b: 65,
        },
      });
    });

    it("should handle boolean shortcuts in AND", () => {
      const builder = createBuilder(usersTable.columns);

      // true in AND should be ignored
      expect(builder.and(true, builder("age", ">", 18))).toEqual({
        type: "and",
        items: [
          {
            type: "compare",
            a: usersTable.columns.age,
            operator: ">",
            b: 18,
          },
        ],
      });

      // false in AND should short-circuit
      expect(builder.and(false, builder("age", ">", 18))).toBe(false);

      // all true should return true
      expect(builder.and(true, true)).toBe(true);
    });

    it("should handle boolean shortcuts in OR", () => {
      const builder = createBuilder(usersTable.columns);

      // true in OR should short-circuit
      expect(builder.or(true, builder("age", ">", 18))).toBe(true);

      // false in OR should be ignored
      expect(builder.or(false, builder("age", ">", 18))).toEqual({
        type: "or",
        items: [
          {
            type: "compare",
            a: usersTable.columns.age,
            operator: ">",
            b: 18,
          },
        ],
      });

      // all false should return false
      expect(builder.or(false, false)).toBe(false);
    });

    it("should throw on invalid column name", () => {
      const builder = createBuilder(usersTable.columns);

      expect(() => builder("nonexistent" as "email", "=", "test")).toThrow(
        "Invalid column name nonexistent",
      );
    });

    it("should throw on unsupported operator", () => {
      const builder = createBuilder(usersTable.columns);

      expect(() => builder("email", "invalid" as "=", "test")).toThrow(
        "Unsupported operator: invalid",
      );
    });
  });

  describe("createIndexedBuilder", () => {
    it("should allow comparisons on indexed columns", () => {
      const indexedColumns = new Set(["id", "email", "name", "age"]);
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      const condition = builder("email", "=", "test@example.com");
      expect(condition).toEqual({
        type: "compare",
        a: usersTable.columns.email,
        operator: "=",
        b: "test@example.com",
      });
    });

    it("should allow comparisons on multiple indexed columns", () => {
      const indexedColumns = new Set(["id", "email", "name", "age"]);
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      const condition = builder.and(builder("name", "=", "Alice"), builder("age", ">", 18));

      expect(condition).toEqual({
        type: "and",
        items: [
          {
            type: "compare",
            a: usersTable.columns.name,
            operator: "=",
            b: "Alice",
          },
          {
            type: "compare",
            a: usersTable.columns.age,
            operator: ">",
            b: 18,
          },
        ],
      });
    });

    it("should throw error when using non-indexed column", () => {
      // Only email is indexed
      const indexedColumns = new Set(["email"]);
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      expect(() => builder("name", "=", "Alice")).toThrow(
        'Column "name" is not indexed. Only indexed columns can be used in Unit of Work queries. Available indexed columns: email',
      );
    });

    it("should throw error with helpful message listing available columns", () => {
      const indexedColumns = new Set(["id", "email"]);
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      expect(() => builder("age", ">", 18)).toThrow(
        'Column "age" is not indexed. Only indexed columns can be used in Unit of Work queries. Available indexed columns: id, email',
      );
    });

    it("should support all builder methods with indexed columns", () => {
      const indexedColumns = new Set(["id", "email", "name"]);
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      // Test various builder methods
      expect(builder.isNull("email")).toEqual({
        type: "compare",
        a: usersTable.columns.email,
        operator: "is",
        b: null,
      });

      expect(builder.isNotNull("name")).toEqual({
        type: "compare",
        a: usersTable.columns.name,
        operator: "is not",
        b: null,
      });

      const orCondition = builder.or(
        builder("email", "contains", "gmail"),
        builder("email", "contains", "yahoo"),
      );
      expect(orCondition).toEqual({
        type: "or",
        items: [
          {
            type: "compare",
            a: usersTable.columns.email,
            operator: "contains",
            b: "gmail",
          },
          {
            type: "compare",
            a: usersTable.columns.email,
            operator: "contains",
            b: "yahoo",
          },
        ],
      });

      const notCondition = builder.not(builder("name", "=", "Bob"));
      expect(notCondition).toEqual({
        type: "not",
        item: {
          type: "compare",
          a: usersTable.columns.name,
          operator: "=",
          b: "Bob",
        },
      });
    });

    it("should support array operators on indexed columns", () => {
      const indexedColumns = new Set(["name"]);
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      const condition = builder("name", "in", ["Alice", "Bob", "Charlie"]);
      expect(condition).toEqual({
        type: "compare",
        a: usersTable.columns.name,
        operator: "in",
        b: ["Alice", "Bob", "Charlie"],
      });
    });

    it("should allow empty indexed columns set to reject all comparisons", () => {
      const indexedColumns = new Set<string>();
      const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

      expect(() => builder("id", "=", "123")).toThrow(
        'Column "id" is not indexed. Only indexed columns can be used in Unit of Work queries. Available indexed columns: ',
      );
    });
  });
});
