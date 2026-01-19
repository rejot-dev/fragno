import { assert, describe, expect, it } from "vitest";
import { column, referenceColumn, internalIdColumn } from "./create";
import { createSQLSerializer } from "../query/serialize/create-sql-serializer";
import type { AnyColumn } from "./create";
import type { DriverConfig } from "../adapters/generic-sql/driver-config";
import {
  BetterSQLite3DriverConfig,
  NodePostgresDriverConfig,
  MySQL2DriverConfig,
} from "../adapters/generic-sql/driver-config";

function createMockDriverConfig(provider: string): DriverConfig {
  if (provider === "postgresql" || provider === "cockroachdb") {
    return new NodePostgresDriverConfig();
  }
  if (provider === "mysql") {
    return new MySQL2DriverConfig();
  }
  return new BetterSQLite3DriverConfig();
}

// Helper functions for testing
function deserialize(value: unknown, col: AnyColumn, provider: string) {
  const driverConfig = createMockDriverConfig(provider);
  const serializer = createSQLSerializer(driverConfig);
  return serializer.deserialize(value, col);
}

function serialize(
  value: unknown,
  col: AnyColumn,
  provider: string,
  skipDriverConversions = false,
) {
  const driverConfig = createMockDriverConfig(provider);
  const serializer = createSQLSerializer(driverConfig);
  return serializer.serialize(value, col, skipDriverConversions);
}

describe("serialize", () => {
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

      it("should handle ISO string timestamps with positive timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00+05:30"; // India Standard Time
        const result = deserialize(time, timestampCol, "sqlite");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T09:00:00.000Z");
      });

      it("should handle ISO string timestamps with negative timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00-08:00"; // Pacific Time
        const result = deserialize(time, timestampCol, "sqlite");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T22:30:00.000Z");
      });

      it("should preserve absolute time when deserializing numeric timestamps", () => {
        const timestampCol = column("timestamp");
        // Create a specific date and get its numeric representation
        const specificDate = new Date("2024-06-15T12:00:00Z");
        const numericTimestamp = specificDate.getTime();

        const result = deserialize(numericTimestamp, timestampCol, "sqlite");
        assert.instanceOf(result, Date);
        expect(result.getTime()).toBe(numericTimestamp);
        expect(result.toISOString()).toBe("2024-06-15T12:00:00.000Z");
      });

      it("should handle round-trip serialization/deserialization with timezones", () => {
        const timestampCol = column("timestamp");
        // Start with a date with timezone info
        const originalTime = "2024-06-15T14:30:00+02:00";
        const deserialized = deserialize(originalTime, timestampCol, "sqlite");
        assert.instanceOf(deserialized, Date);

        // SQLite would store this as a number
        const numericValue = deserialized.getTime();

        // Deserialize the numeric value back
        const roundTrip = deserialize(numericValue, timestampCol, "sqlite");

        assert.instanceOf(roundTrip, Date);
        expect(roundTrip.getTime()).toBe(deserialized.getTime());
        expect(roundTrip.toISOString()).toBe(deserialized.toISOString());
      });
    });

    describe("postgresql date handling", () => {
      it("should convert string timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01 12:30:45.123";
        const result = deserialize(time, timestampCol, "postgresql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-01-01T12:30:45.123Z");
      });

      it("should treat timezone-less ISO timestamps as UTC", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01T12:30:45.123";
        const result = deserialize(time, timestampCol, "postgresql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-01-01T12:30:45.123Z");
      });

      it("should convert ISO string timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01T00:00:00.000Z";
        expect(deserialize(time, timestampCol, "postgresql")).toEqual(new Date(time));
      });

      it("should convert date strings to Date", () => {
        const dateCol = column("date");
        const time = "2024-01-01";
        expect(deserialize(time, dateCol, "postgresql")).toEqual(new Date(time));
      });

      it("should handle timestamps with positive timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00+05:30"; // India Standard Time
        const result = deserialize(time, timestampCol, "postgresql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T09:00:00.000Z");
      });

      it("should handle timestamps with negative timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00-08:00"; // Pacific Time
        const result = deserialize(time, timestampCol, "postgresql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T22:30:00.000Z");
      });

      it("should handle timestamps with fractional seconds and timezone", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:45.123+01:00"; // Central European Time
        const result = deserialize(time, timestampCol, "postgresql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T13:30:45.123Z");
        expect(result.getTime()).toBe(new Date("2024-06-15T13:30:45.123Z").getTime());
      });

      it("should preserve absolute time across timezone conversions", () => {
        const timestampCol = column("timestamp");
        // Same absolute time in different timezones
        const utcTime = "2024-06-15T12:00:00Z";
        const estTime = "2024-06-15T08:00:00-04:00";
        const jstTime = "2024-06-15T21:00:00+09:00";

        const utcResult = deserialize(utcTime, timestampCol, "postgresql");
        const estResult = deserialize(estTime, timestampCol, "postgresql");
        const jstResult = deserialize(jstTime, timestampCol, "postgresql");

        assert.instanceOf(utcResult, Date);
        assert.instanceOf(estResult, Date);
        assert.instanceOf(jstResult, Date);

        // All should represent the same absolute time
        expect(utcResult.getTime()).toBe(estResult.getTime());
        expect(utcResult.getTime()).toBe(jstResult.getTime());
        expect(estResult.getTime()).toBe(jstResult.getTime());
      });
    });

    describe("mysql date handling", () => {
      it("should convert string timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01 12:30:45";
        expect(deserialize(time, timestampCol, "mysql")).toEqual(new Date(time));
      });

      it("should convert ISO string timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01T00:00:00.000Z";
        expect(deserialize(time, timestampCol, "mysql")).toEqual(new Date(time));
      });

      it("should convert date strings to Date", () => {
        const dateCol = column("date");
        const time = "2024-01-01";
        expect(deserialize(time, dateCol, "mysql")).toEqual(new Date(time));
      });

      it("should handle timestamps with positive timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00+05:30"; // India Standard Time
        const result = deserialize(time, timestampCol, "mysql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T09:00:00.000Z");
      });

      it("should handle timestamps with negative timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00-08:00"; // Pacific Time
        const result = deserialize(time, timestampCol, "mysql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T22:30:00.000Z");
      });

      it("should handle timestamps with fractional seconds and timezone", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:45.123+01:00"; // Central European Time
        const result = deserialize(time, timestampCol, "mysql");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T13:30:45.123Z");
      });

      it("should preserve absolute time across timezone conversions", () => {
        const timestampCol = column("timestamp");
        // Same absolute time in different timezones
        const utcTime = "2024-06-15T12:00:00Z";
        const cstTime = "2024-06-15T20:00:00+08:00"; // China Standard Time
        const pstTime = "2024-06-15T04:00:00-08:00"; // Pacific Time

        const utcResult = deserialize(utcTime, timestampCol, "mysql");
        const cstResult = deserialize(cstTime, timestampCol, "mysql");
        const pstResult = deserialize(pstTime, timestampCol, "mysql");

        assert.instanceOf(utcResult, Date);
        assert.instanceOf(cstResult, Date);
        assert.instanceOf(pstResult, Date);

        // All should represent the same absolute time
        expect(utcResult.getTime()).toBe(cstResult.getTime());
        expect(utcResult.getTime()).toBe(pstResult.getTime());
        expect(cstResult.getTime()).toBe(pstResult.getTime());
      });
    });

    describe("cockroachdb date handling", () => {
      it("should convert string timestamps to Date", () => {
        const timestampCol = column("timestamp");
        const time = "2024-01-01 12:30:45.123";
        const result = deserialize(time, timestampCol, "cockroachdb");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-01-01T12:30:45.123Z");
      });

      it("should convert date strings to Date", () => {
        const dateCol = column("date");
        const time = "2024-01-01";
        expect(deserialize(time, dateCol, "cockroachdb")).toEqual(new Date(time));
      });

      it("should handle timestamps with positive timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00+05:30"; // India Standard Time
        const result = deserialize(time, timestampCol, "cockroachdb");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T09:00:00.000Z");
      });

      it("should handle timestamps with negative timezone offset", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:00-08:00"; // Pacific Time
        const result = deserialize(time, timestampCol, "cockroachdb");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T22:30:00.000Z");
      });

      it("should handle timestamps with fractional seconds and timezone", () => {
        const timestampCol = column("timestamp");
        const time = "2024-06-15T14:30:45.123+01:00"; // Central European Time
        const result = deserialize(time, timestampCol, "cockroachdb");
        assert.instanceOf(result, Date);
        expect(result.toISOString()).toBe("2024-06-15T13:30:45.123Z");
      });

      it("should preserve absolute time across timezone conversions", () => {
        const timestampCol = column("timestamp");
        // Same absolute time in different timezones
        const utcTime = "2024-06-15T12:00:00Z";
        const aestTime = "2024-06-15T22:00:00+10:00"; // Australian Eastern Standard Time
        const brtTime = "2024-06-15T09:00:00-03:00"; // Brasilia Time

        const utcResult = deserialize(utcTime, timestampCol, "cockroachdb");
        const aestResult = deserialize(aestTime, timestampCol, "cockroachdb");
        const brtResult = deserialize(brtTime, timestampCol, "cockroachdb");

        assert.instanceOf(utcResult, Date);
        assert.instanceOf(aestResult, Date);
        assert.instanceOf(brtResult, Date);

        // All should represent the same absolute time
        expect(utcResult.getTime()).toBe(aestResult.getTime());
        expect(utcResult.getTime()).toBe(brtResult.getTime());
        expect(aestResult.getTime()).toBe(brtResult.getTime());
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
        assert.instanceOf(result, Uint8Array);
        expect(Array.from(result)).toEqual([1, 2, 3, 4]);
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
        assert.instanceOf(result, Buffer);
        expect(result.readBigInt64BE(0)).toBe(bigintValue);
      });
    });

    describe("binary handling", () => {
      it("should convert Uint8Array to Buffer", () => {
        const binaryCol = column("binary");
        const uint8 = new Uint8Array([1, 2, 3, 4]);
        const result = serialize(uint8, binaryCol, "postgresql");
        assert.instanceOf(result, Buffer);
        expect(Array.from(result)).toEqual([1, 2, 3, 4]);
      });

      it("should handle Buffer as-is", () => {
        const binaryCol = column("binary");
        const buffer = Buffer.from([1, 2, 3, 4]);
        const result = serialize(buffer, binaryCol, "mysql");
        // Buffer is also a Uint8Array, so it should be converted
        assert.instanceOf(result, Buffer);
      });
    });

    describe("passthrough values", () => {
      it("should pass through values that don't need conversion", () => {
        expect(serialize("test", column("string"), "postgresql")).toBe("test");
        expect(serialize(42, column("integer"), "mysql")).toBe(42);
        expect(serialize(3.14, column("decimal"), "mssql")).toBe(3.14);
      });
    });

    describe("skipDriverConversions", () => {
      it("should skip Date to number conversion for SQLite when enabled", () => {
        const date = new Date("2024-01-01T00:00:00.000Z");
        const timestampCol = column("timestamp");

        // Default behavior: converts to number
        const withConversion = serialize(date, timestampCol, "sqlite", false);
        expect(withConversion).toBe(date.getTime());
        expect(typeof withConversion).toBe("number");

        // With skipDriverConversions: passes through Date
        const withoutConversion = serialize(date, timestampCol, "sqlite", true);
        expect(withoutConversion).toBe(date);
        assert.instanceOf(withoutConversion, Date);
      });

      it("should skip boolean to number conversion for SQLite when enabled", () => {
        const boolCol = column("bool");

        // Default behavior: converts to 0/1
        expect(serialize(true, boolCol, "sqlite", false)).toBe(1);
        expect(serialize(false, boolCol, "sqlite", false)).toBe(0);

        // With skipDriverConversions: passes through boolean
        expect(serialize(true, boolCol, "sqlite", true)).toBe(true);
        expect(serialize(false, boolCol, "sqlite", true)).toBe(false);
      });

      it("should skip bigint to Buffer conversion for SQLite when enabled", () => {
        const bigintValue = 123456789n;
        const bigintCol = column("bigint");

        // Default behavior: converts to Buffer
        const withConversion = serialize(bigintValue, bigintCol, "sqlite", false);
        assert.instanceOf(withConversion, Buffer);
        expect(withConversion.readBigInt64BE(0)).toBe(bigintValue);

        // With skipDriverConversions: passes through bigint
        const withoutConversion = serialize(bigintValue, bigintCol, "sqlite", true);
        expect(withoutConversion).toBe(bigintValue);
        expect(typeof withoutConversion).toBe("bigint");
      });

      it("should skip reference column bigint to Number conversion for SQLite when enabled", () => {
        const bigintValue = 123456789n;
        const refCol = referenceColumn();

        // Default behavior: converts to Number for reference columns
        const withConversion = serialize(bigintValue, refCol, "sqlite", false);
        expect(withConversion).toBe(123456789);
        expect(typeof withConversion).toBe("number");

        // With skipDriverConversions: passes through bigint
        const withoutConversion = serialize(bigintValue, refCol, "sqlite", true);
        expect(withoutConversion).toBe(bigintValue);
        expect(typeof withoutConversion).toBe("bigint");
      });

      it("should skip internal-id column bigint to Number conversion for SQLite when enabled", () => {
        const bigintValue = 123456789n;
        const internalIdCol = internalIdColumn();

        // Default behavior: converts to Number for internal-id columns
        const withConversion = serialize(bigintValue, internalIdCol, "sqlite", false);
        expect(withConversion).toBe(123456789);
        expect(typeof withConversion).toBe("number");

        // With skipDriverConversions: passes through bigint
        const withoutConversion = serialize(bigintValue, internalIdCol, "sqlite", true);
        expect(withoutConversion).toBe(bigintValue);
        expect(typeof withoutConversion).toBe("bigint");
      });

      it("should still handle JSON stringification when skipDriverConversions is enabled", () => {
        const jsonCol = column("json");
        const obj = { key: "value" };

        // JSON stringification happens regardless of skipDriverConversions
        expect(serialize(obj, jsonCol, "sqlite", false)).toBe('{"key":"value"}');
        expect(serialize(obj, jsonCol, "sqlite", true)).toBe('{"key":"value"}');
      });

      it("should still handle binary conversion when skipDriverConversions is enabled", () => {
        const binaryCol = column("binary");
        const uint8 = new Uint8Array([1, 2, 3, 4]);

        // Binary conversion happens regardless of skipDriverConversions
        const withConversion = serialize(uint8, binaryCol, "sqlite", false);
        assert.instanceOf(withConversion, Buffer);
        expect(Array.from(withConversion)).toEqual([1, 2, 3, 4]);

        const withoutConversion = serialize(uint8, binaryCol, "sqlite", true);
        assert.instanceOf(withoutConversion, Buffer);
        expect(Array.from(withoutConversion)).toEqual([1, 2, 3, 4]);
      });
    });
  });
});
