import type { DriverConfig } from "../../adapters/generic-sql/driver-config";
import type { AnyColumn } from "../../schema/create";

/**
 * Abstract base class for SQL value serialization/deserialization.
 *
 * Similar to SQLTypeMapper, this class provides a framework for converting values
 * between application format and database format. Each database dialect extends
 * this class and implements abstract methods for dialect-specific conversions.
 *
 * Handles:
 * - Type conversions (Date, boolean, BigInt, etc.)
 * - JSON handling (delegated to dialect-specific implementations)
 * - Binary data conversion (Uint8Array ↔ Buffer)
 */
export abstract class SQLSerializer {
  protected readonly driverConfig: DriverConfig;

  constructor(driverConfig: DriverConfig) {
    this.driverConfig = driverConfig;
  }

  /**
   * Deserialize a value from database format to application format.
   *
   * @param value - The raw database value
   * @param col - The column schema definition
   * @returns The deserialized value in application format
   * @throws Error if value cannot be deserialized to the expected type
   */
  deserialize(value: unknown, col: AnyColumn): unknown {
    if (value === null) {
      return null;
    }

    // Handle JSON deserialization (delegated to subclass)
    if (col.type === "json") {
      return this.deserializeJson(value);
    }

    // Handle date/timestamp deserialization
    if (col.type === "timestamp" || col.type === "date") {
      return this.deserializeDate(value, col);
    }

    // Handle boolean deserialization
    if (col.type === "bool") {
      return this.deserializeBoolean(value);
    }

    // Handle bigint deserialization
    if (col.type === "bigint") {
      return this.deserializeBigInt(value);
    }

    // Handle binary deserialization (delegated to subclass for driver flexibility)
    if (col.type === "binary") {
      return this.deserializeBinary(value);
    }

    // Handle integer deserialization (delegated to subclass - drivers may return string/bigint)
    if (col.type === "integer") {
      return this.deserializeInteger(value);
    }

    // Handle decimal deserialization (delegated to subclass for driver flexibility)
    if (col.type === "decimal") {
      return this.deserializeDecimal(value);
    }

    // Handle string/varchar deserialization (delegated to subclass for consistency)
    if (col.type === "string" || (typeof col.type === "string" && col.type.startsWith("varchar"))) {
      return this.deserializeString(value);
    }

    throw new Error(`Unsupported column type for deserialization: ${col.type}`);
  }

  /**
   * Serialize a value from application format to database format.
   *
   * Note: This method expects FragnoId/FragnoReference objects to be resolved
   * to primitive values before calling. Use resolveFragnoIdValue() from
   * value-encoding.ts for this purpose.
   *
   * @param value - The application value to serialize (should not be FragnoId/FragnoReference)
   * @param col - The column schema definition
   * @param skipDriverConversions - Skip driver-level type conversions (Date->number, boolean->0/1, bigint->Buffer).
   *                                 Set to true when using ORMs like Drizzle that handle these conversions internally.
   * @returns The serialized value in database format
   */
  serialize(value: unknown, col: AnyColumn, skipDriverConversions = false): unknown {
    if (value === null) {
      return null;
    }

    // Handle JSON serialization (delegated to subclass)
    if (col.type === "json") {
      return this.serializeJson(value);
    }

    // Skip driver-specific type conversions when using ORMs that handle them internally
    if (!skipDriverConversions) {
      // Handle date/timestamp serialization
      if (value instanceof Date) {
        return this.serializeDate(value, col);
      }

      // Handle boolean serialization
      if (typeof value === "boolean") {
        return this.serializeBoolean(value);
      }

      // Handle bigint serialization
      if (typeof value === "bigint") {
        return this.serializeBigInt(value, col);
      }
    }

    // Handle binary serialization (most drivers accept Buffer)
    if (col.type === "binary" && value instanceof Uint8Array) {
      return Buffer.from(value);
    }

    return value;
  }

  // Abstract methods for dialect-specific serialization
  protected abstract serializeDate(value: Date, col: AnyColumn): Date | number | string;
  protected abstract serializeBoolean(value: boolean): boolean | number;
  protected abstract serializeBigInt(value: bigint, col: AnyColumn): bigint | number | Buffer;
  protected abstract serializeJson(value: unknown): unknown;

  // Abstract methods for dialect-specific deserialization
  protected abstract deserializeDate(value: unknown, col: AnyColumn): Date;
  protected abstract deserializeBoolean(value: unknown): boolean;
  protected abstract deserializeBigInt(value: unknown): bigint;
  protected abstract deserializeJson(value: unknown): unknown;
  protected abstract deserializeBinary(value: unknown): Uint8Array;
  protected abstract deserializeInteger(value: unknown): number;
  protected abstract deserializeDecimal(value: unknown): number;
  protected abstract deserializeString(value: unknown): string;
}
