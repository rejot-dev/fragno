import type { AnyColumn } from "../../../schema/create";
import { SQLSerializer } from "../sql-serializer";
import type { DriverConfig } from "../../../adapters/generic-sql/driver-config";
import type { SQLiteStorageMode } from "../../../adapters/generic-sql/sqlite-storage";
import { sqliteStorageDefault } from "../../../adapters/generic-sql/sqlite-storage";

const SQLITE_UTC_TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

function parseSQLiteUtcTimestamp(value: string): Date | null {
  const match = SQLITE_UTC_TIMESTAMP_REGEX.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, millis] = match;
  const milliseconds = millis ? Number(millis.padEnd(3, "0")) : 0;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    ),
  );
}

/**
 * SQLite-specific serializer.
 *
 * SQLite has limited native type support and requires conversions:
 * - JSON → strings (no native JSON support)
 * - Dates → numbers or ISO strings (storage-mode dependent)
 * - Booleans → 0/1
 * - BigInts → Buffer or integer (storage-mode dependent; internal-id/reference stay integer)
 * - Numbers/strings → Date for timestamps/dates
 */
export class SQLiteSerializer extends SQLSerializer {
  private readonly sqliteStorageMode: SQLiteStorageMode;

  constructor(driverConfig: DriverConfig, sqliteStorageMode?: SQLiteStorageMode) {
    super(driverConfig);
    this.sqliteStorageMode = sqliteStorageMode ?? sqliteStorageDefault;
  }

  protected serializeDate(value: Date, col: AnyColumn): number | string {
    const storage =
      col.type === "date"
        ? this.sqliteStorageMode.dateStorage
        : this.sqliteStorageMode.timestampStorage;
    if (storage === "iso-text") {
      return value.toISOString();
    }
    return value.getTime();
  }

  protected serializeBoolean(value: boolean): number {
    return value ? 1 : 0;
  }

  protected serializeBigInt(value: bigint, col: AnyColumn): bigint | number | Buffer {
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
    if (this.sqliteStorageMode.bigintStorage === "integer") {
      return value;
    }
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(value);
    return buf;
  }

  protected deserializeDate(value: unknown, col: AnyColumn): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "string") {
      if (/^\d+$/.test(value)) {
        const numericDate = new Date(Number(value));
        if (Number.isNaN(numericDate.getTime())) {
          throw new Error(`Cannot deserialize date from value: ${value}`);
        }
        return numericDate;
      }
      const parsed = parseSQLiteUtcTimestamp(value);
      const date = parsed ?? new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Cannot deserialize date from value: ${value}`);
      }
      return date;
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        throw new Error(`Cannot deserialize date from value: ${value}`);
      }
      return new Date(value);
    }
    if (typeof value === "bigint") {
      const storage =
        col.type === "date"
          ? this.sqliteStorageMode.dateStorage
          : this.sqliteStorageMode.timestampStorage;
      if (storage === "epoch-ms") {
        const date = new Date(Number(value));
        if (Number.isNaN(date.getTime())) {
          throw new Error(`Cannot deserialize date from value: ${value}`);
        }
        return date;
      }
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
      if (this.sqliteStorageMode.bigintStorage === "integer") {
        if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
          throw new RangeError(
            `Cannot deserialize bigint value ${value}: exceeds Number.MAX_SAFE_INTEGER`,
          );
        }
      }
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
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`Cannot deserialize integer from invalid number: ${value}`);
      }
      return value;
    }
    // SQLite may return integers as strings for large values
    if (typeof value === "string") {
      const num = Number(value);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
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
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`Cannot deserialize decimal from invalid number: ${value}`);
      }
      return value;
    }
    if (typeof value === "string") {
      const num = parseFloat(value);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
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
