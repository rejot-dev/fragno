import { describe, expect, it } from "vitest";
import {
  column,
  FragnoId,
  FragnoReference,
  idColumn,
  schema,
  referenceColumn,
} from "../schema/create";
import {
  resolveFragnoIdValue,
  encodeValues,
  encodeValuesWithDbDefaults,
  ReferenceSubquery,
} from "./value-encoding";

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
    it("should resolve string values", () => {
      const result = encodeValues(
        { id: "user1", name: "John", email: "john@example.com" },
        usersTable,
        false,
      );

      expect(result).toEqual({
        id: "user1",
        name: "John",
        email: "john@example.com",
      });
    });

    it("should resolve integer values", () => {
      const result = encodeValues({ age: 25 }, usersTable, false);

      expect(result).toEqual({ age: 25 });
    });

    it("should resolve boolean values (not serialized)", () => {
      const result = encodeValues({ isActive: true }, usersTable, false);

      // Boolean stays as boolean (not converted to 0/1)
      expect(result).toEqual({ isActive: true });
    });
  });

  describe("date encoding", () => {
    it("should keep Date as Date (not serialized)", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encodeValues({ createdAt: date }, usersTable, false);

      // Date stays as Date (serialization happens later in encoder)
      expect(result).toEqual({ createdAt: date });
    });
  });

  describe("nullable columns", () => {
    it("should handle null values", () => {
      const result = encodeValues({ age: null }, usersTable, false);

      expect(result).toEqual({ age: null });
    });

    it("should omit undefined values", () => {
      const result = encodeValues({ age: undefined }, usersTable, false);

      expect(result).toEqual({});
    });

    it("should handle nullable timestamp", () => {
      const result = encodeValues({ publishedAt: null }, postsTable, false);

      expect(result).toEqual({ publishedAt: null });
    });
  });

  describe("default value generation", () => {
    it("should generate runtime defaults when generateDefault is true", () => {
      const result = encodeValues({ title: "Test Post", userId: "user1" }, postsTable, true);

      expect(result["title"]).toBe("Test Post");
      expect(result["userId"]).toBeInstanceOf(ReferenceSubquery);
      // viewCount has static default (defaultTo), so it's omitted to let DB handle it
      expect(result["viewCount"]).toBeUndefined();
      expect(result["id"]).toBeDefined();
      expect(typeof result["id"]).toBe("string");
    });

    it("should not generate default values when generateDefault is false", () => {
      const result = encodeValues({ title: "Test Post", userId: "user1" }, postsTable, false);

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
      );

      expect(result["viewCount"]).toBe(100);
    });

    it("should use injected runtime defaults when provided", () => {
      const testDate = new Date("2024-02-01T00:00:00Z");
      const testSchemaWithDefaults = schema((s) =>
        s.addTable("entries", (t) =>
          t.addColumn("id", idColumn()).addColumn(
            "createdAt",
            column("timestamp").defaultTo$((b) => b.now()),
          ),
        ),
      );
      const entriesTable = testSchemaWithDefaults.tables.entries;

      const result = encodeValues({}, entriesTable, true, {
        createId: () => "entry_1",
        now: () => testDate,
      });

      expect(result["id"]).toBe("entry_1");
      expect(result["createdAt"]).toBe(testDate);
    });
  });

  describe("database defaults in memory", () => {
    it("should apply static and dbSpecial defaults when requested", () => {
      const testDate = new Date("2024-03-01T00:00:00Z");
      const testSchemaWithDbDefaults = schema((s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("status", column("string").defaultTo("draft"))
            .addColumn(
              "createdAt",
              column("timestamp").defaultTo((b) => b.now()),
            ),
        ),
      );
      const postsTable = testSchemaWithDbDefaults.tables.posts;

      const result = encodeValuesWithDbDefaults({ title: "Hello" }, postsTable, {
        createId: () => "post_1",
        now: () => testDate,
      });

      expect(result).toEqual({
        id: "post_1",
        title: "Hello",
        _version: 0,
        status: "draft",
        createdAt: testDate,
      });
    });

    it("should not override explicit values when applying db defaults", () => {
      const testSchemaWithDbDefaults = schema((s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("status", column("string").defaultTo("draft")),
        ),
      );
      const postsTable = testSchemaWithDbDefaults.tables.posts;

      const result = encodeValuesWithDbDefaults(
        { title: "Hello", status: "published" },
        postsTable,
        { createId: () => "post_2" },
      );

      expect(result).toEqual({
        id: "post_2",
        title: "Hello",
        _version: 0,
        status: "published",
      });
    });
  });

  describe("complete record encoding", () => {
    it("should resolve all fields correctly (without serialization)", () => {
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
      );

      // Values are resolved but NOT serialized (Date stays as Date, boolean stays as boolean)
      expect(result).toEqual({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
        age: 30,
        isActive: false, // Not serialized to 0
        createdAt: date, // Not serialized to timestamp
      });
    });
  });

  describe("FragnoId encoding", () => {
    it("should resolve FragnoId with external ID only", () => {
      const fragnoId = FragnoId.fromExternal("user123", 1);
      const result = encodeValues({ id: fragnoId, name: "John" }, usersTable, false);

      expect(result).toEqual({
        id: "user123",
        name: "John",
      });
    });

    it("should resolve FragnoId with both IDs", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });
      const result = encodeValues({ id: fragnoId, name: "John" }, usersTable, false);

      expect(result).toEqual({
        id: "user123",
        name: "John",
      });
    });

    it("should resolve FragnoId in reference columns", () => {
      const fragnoId = new FragnoId({
        externalId: "user123",
        internalId: BigInt(456),
        version: 1,
      });
      const result = encodeValues({ title: "Test Post", userId: fragnoId }, postsTable, false);

      // Reference columns should use the internal ID (bigint, not serialized)
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
      const result = encodeValues({ title: "Test Post", userId: fragnoId }, postsTable, false);

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

      // Test that provider-agnostic resolution works
      const result = encodeValues(testData, usersTable, false);

      expect(result).toEqual({ id: "user123", name: "John" });
    });

    it("should handle ReferenceSubquery correctly", () => {
      const fragnoId = FragnoId.fromExternal("user123", 1);
      const result = encodeValues({ id: fragnoId, name: "John" }, usersTable, false);

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
