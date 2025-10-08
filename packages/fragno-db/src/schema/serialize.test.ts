import { describe, expect, it } from "vitest";
import { column, FragnoId } from "./create";
import { dbToSchemaType, deserialize, schemaToDBType, serialize } from "./serialize";

describe("serialize", () => {
  describe("dbToSchemaType", () => {
    describe("sqlite", () => {
      it("should map integer types correctly", () => {
        expect(dbToSchemaType("integer", "sqlite", {})).toEqual([
          "bool",
          "date",
          "timestamp",
          "bigint",
          "integer",
        ]);
        expect(dbToSchemaType("INTEGER", "sqlite", {})).toEqual([
          "bool",
          "date",
          "timestamp",
          "bigint",
          "integer",
        ]);
      });

      it("should map text types correctly", () => {
        expect(dbToSchemaType("text", "sqlite", {})).toEqual([
          "json",
          "string",
          "bigint",
          "varchar(n)",
        ]);
      });

      it("should map numeric types correctly", () => {
        expect(dbToSchemaType("real", "sqlite", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("numeric", "sqlite", {})).toEqual(["decimal"]);
      });

      it("should map blob types correctly", () => {
        expect(dbToSchemaType("blob", "sqlite", {})).toEqual(["bigint", "binary"]);
      });
    });

    describe("postgresql", () => {
      it("should map decimal types correctly", () => {
        expect(dbToSchemaType("decimal", "postgresql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("real", "postgresql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("numeric", "postgresql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("double precision", "postgresql", {})).toEqual(["decimal"]);
      });

      it("should map timestamp types correctly", () => {
        expect(dbToSchemaType("timestamp", "postgresql", {})).toEqual(["timestamp"]);
        expect(dbToSchemaType("timestamptz", "postgresql", {})).toEqual(["timestamp"]);
      });

      it("should map varchar with length correctly", () => {
        expect(dbToSchemaType("varchar", "postgresql", { length: 255 })).toEqual(["varchar(255)"]);
      });

      it("should map varchar without length to string", () => {
        expect(dbToSchemaType("varchar", "postgresql", {})).toEqual(["string"]);
      });

      it("should map text types correctly", () => {
        expect(dbToSchemaType("text", "postgresql", {})).toEqual(["string"]);
      });

      it("should map boolean types correctly", () => {
        expect(dbToSchemaType("boolean", "postgresql", {})).toEqual(["bool"]);
        expect(dbToSchemaType("bool", "postgresql", {})).toEqual(["bool"]);
      });

      it("should map binary types correctly", () => {
        expect(dbToSchemaType("bytea", "postgresql", {})).toEqual(["binary"]);
      });
    });

    describe("cockroachdb", () => {
      it("should behave like postgresql", () => {
        expect(dbToSchemaType("timestamp", "cockroachdb", {})).toEqual(["timestamp"]);
        expect(dbToSchemaType("text", "cockroachdb", {})).toEqual(["string"]);
      });
    });

    describe("mysql", () => {
      it("should map boolean types correctly", () => {
        expect(dbToSchemaType("bool", "mysql", {})).toEqual(["bool"]);
        expect(dbToSchemaType("boolean", "mysql", {})).toEqual(["bool"]);
      });

      it("should map integer types correctly", () => {
        expect(dbToSchemaType("integer", "mysql", {})).toEqual(["integer"]);
        expect(dbToSchemaType("int", "mysql", {})).toEqual(["integer"]);
      });

      it("should map decimal types correctly", () => {
        expect(dbToSchemaType("decimal", "mysql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("numeric", "mysql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("float", "mysql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("double", "mysql", {})).toEqual(["decimal"]);
      });

      it("should map datetime types correctly", () => {
        expect(dbToSchemaType("datetime", "mysql", {})).toEqual(["timestamp"]);
      });

      it("should map varchar with length correctly", () => {
        expect(dbToSchemaType("varchar", "mysql", { length: 100 })).toEqual(["varchar(100)"]);
      });

      it("should map varchar without length to string", () => {
        expect(dbToSchemaType("varchar", "mysql", {})).toEqual(["string"]);
      });

      it("should map text types correctly", () => {
        expect(dbToSchemaType("text", "mysql", {})).toEqual(["string"]);
      });

      it("should map blob types correctly", () => {
        expect(dbToSchemaType("longblob", "mysql", {})).toEqual(["binary"]);
        expect(dbToSchemaType("blob", "mysql", {})).toEqual(["binary"]);
        expect(dbToSchemaType("mediumblob", "mysql", {})).toEqual(["binary"]);
        expect(dbToSchemaType("tinyblob", "mysql", {})).toEqual(["binary"]);
      });
    });

    describe("mssql", () => {
      it("should map integer types correctly", () => {
        expect(dbToSchemaType("int", "mssql", {})).toEqual(["integer"]);
      });

      it("should map decimal types correctly", () => {
        expect(dbToSchemaType("decimal", "mssql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("float", "mssql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("real", "mssql", {})).toEqual(["decimal"]);
        expect(dbToSchemaType("numeric", "mssql", {})).toEqual(["decimal"]);
      });

      it("should map bit type correctly", () => {
        expect(dbToSchemaType("bit", "mssql", {})).toEqual(["bool"]);
      });

      it("should map datetime types correctly", () => {
        expect(dbToSchemaType("datetime", "mssql", {})).toEqual(["timestamp"]);
        expect(dbToSchemaType("datetime2", "mssql", {})).toEqual(["timestamp"]);
      });

      it("should map varchar with length correctly", () => {
        expect(dbToSchemaType("varchar", "mssql", { length: 50 })).toEqual(["varchar(50)"]);
        expect(dbToSchemaType("nvarchar", "mssql", { length: 50 })).toEqual(["varchar(50)"]);
      });

      it("should map varchar without length to string/json", () => {
        expect(dbToSchemaType("varchar", "mssql", {})).toEqual(["string", "json"]);
        expect(dbToSchemaType("nvarchar", "mssql", {})).toEqual(["string", "json"]);
      });

      it("should map text types correctly", () => {
        expect(dbToSchemaType("ntext", "mssql", {})).toEqual(["string", "json"]);
        expect(dbToSchemaType("text", "mssql", {})).toEqual(["string", "json"]);
        expect(dbToSchemaType("varchar(max)", "mssql", {})).toEqual(["string", "json"]);
        expect(dbToSchemaType("nvarchar(max)", "mssql", {})).toEqual(["string", "json"]);
      });

      it("should map binary types correctly", () => {
        expect(dbToSchemaType("binary", "mssql", {})).toEqual(["binary"]);
        expect(dbToSchemaType("varbinary", "mssql", {})).toEqual(["binary"]);
      });
    });
  });

  describe("schemaToDBType", () => {
    describe("sqlite", () => {
      it("should convert integer types to integer", () => {
        expect(schemaToDBType(column("integer"), "sqlite")).toBe("integer");
      });

      it("should convert timestamp to integer", () => {
        expect(schemaToDBType(column("timestamp"), "sqlite")).toBe("integer");
      });

      it("should convert date to integer", () => {
        expect(schemaToDBType(column("date"), "sqlite")).toBe("integer");
      });

      it("should convert bool to integer", () => {
        expect(schemaToDBType(column("bool"), "sqlite")).toBe("integer");
      });

      it("should convert binary to blob", () => {
        expect(schemaToDBType(column("binary"), "sqlite")).toBe("blob");
      });

      it("should convert bigint to blob", () => {
        expect(schemaToDBType(column("bigint"), "sqlite")).toBe("blob");
      });

      it("should convert json to text", () => {
        expect(schemaToDBType(column("json"), "sqlite")).toBe("text");
      });

      it("should convert string to text", () => {
        expect(schemaToDBType(column("string"), "sqlite")).toBe("text");
      });

      it("should convert varchar to text", () => {
        expect(schemaToDBType({ type: "varchar(255)" }, "sqlite")).toBe("text");
      });

      it("should convert decimal to real", () => {
        expect(schemaToDBType(column("decimal"), "sqlite")).toBe("real");
      });
    });

    describe("mssql", () => {
      it("should convert bool to bit", () => {
        expect(schemaToDBType(column("bool"), "mssql")).toBe("bit");
      });

      it("should convert timestamp to datetime", () => {
        expect(schemaToDBType(column("timestamp"), "mssql")).toBe("datetime");
      });

      it("should convert integer to int", () => {
        expect(schemaToDBType(column("integer"), "mssql")).toBe("int");
      });

      it("should convert string to varchar(max)", () => {
        expect(schemaToDBType(column("string"), "mssql")).toBe("varchar(max)");
      });

      it("should convert binary to varbinary(max)", () => {
        expect(schemaToDBType(column("binary"), "mssql")).toBe("varbinary(max)");
      });

      it("should convert json to varchar(max)", () => {
        expect(schemaToDBType(column("json"), "mssql")).toBe("varchar(max)");
      });

      it("should preserve varchar with length", () => {
        expect(schemaToDBType({ type: "varchar(100)" }, "mssql")).toBe("varchar(100)");
      });
    });

    describe("postgresql", () => {
      it("should convert bool to boolean", () => {
        expect(schemaToDBType(column("bool"), "postgresql")).toBe("boolean");
      });

      it("should convert json to json", () => {
        expect(schemaToDBType(column("json"), "postgresql")).toBe("json");
      });

      it("should convert string to text", () => {
        expect(schemaToDBType(column("string"), "postgresql")).toBe("text");
      });

      it("should convert binary to bytea", () => {
        expect(schemaToDBType(column("binary"), "postgresql")).toBe("bytea");
      });

      it("should preserve varchar with length", () => {
        expect(schemaToDBType({ type: "varchar(200)" }, "postgresql")).toBe("varchar(200)");
      });

      it("should preserve other types", () => {
        expect(schemaToDBType(column("timestamp"), "postgresql")).toBe("timestamp");
        expect(schemaToDBType(column("integer"), "postgresql")).toBe("integer");
      });
    });

    describe("cockroachdb", () => {
      it("should behave like postgresql", () => {
        expect(schemaToDBType(column("bool"), "cockroachdb")).toBe("boolean");
        expect(schemaToDBType(column("string"), "cockroachdb")).toBe("text");
      });
    });

    describe("mysql", () => {
      it("should convert bool to boolean", () => {
        expect(schemaToDBType(column("bool"), "mysql")).toBe("boolean");
      });

      it("should convert string to text", () => {
        expect(schemaToDBType(column("string"), "mysql")).toBe("text");
      });

      it("should convert binary to longblob", () => {
        expect(schemaToDBType(column("binary"), "mysql")).toBe("longblob");
      });

      it("should preserve varchar with length", () => {
        expect(schemaToDBType({ type: "varchar(150)" }, "mysql")).toBe("varchar(150)");
      });

      it("should preserve other types", () => {
        expect(schemaToDBType(column("integer"), "mysql")).toBe("integer");
        expect(schemaToDBType(column("json"), "mysql")).toBe("json");
      });
    });
  });

  describe("deserialize", () => {
    it("should return null for null values", () => {
      expect(deserialize(null, column("string"), "sqlite")).toBe(null);
      expect(deserialize(null, column("integer"), "postgresql")).toBe(null);
    });

    describe("json handling", () => {
      it("should parse JSON strings for non-json-supporting providers", () => {
        const jsonCol = column("json");
        const jsonString = '{"key":"value"}';
        expect(deserialize(jsonString, jsonCol, "sqlite")).toEqual({ key: "value" });
        expect(deserialize(jsonString, jsonCol, "mssql")).toEqual({ key: "value" });
      });

      it("should not parse JSON for json-supporting providers", () => {
        const jsonCol = column("json");
        const jsonObj = { key: "value" };
        expect(deserialize(jsonObj, jsonCol, "postgresql")).toEqual(jsonObj);
        expect(deserialize(jsonObj, jsonCol, "mysql")).toEqual(jsonObj);
        expect(deserialize(jsonObj, jsonCol, "cockroachdb")).toEqual(jsonObj);
      });
    });

    describe("sqlite date handling", () => {
      it("should convert numeric timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = Date.now();
        expect(deserialize(time, timestampCol, "sqlite")).toEqual(new Date(time));
      });

      it("should convert string timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01T00:00:00.000Z";
        expect(deserialize(time, timestampCol, "sqlite")).toEqual(new Date(time));
      });

      it("should convert date values", () => {
        const dateCol = column("date");
        const time = Date.now();
        expect(deserialize(time, dateCol, "sqlite")).toEqual(new Date(time));
      });
    });

    describe("boolean handling", () => {
      it("should convert numeric booleans", () => {
        const boolCol = column("bool");
        expect(deserialize(1, boolCol, "sqlite")).toBe(true);
        expect(deserialize(0, boolCol, "sqlite")).toBe(false);
      });

      it("should handle actual boolean values", () => {
        const boolCol = column("bool");
        expect(deserialize(true, boolCol, "postgresql")).toBe(true);
        expect(deserialize(false, boolCol, "postgresql")).toBe(false);
      });
    });

    describe("bigint handling", () => {
      it("should convert Buffer to bigint", () => {
        const bigintCol = column("bigint");
        const buffer = Buffer.alloc(8);
        buffer.writeBigInt64BE(123456789n);
        expect(deserialize(buffer, bigintCol, "sqlite")).toBe(123456789n);
      });

      it("should convert string to bigint", () => {
        const bigintCol = column("bigint");
        expect(deserialize("123456789", bigintCol, "postgresql")).toBe(123456789n);
        expect(deserialize("987654321", bigintCol, "mysql")).toBe(987654321n);
      });

      it("should handle bigint passthrough", () => {
        const bigintCol = column("bigint");
        const value = 123456789n;
        expect(deserialize(value, bigintCol, "postgresql")).toBe(value);
      });
    });

    describe("binary handling", () => {
      it("should convert Buffer to Uint8Array", () => {
        const binaryCol = column("binary");
        const buffer = Buffer.from([1, 2, 3, 4]);
        const result = deserialize(buffer, binaryCol, "postgresql");
        expect(result).toBeInstanceOf(Uint8Array);
        expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3, 4]);
      });
    });
  });

  describe("serialize", () => {
    it("should return null for null values", () => {
      expect(serialize(null, column("string"), "sqlite")).toBe(null);
      expect(serialize(null, column("integer"), "postgresql")).toBe(null);
    });

    describe("json handling", () => {
      it("should stringify JSON for non-json-supporting providers", () => {
        const jsonCol = column("json");
        const obj = { key: "value" };
        expect(serialize(obj, jsonCol, "sqlite")).toBe('{"key":"value"}');
        expect(serialize(obj, jsonCol, "mssql")).toBe('{"key":"value"}');
      });

      it("should not stringify JSON for json-supporting providers", () => {
        const jsonCol = column("json");
        const obj = { key: "value" };
        expect(serialize(obj, jsonCol, "postgresql")).toEqual(obj);
        expect(serialize(obj, jsonCol, "mysql")).toEqual(obj);
        expect(serialize(obj, jsonCol, "cockroachdb")).toEqual(obj);
      });
    });

    describe("sqlite date handling", () => {
      it("should convert Date to timestamp number", () => {
        const date = new Date("2024-01-01T00:00:00.000Z");
        expect(serialize(date, column("timestamp"), "sqlite")).toBe(date.getTime());
        expect(serialize(date, column("date"), "sqlite")).toBe(date.getTime());
      });
    });

    describe("sqlite boolean handling", () => {
      it("should convert boolean to number", () => {
        expect(serialize(true, column("bool"), "sqlite")).toBe(1);
        expect(serialize(false, column("bool"), "sqlite")).toBe(0);
      });

      it("should not convert boolean for other providers", () => {
        expect(serialize(true, column("bool"), "postgresql")).toBe(true);
        expect(serialize(false, column("bool"), "mysql")).toBe(false);
      });
    });

    describe("sqlite bigint handling", () => {
      it("should convert bigint to Buffer", () => {
        const bigintValue = 123456789n;
        const result = serialize(bigintValue, column("bigint"), "sqlite");
        expect(result).toBeInstanceOf(Buffer);
        expect((result as Buffer).readBigInt64BE(0)).toBe(bigintValue);
      });
    });

    describe("binary handling", () => {
      it("should convert Uint8Array to Buffer", () => {
        const binaryCol = column("binary");
        const uint8 = new Uint8Array([1, 2, 3, 4]);
        const result = serialize(uint8, binaryCol, "postgresql");
        expect(result).toBeInstanceOf(Buffer);
        expect(Array.from(result as Buffer)).toEqual([1, 2, 3, 4]);
      });

      it("should handle Buffer as-is", () => {
        const binaryCol = column("binary");
        const buffer = Buffer.from([1, 2, 3, 4]);
        const result = serialize(buffer, binaryCol, "mysql");
        // Buffer is also a Uint8Array, so it should be converted
        expect(result).toBeInstanceOf(Buffer);
      });
    });

    describe("passthrough values", () => {
      it("should pass through values that don't need conversion", () => {
        expect(serialize("test", column("string"), "postgresql")).toBe("test");
        expect(serialize(42, column("integer"), "mysql")).toBe(42);
        expect(serialize(3.14, column("decimal"), "mssql")).toBe(3.14);
      });
    });

    describe("FragnoId handling", () => {
      it("should serialize FragnoId for external-id column", () => {
        const externalIdCol = column("string");
        externalIdCol.role = "external-id";
        const fragnoId = FragnoId.fromExternal("user123", 0);

        expect(serialize(fragnoId, externalIdCol, "postgresql")).toBe("user123");
        expect(serialize(fragnoId, externalIdCol, "sqlite")).toBe("user123");
        expect(serialize(fragnoId, externalIdCol, "mysql")).toBe("user123");
      });

      it("should serialize FragnoId for internal-id column", () => {
        const internalIdCol = column("bigint");
        internalIdCol.role = "internal-id";
        const fragnoId = new FragnoId({
          externalId: "user123",
          internalId: BigInt(456),
          version: 0,
        });

        expect(serialize(fragnoId, internalIdCol, "postgresql")).toBe(BigInt(456));
        expect(serialize(fragnoId, internalIdCol, "sqlite")).toBe(BigInt(456));
        expect(serialize(fragnoId, internalIdCol, "mysql")).toBe(BigInt(456));
      });

      it("should throw error when FragnoId lacks internal ID for internal-id column", () => {
        const internalIdCol = column("bigint");
        internalIdCol.role = "internal-id";
        const fragnoId = FragnoId.fromExternal("user123", 0);

        expect(() => serialize(fragnoId, internalIdCol, "postgresql")).toThrow(
          "FragnoId must have internalId for internal-id column",
        );
      });

      it("should serialize FragnoId for reference column (prefer internal ID)", () => {
        const referenceCol = column("bigint");
        referenceCol.role = "reference";
        const fragnoId = new FragnoId({
          externalId: "user123",
          internalId: BigInt(456),
          version: 0,
        });

        expect(serialize(fragnoId, referenceCol, "postgresql")).toBe(BigInt(456));
        expect(serialize(fragnoId, referenceCol, "sqlite")).toBe(BigInt(456));
      });

      it("should fallback to external ID for reference column when internal ID unavailable", () => {
        const referenceCol = column("bigint");
        referenceCol.role = "reference";
        const fragnoId = FragnoId.fromExternal("user123", 0);

        expect(serialize(fragnoId, referenceCol, "postgresql")).toBe("user123");
        expect(serialize(fragnoId, referenceCol, "sqlite")).toBe("user123");
      });

      it("should serialize FragnoId for regular column (use external ID)", () => {
        const regularCol = column("string");
        regularCol.role = "regular";
        const fragnoId = new FragnoId({
          externalId: "user123",
          internalId: BigInt(456),
          version: 0,
        });

        expect(serialize(fragnoId, regularCol, "postgresql")).toBe("user123");
        expect(serialize(fragnoId, regularCol, "mysql")).toBe("user123");
      });

      it("should handle FragnoId serialization with different providers", () => {
        const externalIdCol = column("string");
        externalIdCol.role = "external-id";
        const fragnoId = new FragnoId({
          externalId: "user123",
          internalId: BigInt(456),
          version: 0,
        });

        // Test across different providers
        expect(serialize(fragnoId, externalIdCol, "sqlite")).toBe("user123");
        expect(serialize(fragnoId, externalIdCol, "postgresql")).toBe("user123");
        expect(serialize(fragnoId, externalIdCol, "mysql")).toBe("user123");
        expect(serialize(fragnoId, externalIdCol, "mssql")).toBe("user123");
        expect(serialize(fragnoId, externalIdCol, "cockroachdb")).toBe("user123");
      });
    });
  });
});
