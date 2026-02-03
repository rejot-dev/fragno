import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../../schema/create";
import { mapSelect, extendSelect } from "./select-builder";

describe("select-builder", () => {
  const testSchema = schema("test", (s) => {
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

  describe("mapSelect", () => {
    it("should map select clause with array of keys", () => {
      const result = mapSelect(["id", "name", "email"], usersTable, undefined);
      expect(result).toEqual([
        "users.id as id",
        "users.name as name",
        "users.email as email",
        "users._internalId as _internalId",
        "users._version as _version",
      ]);
    });

    it("should map select all columns when true", () => {
      const result = mapSelect(true, usersTable, undefined);
      expect(result).toEqual([
        "users.id as id",
        "users.name as name",
        "users.email as email",
        "users.age as age",
        "users.isActive as isActive",
        "users.createdAt as createdAt",
        "users._internalId as _internalId",
        "users._version as _version",
      ]);
    });

    it("should map select with relation prefix", () => {
      const result = mapSelect(["id", "name"], usersTable, undefined, {
        relation: "author",
      });
      expect(result).toEqual([
        "users.id as author:id",
        "users.name as author:name",
        "users._internalId as author:_internalId",
        "users._version as author:_version",
      ]);
    });

    it("should map select with custom table name", () => {
      const result = mapSelect(["id", "title"], postsTable, undefined, {
        tableName: "p",
      });
      expect(result).toEqual([
        "p.id as id",
        "p.title as title",
        "p._internalId as _internalId",
        "p._version as _version",
      ]);
    });

    it("should map select with both relation and custom table name", () => {
      const result = mapSelect(["id", "title"], postsTable, undefined, {
        relation: "posts",
        tableName: "p",
      });
      expect(result).toEqual([
        "p.id as posts:id",
        "p.title as posts:title",
        "p._internalId as posts:_internalId",
        "p._version as posts:_version",
      ]);
    });

    it("should handle single column select", () => {
      const result = mapSelect(["name"], usersTable, undefined);
      expect(result).toEqual([
        "users.name as name",
        "users._internalId as _internalId",
        "users._version as _version",
      ]);
    });

    it("should skip hidden columns when explicitly selecting", () => {
      // When an array is passed, hidden columns should not be included in the select
      // (unless they are in the array), but they should always be added at the end
      const result = mapSelect(["name", "email"], usersTable, undefined);
      // Should not duplicate _internalId or _version in the main select
      expect(result).toEqual([
        "users.name as name",
        "users.email as email",
        "users._internalId as _internalId",
        "users._version as _version",
      ]);
    });

    it("should always include hidden columns", () => {
      // Hidden columns (_internalId, _version) should always be included
      const result = mapSelect(["name"], usersTable, undefined);
      expect(result.some((col) => col.includes("_internalId"))).toBe(true);
      expect(result.some((col) => col.includes("_version"))).toBe(true);
    });

    it("should handle empty select array", () => {
      const result = mapSelect([], usersTable, undefined);
      // Should still include hidden columns
      expect(result).toEqual(["users._internalId as _internalId", "users._version as _version"]);
    });

    it("should work with different table schemas", () => {
      const result = mapSelect(["id", "title", "content"], postsTable, undefined);
      expect(result).toEqual([
        "posts.id as id",
        "posts.title as title",
        "posts.content as content",
        "posts._internalId as _internalId",
        "posts._version as _version",
      ]);
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

    it("should handle multiple extends with duplicates", () => {
      const builder = extendSelect(["name"]);
      builder.extend("id");
      builder.extend("email");
      builder.extend("id"); // Duplicate
      const compiled = builder.compile();

      // Should not duplicate 'id'
      expect(compiled.result).toEqual(["name", "id", "email"]);
      expect(compiled.extendedKeys).toEqual(["id", "email"]);
    });

    it("should return mutated record from removeExtendedKeys", () => {
      const builder = extendSelect(["name"]);
      builder.extend("id");
      const compiled = builder.compile();

      const record = { id: "123", name: "John" };
      const result = compiled.removeExtendedKeys(record);

      // Should return the same record (mutated)
      expect(result).toBe(record);
      expect(result).toEqual({ name: "John" });
    });

    it("should handle extending with empty original select", () => {
      const builder = extendSelect([]);
      builder.extend("id");
      builder.extend("name");
      const compiled = builder.compile();

      expect(compiled.result).toEqual(["id", "name"]);
      expect(compiled.extendedKeys).toEqual(["id", "name"]);
    });

    it("should preserve original select order", () => {
      const builder = extendSelect(["email", "name"]);
      builder.extend("id");
      const compiled = builder.compile();

      expect(compiled.result).toEqual(["email", "name", "id"]);
    });
  });
});
