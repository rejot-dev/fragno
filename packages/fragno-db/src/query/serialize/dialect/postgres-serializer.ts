import type { AnyColumn } from "../../../schema/create";
import { SQLSerializer } from "../sql-serializer";
import type { DriverConfig } from "../../../adapters/generic-sql/driver-config";

/**
 * PostgreSQL-specific serializer.
 *
 * PostgreSQL has excellent native type support:
 * - Native JSON support
 * - Native boolean type
 * - Native timestamp/date types
 * - Native bigint support
 *
 * Most values pass through without conversion, only strings need to be parsed to Date.
 */
export class PostgreSQLSerializer extends SQLSerializer {
  constructor(driverConfig: DriverConfig) {
    super(driverConfig);
  }

  protected serializeDate(value: Date, _col: AnyColumn): Date {
    void _col;
    // PostgreSQL handles Date objects natively
    return value;
  }

  protected serializeBoolean(value: boolean): boolean {
    // PostgreSQL handles boolean natively
    return value;
  }

  protected serializeBigInt(value: bigint, _col: AnyColumn): bigint {
    // PostgreSQL handles bigint natively
    return value;
  }

  protected deserializeDate(value: unknown, _col: AnyColumn): Date {
    void _col;
    if (value instanceof Date) {
      if (this.driverConfig.driverType === "pglite") {
        return new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
      }
      return value;
    }
    // PostgreSQL returns timestamps/dates as strings
    if (typeof value === "string") {
      // Normalize timezone-less timestamps to UTC to avoid local offset drift.
      return new Date(normalizeTimestampString(value));
    }
    throw new Error(`Cannot deserialize date from value: ${value}`);
  }

  protected deserializeBoolean(value: unknown): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    throw new Error(`Cannot deserialize boolean from value: ${value}`);
  }

  protected deserializeBigInt(value: unknown): bigint {
    if (typeof value === "bigint") {
      return value;
    }
    // PostgreSQL may return bigints as strings
    if (typeof value === "string") {
      return BigInt(value);
    }
    if (typeof value === "number") {
      return BigInt(value);
    }
    throw new Error(`Cannot deserialize bigint from value: ${value}`);
  }

  protected serializeJson(value: unknown): unknown {
    // PostgreSQL supports native JSON, pass through as-is
    return value;
  }

  protected deserializeJson(value: unknown): unknown {
    // PostgreSQL returns parsed JSON objects, pass through as-is
    return value;
  }

  protected deserializeBinary(value: unknown): Uint8Array {
    // PostgreSQL can return Buffer or Uint8Array for BYTEA columns
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
    // PostgreSQL may return bigint for large integers
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
    // PostgreSQL can return decimals as numbers or strings depending on precision
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

const normalizeTimestampString = (value: string) => {
  if (!hasTimeComponent(value) || !isTimestampWithoutTimezone(value)) {
    return value;
  }
  const withTimeSeparator = value.includes(" ") ? value.replace(" ", "T") : value;
  return `${withTimeSeparator}Z`;
};

const hasTimeComponent = (value: string) => /\d{2}:\d{2}:\d{2}/.test(value);

const isTimestampWithoutTimezone = (value: string) => {
  // Detect RFC3339-like timezone indicators: Z or +/-HH(:MM)?
  if (value.endsWith("Z")) {
    return false;
  }
  return !/[+-]\d{2}(:?\d{2})?$/.test(value);
};
