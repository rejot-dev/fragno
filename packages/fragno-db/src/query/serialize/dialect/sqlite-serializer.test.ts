import { describe, it, expect } from "vitest";
import { SQLiteSerializer } from "./sqlite-serializer";
import type { AnyColumn } from "../../../schema/create";
import type { DriverConfig } from "../../../adapters/generic-sql/driver-config";

describe("SQLiteSerializer", () => {
  const mockDriverConfig: DriverConfig = {
    driverType: "better-sqlite3",
    databaseType: "sqlite",
    supportsReturning: true,
    supportsRowsAffected: true,
    supportsJson: false,
  };

  const serializer = new SQLiteSerializer(mockDriverConfig);

  describe("serializeBigInt", () => {
    describe("for internal-id and reference columns", () => {
      it("should convert safe bigint to number for reference column", () => {
        const col: AnyColumn = {
          name: "userId",
          type: "bigint",
          role: "reference",
          isNullable: false,
        } as AnyColumn;

        const result = serializer["serializeBigInt"](BigInt(123), col);
        expect(result).toBe(123);
        expect(typeof result).toBe("number");
      });

      it("should convert safe bigint to number for internal-id column", () => {
        const col: AnyColumn = {
          name: "_internalId",
          type: "bigint",
          role: "internal-id",
          isNullable: false,
        } as AnyColumn;

        const result = serializer["serializeBigInt"](BigInt(456), col);
        expect(result).toBe(456);
        expect(typeof result).toBe("number");
      });

      it("should convert MAX_SAFE_INTEGER successfully", () => {
        const col: AnyColumn = {
          name: "userId",
          type: "bigint",
          role: "reference",
          isNullable: false,
        } as AnyColumn;

        const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
        const result = serializer["serializeBigInt"](maxSafe, col);
        expect(result).toBe(Number.MAX_SAFE_INTEGER);
      });

      it("should convert negative MAX_SAFE_INTEGER successfully", () => {
        const col: AnyColumn = {
          name: "userId",
          type: "bigint",
          role: "reference",
          isNullable: false,
        } as AnyColumn;

        const minSafe = BigInt(-Number.MAX_SAFE_INTEGER);
        const result = serializer["serializeBigInt"](minSafe, col);
        expect(result).toBe(-Number.MAX_SAFE_INTEGER);
      });

      it("should throw RangeError when bigint exceeds MAX_SAFE_INTEGER for reference column", () => {
        const col: AnyColumn = {
          name: "userId",
          type: "bigint",
          role: "reference",
          isNullable: false,
        } as AnyColumn;

        const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);

        expect(() => serializer["serializeBigInt"](tooBig, col)).toThrow(RangeError);
        expect(() => serializer["serializeBigInt"](tooBig, col)).toThrow(
          /Cannot serialize bigint value.*exceeds Number\.MAX_SAFE_INTEGER/,
        );
        expect(() => serializer["serializeBigInt"](tooBig, col)).toThrow(/userId/);
      });

      it("should throw RangeError when bigint is less than -MAX_SAFE_INTEGER for internal-id column", () => {
        const col: AnyColumn = {
          name: "_internalId",
          type: "bigint",
          role: "internal-id",
          isNullable: false,
        } as AnyColumn;

        const tooSmall = BigInt(-Number.MAX_SAFE_INTEGER) - BigInt(1);

        expect(() => serializer["serializeBigInt"](tooSmall, col)).toThrow(RangeError);
        expect(() => serializer["serializeBigInt"](tooSmall, col)).toThrow(
          /Cannot serialize bigint value.*exceeds Number\.MAX_SAFE_INTEGER/,
        );
        expect(() => serializer["serializeBigInt"](tooSmall, col)).toThrow(/_internalId/);
      });
    });

    describe("for regular bigint columns", () => {
      it("should convert to Buffer for regular bigint column", () => {
        const col: AnyColumn = {
          name: "largeNumber",
          type: "bigint",
          role: "regular",
          isNullable: false,
        } as AnyColumn;

        const result = serializer["serializeBigInt"](BigInt(789), col);
        expect(result).toBeInstanceOf(Buffer);
        expect((result as Buffer).length).toBe(8);
      });

      it("should handle large values outside safe integer range as Buffer", () => {
        const col: AnyColumn = {
          name: "largeNumber",
          type: "bigint",
          role: "regular",
          isNullable: false,
        } as AnyColumn;

        const veryLarge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1000);
        const result = serializer["serializeBigInt"](veryLarge, col);

        expect(result).toBeInstanceOf(Buffer);
        // Verify round-trip
        const deserialized = (result as Buffer).readBigInt64BE(0);
        expect(deserialized).toBe(veryLarge);
      });
    });
  });

  describe("other serialization methods", () => {
    it("should serialize Date to timestamp number", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      const result = serializer["serializeDate"](date);
      expect(result).toBe(date.getTime());
      expect(typeof result).toBe("number");
    });

    it("should serialize boolean to 0/1", () => {
      expect(serializer["serializeBoolean"](true)).toBe(1);
      expect(serializer["serializeBoolean"](false)).toBe(0);
    });

    it("should serialize JSON to string", () => {
      const obj = { foo: "bar", num: 42 };
      const result = serializer["serializeJson"](obj);
      expect(result).toBe(JSON.stringify(obj));
      expect(typeof result).toBe("string");
    });
  });

  describe("deserializeBinary", () => {
    it("should deserialize Buffer to Uint8Array", () => {
      const buffer = Buffer.from([1, 2, 3, 4]);
      const result = serializer["deserializeBinary"](buffer);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    });

    it("should deserialize Uint8Array directly", () => {
      const uint8 = new Uint8Array([5, 6, 7, 8]);
      const result = serializer["deserializeBinary"](uint8);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toBe(uint8);
    });

    it("should deserialize ArrayBuffer to Uint8Array", () => {
      const arrayBuffer = new ArrayBuffer(4);
      const view = new Uint8Array(arrayBuffer);
      view.set([9, 10, 11, 12]);
      const result = serializer["deserializeBinary"](arrayBuffer);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([9, 10, 11, 12]);
    });

    it("should throw error for invalid binary value", () => {
      expect(() => serializer["deserializeBinary"]("not binary")).toThrow(
        /Cannot deserialize binary/,
      );
    });
  });

  describe("deserializeInteger", () => {
    it("should deserialize number directly", () => {
      expect(serializer["deserializeInteger"](42)).toBe(42);
    });

    it("should deserialize string to number", () => {
      expect(serializer["deserializeInteger"]("123")).toBe(123);
    });

    it("should deserialize bigint to number when safe", () => {
      expect(serializer["deserializeInteger"](BigInt(456))).toBe(456);
    });

    it("should throw error when bigint exceeds safe range", () => {
      const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
      expect(() => serializer["deserializeInteger"](tooBig)).toThrow(RangeError);
      expect(() => serializer["deserializeInteger"](tooBig)).toThrow(/exceeds safe integer range/);
    });

    it("should throw error for invalid string", () => {
      expect(() => serializer["deserializeInteger"]("not a number")).toThrow(
        /Cannot deserialize integer from invalid string/,
      );
    });

    it("should throw error for invalid type", () => {
      expect(() => serializer["deserializeInteger"](null)).toThrow(
        /Cannot deserialize integer from value/,
      );
    });
  });

  describe("deserializeDecimal", () => {
    it("should deserialize number directly", () => {
      expect(serializer["deserializeDecimal"](3.14)).toBe(3.14);
    });

    it("should deserialize string to number", () => {
      expect(serializer["deserializeDecimal"]("3.14")).toBe(3.14);
      expect(serializer["deserializeDecimal"]("123.456")).toBe(123.456);
      expect(serializer["deserializeDecimal"]("-99.99")).toBe(-99.99);
    });

    it("should throw error for invalid string", () => {
      expect(() => serializer["deserializeDecimal"]("not a number")).toThrow(
        /Cannot deserialize decimal from invalid string/,
      );
    });

    it("should throw error for invalid type", () => {
      expect(() => serializer["deserializeDecimal"](null)).toThrow(
        /Cannot deserialize decimal from value/,
      );
    });
  });

  describe("deserializeString", () => {
    it("should deserialize string directly", () => {
      expect(serializer["deserializeString"]("hello")).toBe("hello");
    });

    it("should throw error for non-string", () => {
      expect(() => serializer["deserializeString"](123)).toThrow(
        /Cannot deserialize string from value/,
      );
    });
  });
});
