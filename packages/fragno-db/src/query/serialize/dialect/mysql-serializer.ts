import type { AnyColumn } from "../../../schema/create";
import { SQLSerializer } from "../sql-serializer";
import type { DriverConfig } from "../../../adapters/generic-sql/driver-config";

/**
 * MySQL-specific serializer.
 *
 * MySQL has good native type support:
 * - Native JSON support (MySQL 5.7+)
 * - Native boolean type (TINYINT(1))
 * - Native timestamp/datetime/date types
 * - Native bigint support
 *
 * Similar to PostgreSQL, most values pass through without conversion.
 * Timestamps/dates are returned as strings and need to be parsed.
 */
export class MySQLSerializer extends SQLSerializer {
  constructor(driverConfig: DriverConfig) {
    super(driverConfig);
  }

  protected serializeDate(value: Date, _col: AnyColumn): Date {
    void _col;
    // MySQL handles Date objects natively
    return value;
  }

  protected serializeBoolean(value: boolean): boolean {
    // MySQL handles boolean natively (as TINYINT(1))
    return value;
  }

  protected serializeBigInt(value: bigint, _col: AnyColumn): bigint {
    // MySQL handles bigint natively
    return value;
  }

  protected deserializeDate(value: unknown, _col: AnyColumn): Date {
    void _col;
    if (value instanceof Date) {
      return value;
    }
    // MySQL returns timestamps/dates as strings
    if (typeof value === "string") {
      return new Date(value);
    }
    throw new Error(`Cannot deserialize date from value: ${value}`);
  }

  protected deserializeBoolean(value: unknown): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    // MySQL may return booleans as numbers (0/1)
    if (typeof value === "number") {
      return value === 1;
    }
    throw new Error(`Cannot deserialize boolean from value: ${value}`);
  }

  protected deserializeBigInt(value: unknown): bigint {
    if (typeof value === "bigint") {
      return value;
    }
    // MySQL may return bigints as strings
    if (typeof value === "string") {
      return BigInt(value);
    }
    if (typeof value === "number") {
      return BigInt(value);
    }
    throw new Error(`Cannot deserialize bigint from value: ${value}`);
  }

  protected serializeJson(value: unknown): unknown {
    // MySQL supports native JSON, pass through as-is
    return value;
  }

  protected deserializeJson(value: unknown): unknown {
    // MySQL returns parsed JSON objects, pass through as-is
    return value;
  }

  protected deserializeBinary(value: unknown): Uint8Array {
    // MySQL can return Buffer or Uint8Array for BLOB columns
    if (value instanceof Buffer) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    throw new Error(`Cannot deserialize binary from value: ${typeof value}`);
  }

  protected deserializeInteger(value: unknown): number {
    if (typeof value === "number") {
      return value;
    }
    // MySQL may return integers as strings
    if (typeof value === "string") {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error(`Cannot deserialize integer from invalid string: ${value}`);
      }
      return num;
    }
    // MySQL may return bigint for large integers
    if (typeof value === "bigint") {
      if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
        throw new RangeError(
          `Cannot deserialize integer value ${value}: exceeds safe integer range`,
        );
      }
      return Number(value);
    }
    throw new Error(`Cannot deserialize integer from value: ${typeof value}`);
  }

  protected deserializeDecimal(value: unknown): number {
    // MySQL can return decimals as numbers or strings
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const num = parseFloat(value);
      if (isNaN(num)) {
        throw new Error(`Cannot deserialize decimal from invalid string: ${value}`);
      }
      return num;
    }
    throw new Error(`Cannot deserialize decimal from value: ${typeof value}`);
  }

  protected deserializeString(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    throw new Error(`Cannot deserialize string from value: ${typeof value}`);
  }
}
