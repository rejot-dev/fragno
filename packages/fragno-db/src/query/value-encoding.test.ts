import { describe, expect, it } from "vitest";
import {
  column,
  FragnoId,
  FragnoReference,
  idColumn,
  schema,
  referenceColumn,
} from "../schema/create";
import { resolveFragnoIdValue, encodeValues, ReferenceSubquery } from "./value-encoding";

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
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
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
    it("should generate runtime defaults when generateDefault is true", () => {
      const result = encodeValues(
        { title: "Test Post", userId: "user1" },
        postsTable,
        true,
        "sqlite",
      );

      expect(result["title"]).toBe("Test Post");
      expect(result["userId"]).toBeInstanceOf(ReferenceSubquery);
      // viewCount has static default (defaultTo), so it's omitted to let DB handle it
      expect(result["viewCount"]).toBeUndefined();
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

    it("should convert FragnoId without internalId to ReferenceSubquery for reference columns", () => {
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

      // FragnoId without internalId should be converted to ReferenceSubquery for database lookup
      expect(result["title"]).toBe("Test Post");
      expect(result["userId"]).toBeInstanceOf(ReferenceSubquery);
      expect((result["userId"] as ReferenceSubquery).externalIdValue).toBe("user123");
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

  describe("skipDriverConversions parameter", () => {
    it("should skip Date to number conversion for sqlite when skipDriverConversions is true", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues({ createdAt: date }, usersTable, false, "sqlite", true);

      // Date should remain as Date object, not converted to timestamp
      expect(result).toEqual({ createdAt: date });
    });

    it("should skip boolean to number conversion for sqlite when skipDriverConversions is true", () => {
      const result = encodeValues({ isActive: true }, usersTable, false, "sqlite", true);

      // Boolean should remain as boolean, not converted to 1
      expect(result).toEqual({ isActive: true });
    });

    it("should skip bigint to Buffer conversion for sqlite when skipDriverConversions is true", () => {
      const schemaWithBigInt = schema((s) => {
        return s.addTable("items", (t) => {
          return t.addColumn("id", idColumn()).addColumn("count", column("bigint"));
        });
      });

      const result = encodeValues(
        { count: BigInt(12345) },
        schemaWithBigInt.tables.items,
        false,
        "sqlite",
        true,
      );

      // BigInt should remain as bigint, not converted to Buffer
      expect(result).toEqual({ count: BigInt(12345) });
    });

    it("should still perform conversions for sqlite when skipDriverConversions is false", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues(
        { createdAt: date, isActive: true },
        usersTable,
        false,
        "sqlite",
        false,
      );

      // Conversions should happen as normal
      expect(result).toEqual({ createdAt: date.getTime(), isActive: 1 });
    });

    it("should not affect PostgreSQL encoding (no conversions to skip)", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const resultWithSkip = encodeValues(
        { createdAt: date },
        usersTable,
        false,
        "postgresql",
        true,
      );
      const resultWithoutSkip = encodeValues(
        { createdAt: date },
        usersTable,
        false,
        "postgresql",
        false,
      );

      // Both should be the same since PostgreSQL doesn't do these conversions
      expect(resultWithSkip).toEqual({ createdAt: date });
      expect(resultWithoutSkip).toEqual({ createdAt: date });
    });

    it("should work with complete record encoding when skipDriverConversions is true", () => {
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
        true,
      );

      // All values should remain in their original types
      expect(result).toEqual({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
        age: 30,
        isActive: false, // Not converted to 0
        createdAt: date, // Not converted to timestamp
      });
    });

    it("should still handle FragnoId and ReferenceSubquery correctly with skipDriverConversions", () => {
      const fragnoId = FragnoId.fromExternal("user123", 1);
      const result = encodeValues(
        { id: fragnoId, name: "John" },
        usersTable,
        false,
        "sqlite",
        true,
      );

      // FragnoId handling should still work
      expect(result).toEqual({
        id: "user123",
        name: "John",
      });

      // Test ReferenceSubquery
      const refResult = encodeValues(
        { title: "Test Post", userId: "user_external_id" },
        postsTable,
        false,
        "sqlite",
        true,
      );

      expect(refResult["title"]).toBe("Test Post");
      expect(refResult["userId"]).toBeInstanceOf(ReferenceSubquery);
    });
  });
});

describe("resolveFragnoIdValue", () => {
  describe("FragnoReference handling", () => {
    it("should extract internal ID from FragnoReference", () => {
      const ref = FragnoReference.fromInternal(BigInt(123));
      const col = column("bigint");
      col.role = "reference";

      const result = resolveFragnoIdValue(ref, col);

      expect(result).toBe(BigInt(123));
    });
  });

  describe("FragnoId handling for external-id columns", () => {
    it("should extract external ID from FragnoId", () => {
      const externalIdCol = column("string");
      externalIdCol.role = "external-id";
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });

      const result = resolveFragnoIdValue(fragnoId, externalIdCol);

      expect(result).toBe("user123");
    });

    it("should work with FragnoId created from fromExternal", () => {
      const externalIdCol = column("string");
      externalIdCol.role = "external-id";
      const fragnoId = FragnoId.fromExternal("user789", 2);

      const result = resolveFragnoIdValue(fragnoId, externalIdCol);

      expect(result).toBe("user789");
    });
  });

  describe("FragnoId handling for internal-id columns", () => {
    it("should extract internal ID from FragnoId", () => {
      const internalIdCol = column("bigint");
      internalIdCol.role = "internal-id";
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });

      const result = resolveFragnoIdValue(fragnoId, internalIdCol);

      expect(result).toBe(BigInt(456));
    });

    it("should throw error when FragnoId lacks internal ID", () => {
      const internalIdCol = column("bigint");
      internalIdCol.role = "internal-id";
      const fragnoId = FragnoId.fromExternal("user123", 1);

      expect(() => resolveFragnoIdValue(fragnoId, internalIdCol)).toThrow(
        "FragnoId must have internalId for internal-id column",
      );
    });
  });

  describe("FragnoId handling for reference columns", () => {
    it("should prefer internal ID when available", () => {
      const referenceCol = column("bigint");
      referenceCol.role = "reference";
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });

      const result = resolveFragnoIdValue(fragnoId, referenceCol);

      expect(result).toBe(BigInt(456));
    });

    it("should fallback to external ID when internal ID unavailable", () => {
      const referenceCol = column("bigint");
      referenceCol.role = "reference";
      const fragnoId = FragnoId.fromExternal("user123", 1);

      const result = resolveFragnoIdValue(fragnoId, referenceCol);

      expect(result).toBe("user123");
    });
  });

  describe("FragnoId handling for regular columns", () => {
    it("should use external ID for regular columns", () => {
      const regularCol = column("string");
      regularCol.role = "regular";
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });

      const result = resolveFragnoIdValue(fragnoId, regularCol);

      expect(result).toBe("user123");
    });
  });

  describe("non-FragnoId values", () => {
    it("should pass through strings", () => {
      const col = column("string");
      const result = resolveFragnoIdValue("hello", col);
      expect(result).toBe("hello");
    });

    it("should pass through numbers", () => {
      const col = column("integer");
      const result = resolveFragnoIdValue(42, col);
      expect(result).toBe(42);
    });

    it("should pass through dates", () => {
      const col = column("timestamp");
      const date = new Date();
      const result = resolveFragnoIdValue(date, col);
      expect(result).toBe(date);
    });

    it("should pass through null", () => {
      const col = column("string").nullable();
      const result = resolveFragnoIdValue(null, col);
      expect(result).toBe(null);
    });

    it("should pass through bigint", () => {
      const col = column("bigint");
      const result = resolveFragnoIdValue(BigInt(999), col);
      expect(result).toBe(BigInt(999));
    });
  });
});
