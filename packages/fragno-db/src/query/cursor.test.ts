import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  createCursorFromRecord,
  serializeCursorValues,
  type CursorData,
} from "./cursor";
import { column, idColumn, schema } from "../schema/create";

describe("Cursor utilities", () => {
  describe("encodeCursor and decodeCursor", () => {
    it("should encode and decode a cursor with simple values", () => {
      const cursorData: CursorData = {
        indexValues: { id: "user123" },
        direction: "forward",
      };

      const encoded = encodeCursor(cursorData);
      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe("string");

      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursorData);
    });

    it("should encode and decode a cursor with multiple index values", () => {
      const cursorData: CursorData = {
        indexValues: {
          createdAt: 1234567890,
          id: "user123",
          name: "Alice",
        },
        direction: "backward",
      };

      const encoded = encodeCursor(cursorData);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursorData);
    });

    it("should handle different data types in index values", () => {
      const cursorData: CursorData = {
        indexValues: {
          stringValue: "test",
          numberValue: 42,
          boolValue: true,
          nullValue: null,
        },
        direction: "forward",
      };

      const encoded = encodeCursor(cursorData);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursorData);
    });

    it("should produce base64-encoded strings", () => {
      const cursorData: CursorData = {
        indexValues: { id: "test" },
        direction: "forward",
      };

      const encoded = encodeCursor(cursorData);

      // Base64 pattern - should only contain valid base64 characters
      expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Should be decodeable
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursorData);
    });

    it("should handle empty index values", () => {
      const cursorData: CursorData = {
        indexValues: {},
        direction: "forward",
      };

      const encoded = encodeCursor(cursorData);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursorData);
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
      const invalidData = { direction: "forward" };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for missing direction", () => {
      const invalidData = { indexValues: { id: "test" } };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for invalid direction value", () => {
      const invalidData = { indexValues: { id: "test" }, direction: "sideways" };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for non-object indexValues", () => {
      const invalidData = { indexValues: "not an object", direction: "forward" };
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

      const cursor = createCursorFromRecord(record, indexColumns, "forward");

      expect(typeof cursor).toBe("string");

      const decoded = decodeCursor(cursor);
      expect(decoded.indexValues).toEqual({ id: "user123" });
      expect(decoded.direction).toBe("forward");
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

      const cursor = createCursorFromRecord(record, indexColumns, "backward");

      const decoded = decodeCursor(cursor);
      expect(decoded.indexValues).toEqual({
        createdAt: 1234567890,
        userId: "user456",
      });
      expect(decoded.direction).toBe("backward");
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

      const cursor = createCursorFromRecord(record, indexColumns, "forward");

      const decoded = decodeCursor(cursor);
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
      const cursorData: CursorData = {
        indexValues: { id: "user123", age: 25 },
        direction: "forward",
      };

      const indexColumns = [table.columns.id, table.columns.age];
      const serialized = serializeCursorValues(cursorData, indexColumns, "postgresql");

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
      const cursorData: CursorData = {
        indexValues: { id: "user123" },
        direction: "forward",
      };

      const indexColumns = [table.columns.id, table.columns.name];
      const serialized = serializeCursorValues(cursorData, indexColumns, "postgresql");

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
      const cursor = createCursorFromRecord(record, indexColumns, "forward");

      // Decode it
      const decoded = decodeCursor(cursor);

      // Serialize the values
      const serialized = serializeCursorValues(decoded, indexColumns, "postgresql");

      // Should preserve the values
      expect(serialized["score"]).toBe(42);
      expect(serialized["createdAt"]).toBe(1234567890);
    });

    it("should handle different directions correctly", () => {
      const cursorForward = encodeCursor({
        indexValues: { id: "test" },
        direction: "forward",
      });

      const cursorBackward = encodeCursor({
        indexValues: { id: "test" },
        direction: "backward",
      });

      expect(cursorForward).not.toBe(cursorBackward);

      const decodedForward = decodeCursor(cursorForward);
      const decodedBackward = decodeCursor(cursorBackward);

      expect(decodedForward.direction).toBe("forward");
      expect(decodedBackward.direction).toBe("backward");
    });
  });
});
