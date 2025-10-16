import { assert, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema, FragnoId } from "../schema/create";
import { decodeResult, encodeValues, ReferenceSubquery } from "./result-transform";

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
      })
      .addReference("posts", "author", {
        columns: ["userId"],
        targetTable: "users",
        targetColumns: ["id"],
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
      expect(result["userId"]).instanceOf(ReferenceSubquery);
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
        userId: expect.any(ReferenceSubquery),
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

  describe("FragnoId encoding", () => {
    it("should encode FragnoId with external ID only", () => {
      const fragnoId = FragnoId.fromExternal("user123", 1);
      const result = encodeValues({ id: fragnoId, name: "John" }, usersTable, false, "postgresql");

      expect(result).toEqual({
        id: "user123",
        name: "John",
      });
    });

    it("should encode FragnoId with both IDs", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });
      const result = encodeValues({ id: fragnoId, name: "John" }, usersTable, false, "postgresql");

      expect(result).toEqual({
        id: "user123",
        name: "John",
      });
    });

    it("should encode FragnoId in reference columns", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });
      const result = encodeValues(
        { title: "Test Post", userId: fragnoId },
        postsTable,
        false,
        "postgresql",
      );

      // Reference columns should use the internal ID (bigint)
      expect(result).toEqual({
        title: "Test Post",
        userId: BigInt(456),
      });
    });

    it("should fallback to external ID for reference when internal ID unavailable", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        version: 1,
      });
      const result = encodeValues(
        { title: "Test Post", userId: fragnoId },
        postsTable,
        false,
        "postgresql",
      );

      expect(result).toEqual({
        title: "Test Post",
        userId: "user123",
      });
    });

    it("should handle FragnoId across different providers", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });
      const testData = { id: fragnoId, name: "John" };

      // Test across providers
      const sqliteResult = encodeValues(testData, usersTable, false, "sqlite");
      const postgresqlResult = encodeValues(testData, usersTable, false, "postgresql");
      const mysqlResult = encodeValues(testData, usersTable, false, "mysql");

      expect(sqliteResult).toEqual({ id: "user123", name: "John" });
      expect(postgresqlResult).toEqual({ id: "user123", name: "John" });
      expect(mysqlResult).toEqual({ id: "user123", name: "John" });
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

    it("should transform id columns in relations to FragnoId when _internalId and _version are present", () => {
      const result = decodeResult(
        {
          id: "post1",
          _internalId: BigInt(100),
          _version: 0,
          title: "My Post",
          "author:id": "user1",
          "author:_internalId": BigInt(200),
          "author:_version": 0,
          "author:name": "Alice",
        },
        postsTable,
        "sqlite",
      );

      // Main table id should be FragnoId
      assert(result["id"] instanceof FragnoId);
      expect(result["id"].externalId).toBe("post1");
      expect(result["id"].internalId).toBe(BigInt(100));

      // Relation id should also be FragnoId (THIS IS THE BUG WE'RE FIXING)
      expect(result["author"]).toBeDefined();
      const author = result["author"] as Record<string, unknown>;
      assert(author["id"] instanceof FragnoId);
      expect(author["id"].externalId).toBe("user1");
      expect(author["id"].internalId).toBe(BigInt(200));
      expect(author["name"]).toBe("Alice");
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

  describe("FragnoId decoding", () => {
    it("should create FragnoId when both external and internal IDs are present", () => {
      const result = decodeResult(
        {
          id: "user123",
          _internalId: 456,
          name: "John",
        },
        usersTable,
        "postgresql",
      );

      const fragnoId = result["id"];
      assert(fragnoId instanceof FragnoId);

      expect(fragnoId.externalId).toBe("user123");
      expect(fragnoId.internalId).toBe(456);
      expect(result["name"]).toBe("John");
    });

    it("should create FragnoId from string internal ID", () => {
      const result = decodeResult(
        {
          id: "user123",
          _internalId: "456",
          name: "John",
        },
        usersTable,
        "postgresql",
      );

      const fragnoId = result["id"];
      assert(fragnoId instanceof FragnoId);

      expect(fragnoId.externalId).toBe("user123");
      expect(fragnoId.internalId).toBe(BigInt(456));
      expect(result["name"]).toBe("John");
    });

    it("should return regular string when internal ID is missing", () => {
      const result = decodeResult(
        {
          id: "user123",
          name: "John",
        },
        usersTable,
        "postgresql",
      );

      expect(result).toEqual({
        id: "user123",
        name: "John",
      });
      expect(result["id"]).not.toBeInstanceOf(FragnoId);
    });

    it("should handle FragnoId creation across different providers", () => {
      const testData = {
        id: "user123",
        _internalId: 456,
        name: "John",
      };

      // Test across providers
      const sqliteResult = decodeResult(testData, usersTable, "sqlite");
      const postgresqlResult = decodeResult(testData, usersTable, "postgresql");
      const mysqlResult = decodeResult(testData, usersTable, "mysql");

      // All should create FragnoId objects
      expect(sqliteResult["id"]).toBeInstanceOf(FragnoId);
      expect(postgresqlResult["id"]).toBeInstanceOf(FragnoId);
      expect(mysqlResult["id"]).toBeInstanceOf(FragnoId);

      expect((sqliteResult["id"] as FragnoId).externalId).toBe("user123");
      expect((sqliteResult["id"] as FragnoId).internalId).toBe(456);
    });

    it("should create FragnoId in relation data when both IDs present", () => {
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "author:id": "user123",
          "author:_internalId": 456,
          "author:_version": 0,
          "author:name": "Alice",
        },
        postsTable,
        "postgresql",
      );

      expect(result["id"]).toBe("post1");
      expect(result["title"]).toBe("My Post");
      // Relations now correctly create FragnoId objects when both IDs are present (thanks to recursive decoding)
      const author: Record<string, unknown> = result["author"] as Record<string, unknown>;
      assert(author["id"] instanceof FragnoId);
      expect(author["id"].externalId).toBe("user123");
      expect(author["id"].internalId).toBe(456);
      expect(author["name"]).toBe("Alice");
    });

    it("should return regular string in relation data when internal ID missing", () => {
      const result = decodeResult(
        {
          id: "post1",
          title: "My Post",
          "author:id": "user123",
          "author:name": "Alice",
        },
        postsTable,
        "postgresql",
      );

      expect(result).toEqual({
        id: "post1",
        title: "My Post",
        author: {
          id: "user123",
          name: "Alice",
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result["author"] as any)["id"]).not.toBeInstanceOf(FragnoId);
    });

    it("should handle complete record with FragnoId creation", () => {
      const timestamp = 1705317000000;
      const result = decodeResult(
        {
          id: "user123",
          _internalId: 456,
          name: "Alice",
          email: "alice@example.com",
          age: 30,
          isActive: true,
          createdAt: timestamp,
        },
        usersTable,
        "sqlite",
      );

      expect(result["id"]).toBeInstanceOf(FragnoId);
      expect((result["id"] as FragnoId).externalId).toBe("user123");
      expect((result["id"] as FragnoId).internalId).toBe(456);
      expect(result["name"]).toBe("Alice");
      expect(result["email"]).toBe("alice@example.com");
      expect(result["age"]).toBe(30);
      expect(result["isActive"]).toBe(true);
      expect(result["createdAt"]).toEqual(new Date(timestamp));
    });

    it("should handle FragnoId with numeric internal ID from database", () => {
      const result = decodeResult(
        {
          id: "user123",
          _internalId: 789, // Numeric from database
          name: "John",
        },
        usersTable,
        "postgresql",
      );

      expect(result["id"]).toBeInstanceOf(FragnoId);
      expect((result["id"] as FragnoId).externalId).toBe("user123");
      expect((result["id"] as FragnoId).internalId).toBe(789);
      expect(result["name"]).toBe("John");
    });
  });
});
