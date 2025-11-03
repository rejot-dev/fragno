import { describe, it, expect } from "vitest";
import { decodeCursor, createCursorFromRecord, serializeCursorValues, Cursor } from "./cursor";
import { column, idColumn, schema } from "../schema/create";

describe("Cursor utilities", () => {
  describe("Cursor class encode and decode", () => {
    it("should encode and decode a cursor with simple values", () => {
      const cursor = new Cursor({
        indexName: "idx_test",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: "user123" },
      });

      const encoded = cursor.encode();
      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe("string");

      const decoded = decodeCursor(encoded);
      expect(decoded.indexName).toBe("idx_test");
      expect(decoded.indexValues).toEqual({ id: "user123" });
    });

    it("should encode and decode a cursor with multiple index values", () => {
      const cursor = new Cursor({
        indexName: "idx_created",
        orderDirection: "desc",
        pageSize: 20,
        indexValues: {
          createdAt: 1234567890,
          id: "user123",
          name: "Alice",
        },
      });

      const encoded = cursor.encode();
      const decoded = decodeCursor(encoded);
      expect(decoded.indexValues).toEqual(cursor.indexValues);
      expect(decoded.pageSize).toBe(20);
    });

    it("should handle different data types in index values", () => {
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: {
          stringValue: "test",
          numberValue: 42,
          boolValue: true,
          nullValue: null,
        },
      });

      const encoded = cursor.encode();
      const decoded = decodeCursor(encoded);
      expect(decoded.indexValues).toEqual(cursor.indexValues);
    });

    it("should produce base64-encoded strings", () => {
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: "test" },
      });

      const encoded = cursor.encode();

      // Base64 pattern - should only contain valid base64 characters
      expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Should be decodeable
      const decoded = decodeCursor(encoded);
      expect(decoded.indexValues).toEqual(cursor.indexValues);
    });

    it("should handle empty index values", () => {
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: {},
      });

      const encoded = cursor.encode();
      const decoded = decodeCursor(encoded);
      expect(decoded.indexValues).toEqual({});
    });
  });

  describe("decodeCursor error handling", () => {
    it("should throw error for invalid base64", () => {
      expect(() => decodeCursor("not-valid-base64!!!")).toThrow(/invalid cursor/i);
    });

    it("should throw error for invalid JSON", () => {
      // Encode invalid JSON as base64
      const invalidJson = Buffer.from("{not valid json}", "utf-8").toString("base64");
      expect(() => decodeCursor(invalidJson)).toThrow(/invalid cursor/i);
    });

    it("should throw error for missing indexValues", () => {
      const invalidData = { v: 1, indexName: "test", orderDirection: "asc", pageSize: 10 };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for missing indexName", () => {
      const invalidData = {
        v: 1,
        indexValues: { id: "test" },
        orderDirection: "asc",
        pageSize: 10,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for invalid orderDirection value", () => {
      const invalidData = {
        v: 1,
        indexValues: { id: "test" },
        indexName: "test",
        orderDirection: "sideways",
        pageSize: 10,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for non-object indexValues", () => {
      const invalidData = {
        v: 1,
        indexValues: "not an object",
        indexName: "test",
        orderDirection: "asc",
        pageSize: 10,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });
  });

  describe("createCursorFromRecord", () => {
    it("should create a cursor from a record with single column index", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const table = testSchema.tables.users;
      const record = { id: "user123", name: "Alice" };
      const indexColumns = [table.columns.id];

      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
      });

      expect(cursor).toBeInstanceOf(Cursor);

      const decoded = decodeCursor(cursor.encode());
      expect(decoded.indexValues).toEqual({ id: "user123" });
    });

    it("should create a cursor from a record with multi-column index", () => {
      const testSchema = schema((s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("integer"))
            .addColumn("userId", column("string"))
            .addColumn("title", column("string"))
            .createIndex("created_user", ["createdAt", "userId"]),
        ),
      );

      const table = testSchema.tables.posts;
      const record = {
        id: "post123",
        createdAt: 1234567890,
        userId: "user456",
        title: "Test Post",
      };

      const index = table.indexes.created_user;
      const indexColumns = index.columns;

      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "created_user",
        orderDirection: "desc",
        pageSize: 10,
      });

      const decoded = decodeCursor(cursor.encode());
      expect(decoded.indexValues).toEqual({
        createdAt: 1234567890,
        userId: "user456",
      });
    });

    it("should only include columns that are in the index", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string")),
        ),
      );

      const table = testSchema.tables.users;
      const record = { id: "user123", name: "Alice", email: "alice@example.com" };
      const indexColumns = [table.columns.id];

      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
      });

      const decoded = decodeCursor(cursor.encode());
      expect(decoded.indexValues).toEqual({ id: "user123" });
      expect(Object.keys(decoded.indexValues)).toHaveLength(1);
    });
  });

  describe("serializeCursorValues", () => {
    it("should serialize cursor values for database queries", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("age", column("integer")),
        ),
      );

      const table = testSchema.tables.users;
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: "user123", age: 25 },
      });

      const indexColumns = [table.columns.id, table.columns.age];
      const serialized = serializeCursorValues(cursor, indexColumns, "postgresql");

      expect(serialized).toHaveProperty("id", "user123");
      expect(serialized).toHaveProperty("age", 25);
    });

    it("should handle missing values in cursor data", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const table = testSchema.tables.users;
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: "user123" },
      });

      const indexColumns = [table.columns.id, table.columns.name];
      const serialized = serializeCursorValues(cursor, indexColumns, "postgresql");

      expect(serialized).toHaveProperty("id", "user123");
      expect(serialized).not.toHaveProperty("name");
    });
  });

  describe("round-trip integration", () => {
    it("should successfully round-trip cursor data through encode/decode", () => {
      const testSchema = schema((s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("integer"))
            .addColumn("score", column("integer"))
            .createIndex("trending", ["score", "createdAt"]),
        ),
      );

      const table = testSchema.tables.posts;
      const record = {
        id: "post123",
        createdAt: 1234567890,
        score: 42,
      };

      const index = table.indexes.trending;
      const indexColumns = index.columns;

      // Create cursor from record
      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "trending",
        orderDirection: "asc",
        pageSize: 10,
      });

      // Decode it
      const decoded = decodeCursor(cursor.encode());

      // Serialize the values
      const serialized = serializeCursorValues(decoded, indexColumns, "postgresql");

      // Should preserve the values
      expect(serialized["score"]).toBe(42);
      expect(serialized["createdAt"]).toBe(1234567890);
    });

    it("should handle different order directions correctly", () => {
      const cursorAsc = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: "test" },
      });

      const cursorDesc = new Cursor({
        indexName: "_primary",
        orderDirection: "desc",
        pageSize: 10,
        indexValues: { id: "test" },
      });

      expect(cursorAsc.encode()).not.toBe(cursorDesc.encode());

      const decodedAsc = decodeCursor(cursorAsc.encode());
      const decodedDesc = decodeCursor(cursorDesc.encode());

      expect(decodedAsc.orderDirection).toBe("asc");
      expect(decodedDesc.orderDirection).toBe("desc");
    });
  });
});
