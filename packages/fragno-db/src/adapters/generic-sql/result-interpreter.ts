import type { QueryResult } from "../../sql-driver/sql-driver";
import type { DriverConfig } from "./driver-config";

/**
 * Interprets query results from different SQL drivers.
 *
 * Different drivers return affected rows information in different formats.
 * This class uses the driver-specific extraction logic defined in DriverConfig
 * to normalize the affected rows count to a bigint value.
 */
export class ResultInterpreter {
  readonly #driverConfig: DriverConfig;
  constructor(driverConfig: DriverConfig) {
    this.#driverConfig = driverConfig;
  }

  /**
   * Extract the number of affected rows from a query result.
   * Only works for drivers that support affected rows reporting.
   *
   * @param result - The query result from the SQL driver
   * @returns The number of rows affected by the operation as bigint
   * @throws Error if driver doesn't support affected rows or extraction fails
   */
  getAffectedRows(result: QueryResult<unknown>): bigint {
    if (!this.#driverConfig.extractAffectedRows) {
      throw new Error(
        `Driver ${this.#driverConfig.driverType} does not support affected rows reporting.`,
      );
    }

    // QueryResult doesn't have an index signature, but drivers return objects with dynamic properties
    return this.#driverConfig.extractAffectedRows(result as unknown as Record<string, unknown>);
  }

  /**
   * Extract internal ID from INSERT result (RETURNING clause).
   *
   * @param result - The query result from the SQL driver
   * @returns The internal ID as bigint
   * @throws Error if driver doesn't support RETURNING, no rows returned, or column not found
   */
  getCreatedInternalId(result: QueryResult<unknown>): bigint {
    if (!this.#driverConfig.supportsReturning || !this.#driverConfig.internalIdColumn) {
      throw new Error(`Driver ${this.#driverConfig.driverType} does not support RETURNING clause.`);
    }

    if (!Array.isArray(result.rows) || result.rows.length === 0) {
      throw new Error(`No rows returned from INSERT with RETURNING clause.`);
    }

    const row = result.rows[0] as Record<string, unknown>;
    const columnName = this.#driverConfig.internalIdColumn;

    if (!(columnName in row)) {
      throw new Error(`Expected column "${columnName}" not found in RETURNING result.`);
    }

    const rawId = row[columnName];
    return this.#normalizeIntegerId(rawId);
  }

  /**
   * Get count of returned rows as bigint.
   *
   * @param result - The query result from the SQL driver
   * @returns The number of rows returned as bigint
   */
  getReturnedRowCount(result: QueryResult<unknown>): bigint {
    if (!Array.isArray(result.rows)) {
      return BigInt(0);
    }
    return BigInt(result.rows.length);
  }

  /**
   * Normalize integer values to bigint.
   * Handles different driver return types (bigint, number, string).
   *
   * @param value - The value to normalize
   * @returns The normalized bigint value
   * @throws Error if value cannot be converted to bigint
   */
  #normalizeIntegerId(value: unknown): bigint {
    if (value === null || value === undefined) {
      throw new Error(`Cannot normalize null or undefined value to bigint`);
    }
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number") {
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`Cannot normalize NaN or non-finite number to bigint`);
      }
      return BigInt(value);
    }
    if (typeof value === "string") {
      return BigInt(value);
    }
    throw new Error(`Cannot normalize value to bigint: ${typeof value}`);
  }
}
