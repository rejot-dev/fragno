import { describe, expect, it } from "vitest";
import { column, referenceColumn } from "../create";
import { createSQLTypeMapper } from "./create-sql-type-mapper";
import { sqliteStoragePrisma } from "../../adapters/generic-sql/sqlite-storage";

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
      expect(mapper.getDatabaseType(column("integer"))).toBe("integer");
    });

    it("should convert timestamp to integer", () => {
      expect(mapper.getDatabaseType(column("timestamp"))).toBe("integer");
    });

    it("should convert date to integer", () => {
      expect(mapper.getDatabaseType(column("date"))).toBe("integer");
    });

    it("should convert bool to integer", () => {
      expect(mapper.getDatabaseType(column("bool"))).toBe("integer");
    });

    it("should convert binary to blob", () => {
      expect(mapper.getDatabaseType(column("binary"))).toBe("blob");
    });

    it("should convert bigint to blob", () => {
      expect(mapper.getDatabaseType(column("bigint"))).toBe("blob");
    });

    it("should convert json to text", () => {
      expect(mapper.getDatabaseType(column("json"))).toBe("text");
    });

    it("should convert string to text", () => {
      expect(mapper.getDatabaseType(column("string"))).toBe("text");
    });

    it("should convert varchar to text", () => {
      expect(mapper.getDatabaseType({ type: "varchar(255)" })).toBe("text");
    });

    it("should convert decimal to real", () => {
      expect(mapper.getDatabaseType(column("decimal"))).toBe("real");
    });
  });

  describe("sqlite prisma storage", () => {
    const mapper = createSQLTypeMapper("sqlite", sqliteStoragePrisma);

    it("should convert timestamp to text", () => {
      expect(mapper.getDatabaseType(column("timestamp"))).toBe("text");
    });

    it("should convert date to text", () => {
      expect(mapper.getDatabaseType(column("date"))).toBe("text");
    });

    it("should convert bigint to integer", () => {
      expect(mapper.getDatabaseType(column("bigint"))).toBe("integer");
    });

    it("should keep reference bigint as integer", () => {
      const userReferenceColumn = referenceColumn();
      userReferenceColumn.name = "userId";

      expect(mapper.getDatabaseType(userReferenceColumn)).toBe("integer");
    });
  });

  describe("postgresql", () => {
    const mapper = createSQLTypeMapper("postgresql");

    it("should convert bool to boolean", () => {
      expect(mapper.getDatabaseType(column("bool"))).toBe("boolean");
    });

    it("should convert json to json", () => {
      expect(mapper.getDatabaseType(column("json"))).toBe("json");
    });

    it("should convert string to text", () => {
      expect(mapper.getDatabaseType(column("string"))).toBe("text");
    });

    it("should convert binary to bytea", () => {
      expect(mapper.getDatabaseType(column("binary"))).toBe("bytea");
    });

    it("should preserve varchar with length", () => {
      expect(mapper.getDatabaseType({ type: "varchar(200)" })).toBe("varchar(200)");
    });

    it("should preserve other types", () => {
      expect(mapper.getDatabaseType(column("timestamp"))).toBe("timestamp");
      expect(mapper.getDatabaseType(column("integer"))).toBe("integer");
    });
  });

  describe("mysql", () => {
    const mapper = createSQLTypeMapper("mysql");

    it("should convert bool to boolean", () => {
      expect(mapper.getDatabaseType(column("bool"))).toBe("boolean");
    });

    it("should convert string to text", () => {
      expect(mapper.getDatabaseType(column("string"))).toBe("text");
    });

    it("should convert binary to longblob", () => {
      expect(mapper.getDatabaseType(column("binary"))).toBe("longblob");
    });

    it("should preserve varchar with length", () => {
      expect(mapper.getDatabaseType({ type: "varchar(150)" })).toBe("varchar(150)");
    });

    it("should preserve other types", () => {
      expect(mapper.getDatabaseType(column("integer"))).toBe("integer");
      expect(mapper.getDatabaseType(column("json"))).toBe("json");
    });
  });
});
