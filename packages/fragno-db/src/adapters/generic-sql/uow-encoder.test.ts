import { describe, it, expect } from "vitest";
import { UnitOfWorkEncoder } from "./uow-encoder";
import { schema, column, idColumn, referenceColumn } from "../../schema/create";
import { DriverConfig } from "./driver-config";

describe("UnitOfWorkEncoder", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("isActive", column("bool"))
          .addColumn("createdAt", column("timestamp"));
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("userId", referenceColumn())
          .addColumn("title", column("string"));
      });
  });

  const usersTable = testSchema.tables.users;
  const postsTable = testSchema.tables.posts;

  describe("SQLite encoding", () => {
    const sqliteConfig = new (class extends DriverConfig {
      readonly driverType = "better-sqlite3" as const;
      readonly databaseType = "sqlite" as const;
      readonly supportsReturning = true;
      readonly supportsRowsAffected = true;
      readonly supportsJson = false;
    })();

    // Mock Kysely instance (only needed for reference subquery processing)
    const db = {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const encoder = new UnitOfWorkEncoder(sqliteConfig, db);

    it("should serialize Date to number for sqlite", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encoder.encodeForDatabase({
        values: { createdAt: date },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ createdAt: date.getTime() });
    });

    it("should serialize boolean to number for sqlite", () => {
      const result = encoder.encodeForDatabase({
        values: { isActive: true },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ isActive: 1 });
    });

    it("should serialize bigint to Number for reference columns in sqlite", () => {
      const result = encoder.encodeForDatabase({
        values: { userId: BigInt(456) },
        table: postsTable,
        generateDefaults: false,
      });

      // Reference columns should be converted to Number for SQLite
      expect(result).toEqual({ userId: 456 });
    });

    it("should handle multiple fields", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encoder.encodeForDatabase({
        values: {
          name: "Alice",
          age: 30,
          isActive: false,
          createdAt: date,
        },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({
        name: "Alice",
        age: 30,
        isActive: 0,
        createdAt: date.getTime(),
      });
    });

    it("should handle null values", () => {
      const result = encoder.encodeForDatabase({
        values: { age: null },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ age: null });
    });

    it("should generate defaults when requested", () => {
      const result = encoder.encodeForDatabase({
        values: { title: "Test" },
        table: postsTable,
        generateDefaults: true,
      });

      // Should have generated an ID
      expect(result["id"]).toBeDefined();
      expect(typeof result["id"]).toBe("string");
      expect(result["title"]).toBe("Test");
    });
  });

  describe("PostgreSQL encoding", () => {
    const postgresConfig = new (class extends DriverConfig {
      readonly driverType = "pg" as const;
      readonly databaseType = "postgresql" as const;
      readonly supportsReturning = true;
      readonly supportsRowsAffected = true;
      readonly supportsJson = true;
    })();

    // Mock Kysely instance
    const db = {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const encoder = new UnitOfWorkEncoder(postgresConfig, db);

    it("should keep Date as Date for postgresql", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encoder.encodeForDatabase({
        values: { createdAt: date },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ createdAt: date });
    });

    it("should keep boolean as boolean for postgresql", () => {
      const result = encoder.encodeForDatabase({
        values: { isActive: true },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ isActive: true });
    });

    it("should keep bigint as bigint for reference columns in postgresql", () => {
      const result = encoder.encodeForDatabase({
        values: { userId: BigInt(456) },
        table: postsTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ userId: BigInt(456) });
    });
  });

  describe("MySQL encoding", () => {
    const mysqlConfig = new (class extends DriverConfig {
      readonly driverType = "mysql2" as const;
      readonly databaseType = "mysql" as const;
      readonly supportsReturning = false;
      readonly supportsRowsAffected = true;
      readonly supportsJson = true;
    })();

    // Mock Kysely instance
    const db = {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const encoder = new UnitOfWorkEncoder(mysqlConfig, db);

    it("should keep Date as Date for mysql", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = encoder.encodeForDatabase({
        values: { createdAt: date },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ createdAt: date });
    });

    it("should keep boolean as boolean for mysql", () => {
      const result = encoder.encodeForDatabase({
        values: { isActive: true },
        table: usersTable,
        generateDefaults: false,
      });

      expect(result).toEqual({ isActive: true });
    });
  });
});
