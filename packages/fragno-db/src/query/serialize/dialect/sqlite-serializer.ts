import type { AnyColumn } from "../../../schema/create";
import { SQLSerializer } from "../sql-serializer";
import type { DriverConfig } from "../../../adapters/generic-sql/driver-config";

/**
 * SQLite-specific serializer.
 *
 * SQLite has limited native type support and requires conversions:
 * - JSON → strings (no native JSON support)
 * - Dates → numbers (timestamps)
 * - Booleans → 0/1
 * - BigInts → Buffer (except for internal-id and reference columns → number)
 * - Numbers/strings → Date for timestamps/dates
 */
export class SQLiteSerializer extends SQLSerializer {
  constructor(driverConfig: DriverConfig) {
    super(driverConfig);
  }

  protected serializeDate(value: Date): number {
    return value.getTime();
  }

  protected serializeBoolean(value: boolean): number {
    return value ? 1 : 0;
  }

  protected serializeBigInt(value: bigint, col: AnyColumn): number | Buffer {
    // SQLite special case: internal-id and reference columns use integer, not blob
    // These should be converted to numbers for SQLite
    if (col.role === "reference" || col.role === "internal-id") {
      // Check if the bigint is within the safe integer range to avoid precision loss
      if (Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          `Cannot serialize bigint value ${value} for column "${col.name}": ` +
            `value exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
            `SQLite reference and internal-id columns use INTEGER type which requires values ` +
            `to fit within JavaScript's safe integer range.`,
        );
      }
      return Number(value);
    }
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(value);
    return buf;
  }

  protected deserializeDate(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "number" || typeof value === "string") {
      return new Date(value);
    }
    throw new Error(`Cannot deserialize date from value: ${value}`);
  }

  protected deserializeBoolean(value: unknown): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value === 1;
    }
    throw new Error(`Cannot deserialize boolean from value: ${value}`);
  }

  protected deserializeBigInt(value: unknown): bigint {
    if (typeof value === "bigint") {
      return value;
    }
    if (value instanceof Buffer) {
      return value.readBigInt64BE(0);
    }
    if (typeof value === "string") {
      return BigInt(value);
    }
    if (typeof value === "number") {
      return BigInt(value);
    }
    throw new Error(`Cannot deserialize bigint from value: ${value}`);
  }

  protected serializeJson(value: unknown): string {
    // SQLite doesn't support native JSON, so we stringify
    return JSON.stringify(value);
  }

  protected deserializeJson(value: unknown): unknown {
    // SQLite stores JSON as strings, so we need to parse
    if (typeof value !== "string") {
      throw new Error(`Expected JSON string but got ${typeof value}`);
    }
    return JSON.parse(value);
  }

  protected deserializeBinary(value: unknown): Uint8Array {
    // SQLite can return Buffer or Uint8Array for BLOB columns
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
    // SQLite may return integers as strings for large values
    if (typeof value === "string") {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error(`Cannot deserialize integer from invalid string: ${value}`);
      }
      return num;
    }
    // SQLite may return bigint for large integers
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
    // SQLite stores decimals as REAL (floating point) or TEXT
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
