import { describe, it, expect } from "vitest";
import { decodeCursor, createCursorFromRecord, serializeCursorValues, Cursor } from "./cursor";
import { column, idColumn, schema } from "../schema/create";
import {
  BetterSQLite3DriverConfig,
  MySQL2DriverConfig,
  NodePostgresDriverConfig,
} from "../adapters/generic-sql/driver-config";

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

    it("should throw when index values contain undefined", () => {
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: undefined },
      });

      expect(() => cursor.encode()).toThrow(/undefined/i);
    });

    it("should throw when index values contain BigInt", () => {
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: 1n },
      });

      expect(() => cursor.encode()).toThrow(/bigint/i);
    });

    it("should throw when index values contain non-finite numbers", () => {
      const cursor = new Cursor({
        indexName: "_primary",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { id: Number.NaN },
      });

      expect(() => cursor.encode()).toThrow(/finite/i);
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

    it("should throw error for array indexValues", () => {
      const invalidData = {
        v: 1,
        indexValues: [],
        indexName: "test",
        orderDirection: "asc",
        pageSize: 10,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for non-string indexName", () => {
      const invalidData = {
        v: 1,
        indexValues: { id: "test" },
        indexName: 123,
        orderDirection: "asc",
        pageSize: 10,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for invalid pageSize values", () => {
      const invalidData = {
        v: 1,
        indexValues: { id: "test" },
        indexName: "test",
        orderDirection: "asc",
        pageSize: 0,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/invalid cursor/i);
    });

    it("should throw error for missing cursor version", () => {
      const invalidData = {
        indexValues: { id: "test" },
        indexName: "test",
        orderDirection: "asc",
        pageSize: 10,
      };
      const encoded = Buffer.from(JSON.stringify(invalidData), "utf-8").toString("base64");
      expect(() => decodeCursor(encoded)).toThrow(/unsupported cursor version/i);
    });
  });

  describe("createCursorFromRecord", () => {
    it("should create a cursor from a record with single column index", () => {
      const testSchema = schema("test", (s) =>
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
      const testSchema = schema("test", (s) =>
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

    it("should throw when record is missing index columns", () => {
      const testSchema = schema("test", (s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("integer"))
            .createIndex("created", ["createdAt"]),
        ),
      );

      const table = testSchema.tables.posts;
      const record = { id: "post123" };
      const indexColumns = table.indexes.created.columns;

      expect(() =>
        createCursorFromRecord(record, indexColumns, {
          indexName: "created",
          orderDirection: "asc",
          pageSize: 10,
        }),
      ).toThrow(/missing value/i);
    });

    it("should only include columns that are in the index", () => {
      const testSchema = schema("test", (s) =>
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
      const testSchema = schema("test", (s) =>
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
      const serialized = serializeCursorValues(
        cursor,
        indexColumns,
        new NodePostgresDriverConfig(),
      );

      expect(serialized).toHaveProperty("id", "user123");
      expect(serialized).toHaveProperty("age", 25);
    });

    it("should throw when cursor data is missing index values", () => {
      const testSchema = schema("test", (s) =>
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
      expect(() =>
        serializeCursorValues(cursor, indexColumns, new NodePostgresDriverConfig()),
      ).toThrow(/missing values/i);
    });
  });

  describe("round-trip integration", () => {
    it("should successfully round-trip cursor data through encode/decode", () => {
      const testSchema = schema("test", (s) =>
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
      const serialized = serializeCursorValues(
        decoded,
        indexColumns,
        new NodePostgresDriverConfig(),
      );

      // Should preserve the values
      expect(serialized["score"]).toBe(42);
      expect(serialized["createdAt"]).toBe(1234567890);
    });

    it("should handle Date objects in cursors for PostgreSQL", () => {
      const testSchema = schema("test", (s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("timestamp"))
            .createIndex("created", ["createdAt"]),
        ),
      );

      const table = testSchema.tables.posts;
      const createdAtDate = new Date("2025-11-07T09:36:57.959Z");
      const record = {
        id: "post123",
        createdAt: createdAtDate,
      };

      const index = table.indexes.created;
      const indexColumns = index.columns;

      // Create cursor from record (has Date object)
      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "created",
        orderDirection: "asc",
        pageSize: 10,
      });

      // Encode and decode (Date becomes string in JSON)
      const encoded = cursor.encode();
      const decoded = decodeCursor(encoded);

      // After decode, the value is a string (from JSON.parse)
      expect(typeof decoded.indexValues["createdAt"]).toBe("string");
      expect(decoded.indexValues["createdAt"]).toBe("2025-11-07T09:36:57.959Z");

      // Serialize should convert it back to Date for the database
      const serialized = serializeCursorValues(
        decoded,
        indexColumns,
        new NodePostgresDriverConfig(),
      );

      // For PostgreSQL, Date objects should be passed through as-is
      expect(serialized["createdAt"]).toBeInstanceOf(Date);
      expect((serialized["createdAt"] as Date).toISOString()).toBe("2025-11-07T09:36:57.959Z");
    });

    it("should handle Date objects in cursors for SQLite", () => {
      const testSchema = schema("test", (s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("timestamp"))
            .createIndex("created", ["createdAt"]),
        ),
      );

      const table = testSchema.tables.posts;
      const createdAtDate = new Date("2025-11-07T09:36:57.959Z");
      const record = {
        id: "post123",
        createdAt: createdAtDate,
      };

      const index = table.indexes.created;
      const indexColumns = index.columns;

      // Create cursor from record
      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "created",
        orderDirection: "asc",
        pageSize: 10,
      });

      // Encode and decode
      const decoded = decodeCursor(cursor.encode());

      // Serialize should convert string back to Date, then to timestamp number for SQLite
      const serialized = serializeCursorValues(
        decoded,
        indexColumns,
        new BetterSQLite3DriverConfig(),
      );

      // For SQLite, Date should be converted to timestamp number
      expect(typeof serialized["createdAt"]).toBe("number");
      expect(serialized["createdAt"]).toBe(createdAtDate.getTime());
    });

    it("should handle Date objects in cursors for MySQL", () => {
      const testSchema = schema("test", (s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("timestamp"))
            .createIndex("created", ["createdAt"]),
        ),
      );

      const table = testSchema.tables.posts;
      const createdAtDate = new Date("2025-11-07T09:36:57.959Z");
      const record = {
        id: "post123",
        createdAt: createdAtDate,
      };

      const index = table.indexes.created;
      const indexColumns = index.columns;

      // Create cursor from record
      const cursor = createCursorFromRecord(record, indexColumns, {
        indexName: "created",
        orderDirection: "asc",
        pageSize: 10,
      });

      // Encode and decode
      const decoded = decodeCursor(cursor.encode());

      // Serialize for MySQL
      const serialized = serializeCursorValues(decoded, indexColumns, new MySQL2DriverConfig());

      // For MySQL, Date objects should be passed through as-is
      expect(serialized["createdAt"]).toBeInstanceOf(Date);
      expect((serialized["createdAt"] as Date).toISOString()).toBe("2025-11-07T09:36:57.959Z");
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
