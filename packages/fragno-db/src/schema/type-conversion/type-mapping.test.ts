import { describe, expect, it, assert } from "vitest";

import { sqliteStoragePrisma } from "../../adapters/generic-sql/sqlite-storage";
import { column, referenceColumn } from "../create";
import { createSQLTypeMapper } from "./create-sql-type-mapper";

describe("SQLTypeMapper", () => {
  describe("error handling", () => {
    it("should throw error for varchar without length", () => {
      const mapper = createSQLTypeMapper("postgresql");
      // @ts-expect-error - Testing runtime error handling for invalid type
      expect(() => mapper.getDatabaseType({ type: "varchar" })).toThrow(
        'Invalid varchar format: "varchar". Expected format: varchar(number), e.g., varchar(255)',
      );
    });

    it("should throw error for varchar with non-numeric length", () => {
      const mapper = createSQLTypeMapper("mysql");
      // @ts-expect-error - Testing runtime error handling for invalid type
      expect(() => mapper.getDatabaseType({ type: "varchar(abc)" })).toThrow(
        'Invalid varchar format: "varchar(abc)". Expected format: varchar(number), e.g., varchar(255)',
      );
    });

    it("should throw error for malformed varchar", () => {
      const mapper = createSQLTypeMapper("sqlite");
      // @ts-expect-error - Testing runtime error handling for invalid type
      expect(() => mapper.getDatabaseType({ type: "varchar(100" })).toThrow(
        'Invalid varchar format: "varchar(100". Expected format: varchar(number), e.g., varchar(255)',
      );
    });

    it("should throw error for completely unsupported type", () => {
      const mapper = createSQLTypeMapper("postgresql");
      // @ts-expect-error - Testing runtime error handling for invalid type
      expect(() => mapper.getDatabaseType({ type: "unsupported" })).toThrow(
        "Unsupported column type: unsupported",
      );
    });
  });

  describe("sqlite", () => {
    const mapper = createSQLTypeMapper("sqlite");

    it("should convert integer types to integer", () => {
      assert(mapper.getDatabaseType(column("integer")) === "integer");
    });

    it("should convert timestamp to integer", () => {
      assert(mapper.getDatabaseType(column("timestamp")) === "integer");
    });

    it("should convert date to integer", () => {
      assert(mapper.getDatabaseType(column("date")) === "integer");
    });

    it("should convert bool to integer", () => {
      assert(mapper.getDatabaseType(column("bool")) === "integer");
    });

    it("should convert binary to blob", () => {
      assert(mapper.getDatabaseType(column("binary")) === "blob");
    });

    it("should convert bigint to blob", () => {
      assert(mapper.getDatabaseType(column("bigint")) === "blob");
    });

    it("should convert json to text", () => {
      assert(mapper.getDatabaseType(column("json")) === "text");
    });

    it("should convert string to text", () => {
      assert(mapper.getDatabaseType(column("string")) === "text");
    });

    it("should convert varchar to text", () => {
      assert(mapper.getDatabaseType({ type: "varchar(255)" }) === "text");
    });

    it("should convert decimal to real", () => {
      assert(mapper.getDatabaseType(column("decimal")) === "real");
    });
  });

  describe("sqlite prisma storage", () => {
    const mapper = createSQLTypeMapper("sqlite", sqliteStoragePrisma);

    it("should convert timestamp to text", () => {
      assert(mapper.getDatabaseType(column("timestamp")) === "text");
    });

    it("should convert date to text", () => {
      assert(mapper.getDatabaseType(column("date")) === "text");
    });

    it("should convert bigint to integer", () => {
      assert(mapper.getDatabaseType(column("bigint")) === "integer");
    });

    it("should keep reference bigint as integer", () => {
      const userReferenceColumn = referenceColumn({ table: "users" });
      userReferenceColumn.name = "userId";

      assert(mapper.getDatabaseType(userReferenceColumn) === "integer");
    });
  });

  describe("postgresql", () => {
    const mapper = createSQLTypeMapper("postgresql");

    it("should convert bool to boolean", () => {
      assert(mapper.getDatabaseType(column("bool")) === "boolean");
    });

    it("should convert json to json", () => {
      assert(mapper.getDatabaseType(column("json")) === "json");
    });

    it("should convert string to varchar", () => {
      assert(mapper.getDatabaseType(column("string")) === "varchar(191)");
    });

    it("should convert text to text", () => {
      assert(mapper.getDatabaseType(column("text")) === "text");
    });

    it("should convert binary to bytea", () => {
      assert(mapper.getDatabaseType(column("binary")) === "bytea");
    });

    it("should preserve varchar with length", () => {
      assert(mapper.getDatabaseType({ type: "varchar(200)" }) === "varchar(200)");
    });

    it("should preserve other types", () => {
      assert(mapper.getDatabaseType(column("timestamp")) === "timestamp");
      assert(mapper.getDatabaseType(column("integer")) === "integer");
    });
  });

  describe("mysql", () => {
    const mapper = createSQLTypeMapper("mysql");

    it("should convert bool to boolean", () => {
      assert(mapper.getDatabaseType(column("bool")) === "boolean");
    });

    it("should convert string to varchar", () => {
      assert(mapper.getDatabaseType(column("string")) === "varchar(191)");
    });

    it("should convert text to text", () => {
      assert(mapper.getDatabaseType(column("text")) === "text");
    });

    it("should convert binary to longblob", () => {
      assert(mapper.getDatabaseType(column("binary")) === "longblob");
    });

    it("should preserve varchar with length", () => {
      assert(mapper.getDatabaseType({ type: "varchar(150)" }) === "varchar(150)");
    });

    it("should preserve other types", () => {
      assert(mapper.getDatabaseType(column("integer")) === "integer");
      assert(mapper.getDatabaseType(column("json")) === "json");
    });
  });
});
