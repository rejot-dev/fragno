import type { AnyTable, AnyColumn } from "../../schema/create";
import type { DriverConfig } from "./driver-config";
import { serialize } from "../../schema/type-conversion/serialize";
import { encodeValues } from "../../query/value-encoding";
import { processReferenceSubqueries } from "./query/where-builder";
import type { TableNameMapper } from "../shared/table-name-mapper";
import type { Kysely } from "kysely";

/**
 * Encoder class for Unit of Work mutation operations.
 *
 * Handles the complete transformation from application values to database-ready values
 * in three clear steps:
 * 1. Resolution - Resolve FragnoId/FragnoReference objects and generate defaults
 * 2. Reference Processing - Create subqueries for external ID lookups
 * 3. Serialization - Apply database-specific type conversions
 *
 * This class mirrors the UnitOfWorkDecoder pattern for symmetry.
 */
export class UnitOfWorkEncoder {
  readonly #driverConfig: DriverConfig;
  readonly #db: Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly #mapper?: TableNameMapper;

  constructor(
    driverConfig: DriverConfig,
    db: Kysely<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    mapper?: TableNameMapper,
  ) {
    this.#driverConfig = driverConfig;
    this.#db = db;
    this.#mapper = mapper;
  }

  /**
   * Encode application values to database-ready format.
   *
   * This is the main entry point that handles all encoding steps:
   * 1. **Resolution**: Transform ORM names to DB columns, resolve FragnoId/FragnoReference,
   *    generate defaults (CUIDs for IDs, etc.)
   * 2. **Reference Processing**: Convert external ID strings to subqueries for internal ID lookup
   * 3. **Serialization**: Apply database-specific conversions (Date → number for SQLite, etc.)
   *
   * @param options - Encoding options
   * @param options.values - Application values to encode
   * @param options.table - Table schema definition
   * @param options.generateDefaults - Whether to generate default values for undefined columns
   * @returns Database-ready values
   *
   * @example
   * ```ts
   * const encoded = encoder.encodeForDatabase({
   *   values: { userId: FragnoId(...), createdAt: new Date(), isActive: true },
   *   table: usersTable,
   *   generateDefaults: true
   * });
   * // For SQLite: { user_id: 456, created_at: 1705316400000, is_active: 1 }
   * ```
   */
  encodeForDatabase(options: {
    values: Record<string, unknown>;
    table: AnyTable;
    generateDefaults: boolean;
  }): Record<string, unknown> {
    // Step 1: Resolution - Resolve FragnoId/FragnoReference and generate defaults
    const resolved = encodeValues(options.values, options.table, options.generateDefaults);

    // Step 2: Reference Processing - Convert external IDs to subqueries
    const processed = processReferenceSubqueries(resolved, this.#db, this.#mapper);

    // Step 3: Serialization - Apply database-specific type conversions
    const serialized = this.serializeValues(processed, options.table);

    return serialized;
  }

  /**
   * Serialize resolved values to database format.
   *
   * Applies database-specific type conversions:
   * - SQLite: Date → number, boolean → 0/1, bigint → Buffer (or Number for reference columns)
   * - PostgreSQL: Mostly pass-through (database handles types natively)
   * - MySQL: Mostly pass-through
   *
   * @param values - Resolved values (after resolution and reference processing)
   * @param table - The table schema definition
   * @returns Serialized values ready for database driver
   */
  private serializeValues(
    values: Record<string, unknown>,
    table: AnyTable,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [dbColumnName, value] of Object.entries(values)) {
      // Find the column definition by database column name
      const col = this.findColumnByDbName(table, dbColumnName);

      if (!col) {
        // Not a regular column (might be a special value like sql.raw())
        // Pass through as-is
        result[dbColumnName] = value;
        continue;
      }

      // Serialize the value using the column definition and database type
      result[dbColumnName] = serialize(value, col, this.#driverConfig.databaseType);
    }

    return result;
  }

  /**
   * Find a column definition by its database column name.
   *
   * @param table - The table to search
   * @param dbColumnName - The database column name (e.g., "user_id")
   * @returns The column definition or undefined if not found
   */
  private findColumnByDbName(table: AnyTable, dbColumnName: string): AnyColumn | undefined {
    for (const col of Object.values(table.columns)) {
      if (col.name === dbColumnName) {
        return col;
      }
    }
    return undefined;
  }
}
