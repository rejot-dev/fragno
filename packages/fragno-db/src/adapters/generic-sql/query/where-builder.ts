import { sql, type BinaryOperator } from "kysely";
import {
  type AnyColumn,
  type AnyTable,
  Column,
  FragnoId,
  FragnoReference,
} from "../../../schema/create";
import type { Condition } from "../../../query/condition-builder";
import { createSQLSerializer } from "../../../query/serialize/create-sql-serializer";
import type { NamingResolver } from "../../../naming/sql-naming";
import type { DriverConfig } from "../driver-config";
import { sqliteStorageDefault, type SQLiteStorageMode } from "../sqlite-storage";
import { ReferenceSubquery, resolveFragnoIdValue } from "../../../query/value-encoding";
import { getDbNowOffsetMs, isDbNow } from "../../../query/db-now";
import type { AnyKysely, AnyExpressionBuilder, AnyExpressionWrapper } from "./sql-query-compiler";

/**
 * Returns the fully qualified SQL name for a column (table.column).
 *
 * @param column - The column to get the full name for
 * @param resolver - Optional naming resolver for namespace prefixing
 * @returns The fully qualified SQL name in the format "tableName.columnName"
 * @internal
 */
export function fullSQLName(column: AnyColumn, resolver?: NamingResolver): string {
  const tableName = resolver ? resolver.getTableName(column.tableName) : column.tableName;
  const columnName = resolver ? resolver.getColumnName(column.tableName, column.name) : column.name;
  return `${tableName}.${columnName}`;
}

/**
 * Builds a WHERE clause expression from a Condition tree.
 *
 * Recursively processes condition objects to build Kysely WHERE expressions.
 * Handles comparison operators, logical AND/OR/NOT, and special string operators
 * like "contains", "starts with", and "ends with".
 *
 * @param condition - The condition tree to build the WHERE clause from
 * @param eb - Kysely expression builder for constructing SQL expressions
 * @param database - The database type (affects SQL generation)
 * @param resolver - Optional naming resolver for namespace prefixing
 * @param table - The table being queried (used for resolving reference columns)
 * @returns A Kysely expression wrapper representing the WHERE clause
 * @internal
 */
export function buildWhere(
  condition: Condition,
  eb: AnyExpressionBuilder,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
  table?: AnyTable,
): AnyExpressionWrapper {
  const serializer = createSQLSerializer(driverConfig, sqliteStorageMode);

  if (condition.type === "compare") {
    const left = condition.a;
    const op = condition.operator;
    let val = condition.b;

    if (!(val instanceof Column)) {
      if (isDbNow(val)) {
        const offsetMs = getDbNowOffsetMs(val);
        if (driverConfig.databaseType === "sqlite") {
          const storageMode = sqliteStorageMode ?? sqliteStorageDefault;
          const storage =
            left.type === "date" ? storageMode.dateStorage : storageMode.timestampStorage;
          if ((left.type === "timestamp" || left.type === "date") && storage === "epoch-ms") {
            const base = sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`;
            val = offsetMs === 0 ? base : sql`${base} + ${offsetMs}`;
          } else if (offsetMs === 0) {
            val = sql`CURRENT_TIMESTAMP`;
          } else {
            const seconds = offsetMs / 1000;
            const modifier = `${seconds >= 0 ? "+" : ""}${seconds} seconds`;
            val = sql`datetime('now', ${modifier})`;
          }
        } else if (driverConfig.databaseType === "mysql") {
          if (offsetMs === 0) {
            val = sql`CURRENT_TIMESTAMP`;
          } else {
            const micros = Math.trunc(offsetMs * 1000);
            val = sql`TIMESTAMPADD(MICROSECOND, ${micros}, CURRENT_TIMESTAMP)`;
          }
        } else {
          if (offsetMs === 0) {
            val = sql`CURRENT_TIMESTAMP`;
          } else {
            val = sql`(CURRENT_TIMESTAMP + (${offsetMs} * interval '1 millisecond'))`;
          }
        }
      } else if (left.role === "reference" && table) {
        // Handle reference columns specially
        if (typeof val === "string") {
          // String external ID - create subquery to lookup internal ID
          const relation = Object.values(table.relations).find((rel) =>
            rel.on.some(([localCol]) => localCol === left.name),
          );
          if (relation) {
            const refTable = relation.table;
            const internalIdCol = refTable.getInternalIdColumn();
            const idCol = refTable.getIdColumn();
            const physicalTableName = resolver
              ? resolver.getTableName(refTable.name)
              : refTable.name;

            val = eb
              .selectFrom(physicalTableName)
              .select(
                resolver
                  ? resolver.getColumnName(refTable.name, internalIdCol.name)
                  : internalIdCol.name,
              )
              .where(
                resolver ? resolver.getColumnName(refTable.name, idCol.name) : idCol.name,
                "=",
                val,
              )
              .limit(1);
          }
        } else if (val instanceof FragnoId && val.internalId !== undefined) {
          // FragnoId with internal ID - use it directly (no serialization needed)
          val = val.internalId;
        } else if (val instanceof FragnoId && val.internalId === undefined) {
          // FragnoId without internal ID - create subquery using external ID
          const relation = Object.values(table.relations).find((rel) =>
            rel.on.some(([localCol]) => localCol === left.name),
          );
          if (relation) {
            const refTable = relation.table;
            const internalIdCol = refTable.getInternalIdColumn();
            const idCol = refTable.getIdColumn();
            const physicalTableName = resolver
              ? resolver.getTableName(refTable.name)
              : refTable.name;

            val = eb
              .selectFrom(physicalTableName)
              .select(
                resolver
                  ? resolver.getColumnName(refTable.name, internalIdCol.name)
                  : internalIdCol.name,
              )
              .where(
                resolver ? resolver.getColumnName(refTable.name, idCol.name) : idCol.name,
                "=",
                val.externalId,
              )
              .limit(1);
          }
        } else if (val instanceof FragnoReference) {
          // FragnoReference - use internal ID directly (no serialization needed)
          val = val.internalId;
        } else {
          // Other values - resolve and serialize
          const resolvedVal = resolveFragnoIdValue(val, left);
          val = serializer.serialize(resolvedVal, left);
        }
      } else {
        // Non-reference columns - resolve FragnoId/FragnoReference and serialize
        const resolvedVal = resolveFragnoIdValue(val, left);
        val = serializer.serialize(resolvedVal, left);
      }
    }

    let v: BinaryOperator;
    let rhs: unknown;

    switch (op) {
      case "contains":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `%${val}%`;
        break;
      case "not contains":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `%${val}%`;
        break;
      case "starts with":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `${val}%`;
        break;
      case "not starts with":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `${val}%`;
        break;
      case "ends with":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))})`
            : `%${val}`;
        break;
      case "not ends with":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))})`
            : `%${val}`;
        break;
      default:
        v = op;
        rhs = val instanceof Column ? eb.ref(fullSQLName(val, resolver)) : val;
    }

    return eb(fullSQLName(left, resolver), v, rhs);
  }

  // Nested conditions
  if (condition.type === "and") {
    return eb.and(
      condition.items.map((v) =>
        buildWhere(v, eb, driverConfig, sqliteStorageMode, resolver, table),
      ),
    );
  }

  if (condition.type === "not") {
    return eb.not(buildWhere(condition.item, eb, driverConfig, sqliteStorageMode, resolver, table));
  }

  return eb.or(
    condition.items.map((v) => buildWhere(v, eb, driverConfig, sqliteStorageMode, resolver, table)),
  );
}

/**
 * Process reference subqueries in encoded values, converting them to Kysely SQL subqueries
 *
 * @param values - The encoded values that may contain ReferenceSubquery objects
 * @param kysely - The Kysely database instance for building subqueries
 * @param resolver - Optional naming resolver for namespace prefixing
 * @returns Processed values with subqueries in place of ReferenceSubquery markers
 * @internal
 */
export function processReferenceSubqueries(
  values: Record<string, unknown>,
  kysely: AnyKysely,
  resolver?: NamingResolver,
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};
  const getTableName = (table: AnyTable) =>
    resolver ? resolver.getTableName(table.name) : table.name;

  for (const [key, value] of Object.entries(values)) {
    if (value instanceof ReferenceSubquery) {
      const refTable = value.referencedTable;
      const externalId = value.externalIdValue;
      const tableName = getTableName(refTable);
      const internalIdCol = refTable.getInternalIdColumn().name;
      const idCol = refTable.getIdColumn().name;
      const internalIdColumnName = resolver
        ? resolver.getColumnName(refTable.name, internalIdCol)
        : internalIdCol;
      const idColumnName = resolver ? resolver.getColumnName(refTable.name, idCol) : idCol;

      processed[key] = kysely
        .selectFrom(tableName)
        .select(internalIdColumnName)
        .where(idColumnName, "=", externalId)
        .limit(1);
    } else {
      processed[key] = value;
    }
  }

  return processed;
}
