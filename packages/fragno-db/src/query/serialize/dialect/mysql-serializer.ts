import type { DriverConfig } from "../../../adapters/generic-sql/driver-config";
import type { AnyColumn } from "../../../schema/create";
import { SQLSerializer } from "../sql-serializer";

const MYSQL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseMySQLDate(value: string): Date {
  const match = MYSQL_DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Cannot deserialize MySQL DATE from value: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Cannot deserialize MySQL DATE from value: ${value}`);
  }

  return date;
}

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
 * Timestamp values may be returned as Date objects or strings. Fragno projects SQL DATE values as
 * strings so mysql2 cannot change their calendar date through timezone conversion.
 */
export class MySQLSerializer extends SQLSerializer {
  constructor(driverConfig: DriverConfig) {
    super(driverConfig);
  }

  protected serializeDate(value: Date, col: AnyColumn): Date | string {
    if (col.type === "date") {
      return value.toISOString().slice(0, 10);
    }
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

  protected deserializeDate(value: unknown, col: AnyColumn): Date {
    if (col.type === "date") {
      if (typeof value !== "string") {
        throw new Error(
          "MySQL DATE columns must be projected as strings before result deserialization.",
        );
      }
      return parseMySQLDate(value);
    }

    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "string") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
    throw new Error(`Cannot deserialize date from value: ${String(value)}`);
  }

  protected deserializeBoolean(value: unknown): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    // MySQL may return booleans as numbers (0/1)
    if (typeof value === "number") {
      return value === 1;
    }
    throw new Error(`Cannot deserialize boolean from value: ${String(value)}`);
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
    throw new Error(`Cannot deserialize bigint from value: ${String(value)}`);
  }

  protected serializeJson(value: unknown): string {
    return JSON.stringify(value);
  }

  protected deserializeJson(value: unknown): unknown {
    if (typeof value === "string") {
      return JSON.parse(value);
    }
    return value;
  }

  protected deserializeBinary(value: unknown): Uint8Array {
    // MySQL can return Buffer or Uint8Array for BLOB columns
    if (value instanceof Buffer) {
      // oxlint-disable-next-line typescript/no-unsafe-return -- Node's Buffer generic defaults differ from Uint8Array's lib type.
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof Uint8Array) {
      // oxlint-disable-next-line typescript/no-unsafe-return -- The runtime value already satisfies the declared typed-array contract.
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
    // MySQL may return integers as strings
    if (typeof value === "string") {
      const num = Number(value);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
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
