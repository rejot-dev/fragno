import type { DriverConfig } from "../adapters/generic-sql/driver-config";
import type { SQLiteStorageMode } from "../adapters/generic-sql/sqlite-storage";
import type { NamingResolver } from "../naming/sql-naming";
import type { AnyTable } from "../schema/create";
import { FragnoId, FragnoReference, getTableRelations } from "../schema/create";
import { createSQLSerializer } from "./serialize/create-sql-serializer";
import type { SQLSerializer } from "./serialize/sql-serializer";

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

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
  return decodeResultWithSerializer(
    result,
    table,
    createSQLSerializer(driverConfig, sqliteStorageMode),
    resolver,
    "stored",
  );
}

/** Decodes database JSON projections whose JSON columns are already application values. */
export function decodeJsonProjectedResult(
  result: Record<string, unknown>,
  table: AnyTable,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): Record<string, unknown> {
  return decodeResultWithSerializer(
    result,
    table,
    createSQLSerializer(driverConfig, sqliteStorageMode),
    resolver,
    "projected",
  );
}

function decodeResultWithSerializer(
  result: Record<string, unknown>,
  table: AnyTable,
  serializer: SQLSerializer,
  resolver: NamingResolver | undefined,
  jsonColumnSource: "stored" | "projected",
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const columnValues: Record<string, unknown> = {};
  const columnMap = resolver ? resolver.getColumnNameMap(table) : undefined;
  const relationData: Record<string, Record<string, unknown>> = {};

  for (const k in result) {
    const colonIndex = k.indexOf(":");
    const value = result[k];

    if (colonIndex === -1) {
      const logicalName = columnMap?.[k] ?? k;
      const col = table.columns[logicalName];
      if (!col) {
        continue;
      }

      columnValues[logicalName] =
        jsonColumnSource === "projected" && col.type === "json"
          ? value
          : serializer.deserialize(value, col);
      continue;
    }

    const relationName = k.slice(0, colonIndex);
    const remainder = k.slice(colonIndex + 1);
    const relation = getTableRelations(table)[relationName];
    if (relation === undefined) {
      continue;
    }

    relationData[relationName] ??= {};
    relationData[relationName][remainder] = value;
  }

  for (const relationName in relationData) {
    const relation = getTableRelations(table)[relationName];
    if (!relation) {
      continue;
    }

    const relationRow = relationData[relationName];
    const internalIdKey = relation.table.getInternalIdColumn().name;
    if (
      Object.prototype.hasOwnProperty.call(relationRow, internalIdKey) &&
      isNullish(relationRow[internalIdKey])
    ) {
      output[relationName] = relation.type === "many" ? [] : null;
      continue;
    }

    output[relationName] = decodeResultWithSerializer(
      relationRow,
      relation.table,
      serializer,
      resolver,
      jsonColumnSource,
    );
  }

  for (const k in columnValues) {
    const col = table.columns[k];
    if (!col) {
      continue;
    }

    if (col.isHidden) {
      continue;
    }

    if (col.role === "external-id" && columnValues["_internalId"] !== undefined) {
      output[k] = new FragnoId({
        externalId: columnValues[k] as string,
        internalId: columnValues["_internalId"] as bigint,
        version: columnValues["_version"] as number,
      });
    } else if (col.role === "reference") {
      output[k] = FragnoReference.fromInternal(columnValues[k] as bigint);
    } else {
      output[k] = columnValues[k];
    }
  }

  return output;
}
