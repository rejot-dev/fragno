import type { AnyTable } from "../schema/create";
import { createSQLSerializer } from "./serialize/create-sql-serializer";
import { FragnoId, FragnoReference } from "../schema/create";
import type { DriverConfig } from "../adapters/generic-sql/driver-config";
import type { SQLiteStorageMode } from "../adapters/generic-sql/sqlite-storage";
import type { NamingResolver } from "../naming/sql-naming";

/**
 * Decodes a database result record to application format.
 *
 * This function transforms database column names back to application property names
 * and deserializes values according to the database provider's format (e.g., converting
 * SQLite integers back to JavaScript Date objects).
 *
 * Supports relation data encoded with the pattern `relationName:columnName`.
 *
 * @param result - The raw database result record
 * @param table - The table schema definition containing column and relation information
 * @param driverConfig - The driver configuration containing database type information
 * @param sqliteStorageMode - Optional SQLite storage mode override
 * @returns A record in application format with deserialized values
 *
 * @example
 * ```ts
 * const decoded = decodeResult(
 *   { user_id: 123, created_at: 1234567890, 'posts:title': 'Hello' },
 *   userTable,
 *   driverConfig
 * );
 * // Returns: { userId: 123, createdAt: Date, posts: { title: 'Hello' } }
 * ```
 */
export function decodeResult(
  result: Record<string, unknown>,
  table: AnyTable,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): Record<string, unknown> {
  const serializer = createSQLSerializer(driverConfig, sqliteStorageMode);
  const output: Record<string, unknown> = {};
  // First pass: collect all column values
  const columnValues: Record<string, unknown> = {};
  const columnMap = resolver ? resolver.getColumnNameMap(table) : undefined;

  // Collect all relation data (including nested) keyed by relation name
  const relationData: Record<string, Record<string, unknown>> = {};

  for (const k in result) {
    const colonIndex = k.indexOf(":");
    const value = result[k];

    // Direct column (no colon)
    if (colonIndex === -1) {
      const logicalName = columnMap?.[k] ?? k;
      const col = table.columns[logicalName];
      if (!col) {
        continue;
      }

      // Store all column values (including hidden ones for FragnoId creation)
      columnValues[logicalName] = serializer.deserialize(value, col);
      continue;
    }

    // Relation column (has colon)
    const relationName = k.slice(0, colonIndex);
    const remainder = k.slice(colonIndex + 1);

    const relation = table.relations[relationName];
    if (relation === undefined) {
      continue;
    }

    // Collect relation data with the remaining key path
    relationData[relationName] ??= {};
    relationData[relationName][remainder] = value;
  }

  // Process each relation's data recursively
  for (const relationName in relationData) {
    const relation = table.relations[relationName];
    if (!relation) {
      continue;
    }

    // Recursively decode the relation data
    output[relationName] = decodeResult(
      relationData[relationName],
      relation.table,
      driverConfig,
      sqliteStorageMode,
      resolver,
    );
  }

  // Second pass: create output with FragnoId objects where appropriate
  for (const k in columnValues) {
    const col = table.columns[k];
    if (!col) {
      continue;
    }

    // Filter out hidden columns (like _internalId, _version) from results
    if (col.isHidden) {
      continue;
    }

    // For external ID columns, create FragnoId if we have both external and internal IDs
    if (col.role === "external-id" && columnValues["_internalId"] !== undefined) {
      output[k] = new FragnoId({
        externalId: columnValues[k] as string,
        internalId: columnValues["_internalId"] as bigint,
        // _version is always selected as a hidden column, so it should always be present
        version: columnValues["_version"] as number,
      });
    } else if (col.role === "reference") {
      // For reference columns, create FragnoReference with internal ID
      output[k] = FragnoReference.fromInternal(columnValues[k] as bigint);
    } else {
      output[k] = columnValues[k];
    }
  }

  return output;
}
