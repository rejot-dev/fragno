import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { decodeResult, encodeValues } from "./result-transform";

describe("encodeValues", () => {
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
          .addColumn("userId", referenceColumn())
          .addColumn("viewCount", column("integer").defaultTo(0))
          .addColumn("publishedAt", column("timestamp").nullable());
      });
  });

  const usersTable = testSchema.tables.users;
  const postsTable = testSchema.tables.posts;

  describe("basic encoding", () => {
    it("should encode string values", () => {
      const result = encodeValues(
        { id: "user1", name: "John", email: "john@example.com" },
        usersTable,
        false,
        "sqlite",
      );

      expect(result).toEqual({
        id: "user1",
        name: "John",
        email: "john@example.com",
      });
    });

    it("should encode integer values", () => {
      const result = encodeValues({ age: 25 }, usersTable, false, "sqlite");

      expect(result).toEqual({ age: 25 });
    });

    it("should encode boolean values for sqlite", () => {
      const result = encodeValues({ isActive: true }, usersTable, false, "sqlite");

      expect(result).toEqual({ isActive: 1 });
    });

    it("should encode boolean values for postgresql", () => {
      const result = encodeValues({ isActive: true }, usersTable, false, "postgresql");

      expect(result).toEqual({ isActive: true });
    });
  });

  describe("date encoding", () => {
    it("should encode Date to number for sqlite", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues({ createdAt: date }, usersTable, false, "sqlite");

      expect(result).toEqual({ createdAt: date.getTime() });
    });

    it("should keep Date as Date for postgresql", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues({ createdAt: date }, usersTable, false, "postgresql");

      expect(result).toEqual({ createdAt: date });
    });

    it("should keep Date as Date for mysql", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues({ createdAt: date }, usersTable, false, "mysql");

      expect(result).toEqual({ createdAt: date });
    });
  });

  describe("nullable columns", () => {
    it("should handle null values", () => {
      const result = encodeValues({ age: null }, usersTable, false, "sqlite");

      expect(result).toEqual({ age: null });
    });

    it("should omit undefined values", () => {
      const result = encodeValues({ age: undefined }, usersTable, false, "sqlite");

      expect(result).toEqual({});
    });

    it("should handle nullable timestamp", () => {
      const result = encodeValues({ publishedAt: null }, postsTable, false, "sqlite");

      expect(result).toEqual({ publishedAt: null });
    });
  });

  describe("default value generation", () => {
    it("should generate default values when generateDefault is true", () => {
      const result = encodeValues(
        { title: "Test Post", userId: "user1" },
        postsTable,
        true,
        "sqlite",
      );

      expect(result["title"]).toBe("Test Post");
      expect(result["userId"]).toBe("user1");
      expect(result["viewCount"]).toBe(0);
      expect(result["id"]).toBeDefined();
      expect(typeof result["id"]).toBe("string");
    });

    it("should not generate default values when generateDefault is false", () => {
      const result = encodeValues(
        { title: "Test Post", userId: "user1" },
        postsTable,
        false,
        "sqlite",
      );

      expect(result).toEqual({
        title: "Test Post",
        userId: "user1",
      });
    });

    it("should not override explicitly provided values", () => {
      const result = encodeValues(
        { title: "Test Post", userId: "user1", viewCount: 100 },
        postsTable,
        true,
        "sqlite",
      );

      expect(result["viewCount"]).toBe(100);
    });
  });

  describe("complete record encoding", () => {
    it("should encode all fields correctly", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues(
        {
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
          age: 30,
          isActive: false,
          createdAt: date,
        },
        usersTable,
        false,
        "sqlite",
      );

      expect(result).toEqual({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
        age: 30,
        isActive: 0,
        createdAt: date.getTime(),
      });
    });
  });
});

describe("decodeResult", () => {
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
          .addColumn("viewCount", column("integer"))
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

  describe("basic decoding", () => {
    it("should decode string values", () => {
      const result = decodeResult(
        { id: "user1", name: "John", email: "john@example.com" },
        usersTable,
        "sqlite",
      );

      expect(result).toEqual({
        id: "user1",
        name: "John",
        email: "john@example.com",
      });
    });

    it("should decode integer values", () => {
      const result = decodeResult({ age: 25 }, usersTable, "sqlite");

      expect(result).toEqual({ age: 25 });
    });

    it("should decode boolean values from sqlite", () => {
      const result = decodeResult({ isActive: 1 }, usersTable, "sqlite");

      expect(result).toEqual({ isActive: true });
    });

    it("should decode boolean false from sqlite", () => {
      const result = decodeResult({ isActive: 0 }, usersTable, "sqlite");

      expect(result).toEqual({ isActive: false });
    });

    it("should decode boolean values from postgresql", () => {
      const result = decodeResult({ isActive: true }, usersTable, "postgresql");

      expect(result).toEqual({ isActive: true });
    });
  });

  describe("date decoding", () => {
    it("should decode number to Date for sqlite timestamp", () => {
      const timestamp = 1705317000000;
      const result = decodeResult({ createdAt: timestamp }, usersTable, "sqlite");

      expect(result["createdAt"]).toBeInstanceOf(Date);
      expect((result["createdAt"] as Date).getTime()).toBe(timestamp);
    });

    it("should decode ISO string to Date for sqlite timestamp", () => {
      const isoString = "2024-01-15T10:30:00.000Z";
      const result = decodeResult({ createdAt: isoString }, usersTable, "sqlite");

      expect(result["createdAt"]).toBeInstanceOf(Date);
      expect((result["createdAt"] as Date).toISOString()).toBe(isoString);
    });

    it("should keep Date as Date for postgresql", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = decodeResult({ createdAt: date }, usersTable, "postgresql");

      expect(result["createdAt"]).toBe(date);
    });
  });

  describe("nullable columns", () => {
    it("should handle null values", () => {
      const result = decodeResult({ age: null }, usersTable, "sqlite");

      expect(result).toEqual({ age: null });
    });

    it("should handle nullable timestamp", () => {
      const result = decodeResult({ publishedAt: null }, postsTable, "sqlite");

      expect(result).toEqual({ publishedAt: null });
    });
  });

  describe("relation decoding", () => {
    it("should decode relation data with colon pattern", () => {
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "author:id": "user1",
          "author:name": "Alice",
          "author:email": "alice@example.com",
        },
        postsTable,
        "sqlite",
      );

      expect(result).toEqual({
        id: "post1",
        title: "My Post",
        author: {
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        },
      });
    });

    it("should decode relation data with type conversions", () => {
      const timestamp = 1705317000000;
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "author:id": "user1",
          "author:isActive": 1,
          "author:createdAt": timestamp,
        },
        postsTable,
        "sqlite",
      );

      expect(result["author"]).toEqual({
        id: "user1",
        isActive: true,
        createdAt: new Date(timestamp),
      });
    });

    it("should skip unknown relations", () => {
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "unknownRelation:field": "value",
        },
        postsTable,
        "sqlite",
      );

      expect(result).toEqual({
        id: "post1",
        title: "My Post",
      });
    });

    it("should skip unknown columns in relations", () => {
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "author:id": "user1",
          "author:unknownField": "value",
        },
        postsTable,
        "sqlite",
      );

      expect(result).toEqual({
        id: "post1",
        title: "My Post",
        author: {
          id: "user1",
        },
      });
    });

    it("should handle multiple relations in same result", () => {
      const schemaWithMultipleRelations = schema((s) => {
        return s
          .addTable("users", (t) => {
            return t.addColumn("id", idColumn()).addColumn("name", column("string"));
          })
          .addTable("categories", (t) => {
            return t.addColumn("id", idColumn()).addColumn("name", column("string"));
          })
          .addTable("posts", (t) => {
            return t
              .addColumn("id", idColumn())
              .addColumn("title", column("string"))
              .addColumn("userId", referenceColumn())
              .addColumn("categoryId", referenceColumn());
          })
          .addReference("posts", "author", {
            columns: ["userId"],
            targetTable: "users",
            targetColumns: ["id"],
          })
          .addReference("posts", "category", {
            columns: ["categoryId"],
            targetTable: "categories",
            targetColumns: ["id"],
          });
      });

      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "author:id": "user1",
          "author:name": "Alice",
          "category:id": "cat1",
          "category:name": "Technology",
        },
        schemaWithMultipleRelations.tables.posts,
        "sqlite",
      );

      expect(result).toEqual({
        id: "post1",
        title: "My Post",
        author: {
          id: "user1",
          name: "Alice",
        },
        category: {
          id: "cat1",
          name: "Technology",
        },
      });
    });
  });

  describe("complete record decoding", () => {
    it("should decode all fields correctly", () => {
      const timestamp = 1705317000000;
      const result = decodeResult(
        {
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
          age: 30,
          isActive: 0,
          createdAt: timestamp,
        },
        usersTable,
        "sqlite",
      );

      expect(result).toEqual({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
        age: 30,
        isActive: false,
        createdAt: new Date(timestamp),
      });
    });
  });

  describe("edge cases", () => {
    it("should handle empty result", () => {
      const result = decodeResult({}, usersTable, "sqlite");

      expect(result).toEqual({});
    });

    it("should handle result with only relation data", () => {
      const result = decodeResult(
        {
          "author:id": "user1",
          "author:name": "Alice",
        },
        postsTable,
        "sqlite",
      );

      expect(result).toEqual({
        author: {
          id: "user1",
          name: "Alice",
        },
      });
    });

    it("should handle mixed regular and relation data", () => {
      const timestamp = 1705317000000;
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          viewCount: 100,
          publishedAt: timestamp,
          "author:id": "user1",
          "author:name": "Alice",
        },
        postsTable,
        "sqlite",
      );

      expect(result).toEqual({
        id: "post1",
        title: "My Post",
        viewCount: 100,
        publishedAt: new Date(timestamp),
        author: {
          id: "user1",
          name: "Alice",
        },
      });
    });
  });
});
