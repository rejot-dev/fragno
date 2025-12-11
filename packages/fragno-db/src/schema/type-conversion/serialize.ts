import type { SQLProvider } from "../../shared/providers";
import type { AnyColumn } from "../create";
import { FragnoId, FragnoReference } from "../create";

const supportJson: SQLProvider[] = ["postgresql", "cockroachdb", "mysql"];

/**
 * Deserialize a value from database format to application format.
 *
 * Handles provider-specific type conversions:
 * - SQLite: numbers → Date, 0/1 → boolean, Buffer → BigInt
 * - PostgreSQL/MySQL: strings → Date
 * - JSON parsing for non-native JSON databases
 * - Buffer → Uint8Array for binary columns
 *
 * @param value - The raw database value
 * @param col - The column schema definition
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @returns The deserialized value in application format
 */
export function deserialize(value: unknown, col: AnyColumn, provider: SQLProvider) {
  if (value === null) {
    return null;
  }

  if (!supportJson.includes(provider) && col.type === "json" && typeof value === "string") {
    return JSON.parse(value);
  }

  if (
    provider === "sqlite" &&
    (col.type === "timestamp" || col.type === "date") &&
    (typeof value === "number" || typeof value === "string")
  ) {
    return new Date(value);
  }

  if (
    (provider === "postgresql" || provider === "cockroachdb") &&
    (col.type === "timestamp" || col.type === "date") &&
    typeof value === "string"
  ) {
    return new Date(value);
  }

  if (
    provider === "mysql" &&
    (col.type === "timestamp" || col.type === "date") &&
    typeof value === "string"
  ) {
    return new Date(value);
  }

  if (col.type === "bool" && typeof value === "number") {
    return value === 1;
  }

  if (col.type === "bigint" && value instanceof Buffer) {
    return value.readBigInt64BE(0);
  }

  if (col.type === "bigint" && typeof value === "string") {
    return BigInt(value);
  }

  if (col.type === "bigint" && typeof value === "number") {
    return BigInt(value);
  }

  if (col.type === "binary" && value instanceof Buffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return value;
}

/**
 * Serialize a value from application format to database format.
 *
 * Handles provider-specific type conversions:
 * - SQLite: Date → number, boolean → 0/1, BigInt → Buffer
 * - JSON stringification for non-native JSON databases
 * - FragnoId/FragnoReference → appropriate ID values
 * - Uint8Array → Buffer for binary columns
 *
 * @param value - The application value to serialize
 * @param col - The column schema definition
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @param skipDriverConversions - Skip driver-level type conversions (Date->number, boolean->0/1, bigint->Buffer).
 *                                 Set to true when using ORMs like Drizzle that handle these conversions internally.
 * @returns The serialized value in database format
 */
export function serialize(
  value: unknown,
  col: AnyColumn,
  provider: SQLProvider,
  skipDriverConversions = false,
) {
  if (value === null) {
    return null;
  }

  // Handle FragnoReference objects (for reference columns)
  if (value instanceof FragnoReference) {
    return value.internalId;
  }

  // Handle FragnoId objects
  if (value instanceof FragnoId) {
    // For external ID columns, use the external ID
    if (col.role === "external-id") {
      return value.externalId;
    }
    // For internal ID columns, use the internal ID (must be present)
    if (col.role === "internal-id") {
      if (!value.internalId) {
        throw new Error(`FragnoId must have internalId for internal-id column ${col.name}`);
      }
      return value.internalId;
    }
    // For reference columns, prefer internal ID if available
    if (col.role === "reference") {
      return value.databaseId;
    }
    // Default to external ID for other columns
    return value.externalId;
  }

  if (!supportJson.includes(provider) && col.type === "json") {
    return JSON.stringify(value);
  }

  // Skip driver-specific type conversions when using ORMs that handle them internally
  if (!skipDriverConversions) {
    if (provider === "sqlite" && value instanceof Date) {
      return value.getTime();
    }

    if (provider === "sqlite" && typeof value === "boolean") {
      return value ? 1 : 0;
    }

    if (provider === "sqlite" && typeof value === "bigint") {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(value);
      return buf;
    }
  }

  // most drivers accept Buffer
  if (col.type === "binary" && value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  return value;
}
