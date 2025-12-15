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
}
