import { sql, type BinaryOperator } from "kysely";

import type { NamingResolver } from "../../../naming/sql-naming";
import type { Condition } from "../../../query/condition-builder";
import { getDbNowOffsetMs, isDbNow } from "../../../query/db-now";
import {
  createSQLSerializer,
  type SQLSerializer,
} from "../../../query/serialize/create-sql-serializer";
import { ReferenceSubquery, resolveFragnoIdValue } from "../../../query/value-encoding";
import {
  type AnyColumn,
  type AnyTable,
  Column,
  FragnoId,
  FragnoReference,
  getTableForeignKey,
} from "../../../schema/create";
import type { DriverConfig } from "../driver-config";
import type { SQLiteStorageMode } from "../sqlite-storage";
import { buildDbNowSql } from "./db-now-sql";
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

function fullSQLNameWithAlias(
  column: AnyColumn,
  resolver?: NamingResolver,
  table?: AnyTable,
  tableAlias?: string,
): string {
  if (table && tableAlias && column.tableName === table.name) {
    const columnName = resolver
      ? resolver.getColumnName(column.tableName, column.name)
      : column.name;
    return `${tableAlias}.${columnName}`;
  }
  return fullSQLName(column, resolver);
}

function buildReferenceExternalIdSubquery(
  eb: AnyExpressionBuilder,
  table: AnyTable,
  column: AnyColumn,
  externalIds: string | string[],
  resolver?: NamingResolver,
): unknown {
  const foreignKey = getTableForeignKey(table, column.name);
  if (!foreignKey) {
    throw new Error(`Reference column ${column.name} not found in table ${table.name}`);
  }

  const refTable = foreignKey.referencedTable;
  const internalIdColumn = refTable.getInternalIdColumn();
  const idColumn = refTable.getIdColumn();
  const tableName = resolver ? resolver.getTableName(refTable.name) : refTable.name;
  const internalIdColumnName = resolver
    ? resolver.getColumnName(refTable.name, internalIdColumn.name)
    : internalIdColumn.name;
  const idColumnName = resolver
    ? resolver.getColumnName(refTable.name, idColumn.name)
    : idColumn.name;

  const query = eb.selectFrom(tableName).select(internalIdColumnName);
  if (Array.isArray(externalIds)) {
    return query.where(idColumnName, "in", externalIds);
  }
  return query.where(idColumnName, "=", externalIds).limit(1);
}

function getExternalReferenceId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof FragnoId && value.internalId === undefined) {
    return value.externalId;
  }
  return undefined;
}

export function serializeReferenceFilterValue(
  value: unknown,
  column: AnyColumn,
  table: AnyTable,
  eb: AnyExpressionBuilder,
  serializer: SQLSerializer,
  resolver?: NamingResolver,
): unknown {
  const externalId = getExternalReferenceId(value);
  if (externalId !== undefined) {
    return buildReferenceExternalIdSubquery(eb, table, column, externalId, resolver);
  }
  if (value instanceof FragnoId && value.internalId !== undefined) {
    return serializer.serialize(value.internalId, column);
  }
  if (value instanceof FragnoReference) {
    return serializer.serialize(value.internalId, column);
  }
  return serializer.serialize(resolveFragnoIdValue(value, column), column);
}

function constantWhere(eb: AnyExpressionBuilder, value: boolean): AnyExpressionWrapper {
  return value ? eb(sql`1`, "=", sql`1`) : eb(sql`1`, "=", sql`0`);
}

export function buildReferenceArrayWhere({
  values,
  operator,
  column,
  columnSqlName,
  table,
  eb,
  serializer,
  resolver,
}: {
  values: unknown[];
  operator: "in" | "not in";
  column: AnyColumn;
  columnSqlName: string;
  table: AnyTable;
  eb: AnyExpressionBuilder;
  serializer: SQLSerializer;
  resolver?: NamingResolver;
}): AnyExpressionWrapper {
  if (values.length === 0) {
    return constantWhere(eb, operator === "not in");
  }

  const internalValues: unknown[] = [];
  const externalIds: string[] = [];
  for (const value of values) {
    const externalId = getExternalReferenceId(value);
    if (externalId !== undefined) {
      externalIds.push(externalId);
      continue;
    }
    internalValues.push(
      serializeReferenceFilterValue(value, column, table, eb, serializer, resolver),
    );
  }

  const clauses: AnyExpressionWrapper[] = [];
  if (internalValues.length > 0) {
    clauses.push(eb(columnSqlName, operator, internalValues));
  }
  if (externalIds.length > 0) {
    clauses.push(
      eb(
        columnSqlName,
        operator,
        buildReferenceExternalIdSubquery(eb, table, column, externalIds, resolver),
      ),
    );
  }

  if (clauses.length === 1) {
    return clauses[0]!;
  }
  return operator === "in" ? eb.or(clauses) : eb.and(clauses);
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
  tableAlias?: string,
): AnyExpressionWrapper {
  const serializer = createSQLSerializer(driverConfig, sqliteStorageMode);

  if (condition.type === "compare") {
    const left = condition.a;
    const op = condition.operator;
    let val = condition.b;

    if (!(val instanceof Column)) {
      if (isDbNow(val)) {
        val = buildDbNowSql({
          driverConfig,
          columnType: left.type,
          offsetMs: getDbNowOffsetMs(val),
          sqliteStorageMode,
        });
      } else if (left.role === "reference" && table) {
        if ((op === "in" || op === "not in") && Array.isArray(val)) {
          return buildReferenceArrayWhere({
            values: val,
            operator: op,
            column: left,
            columnSqlName: fullSQLNameWithAlias(left, resolver, table, tableAlias),
            table,
            eb,
            serializer,
            resolver,
          });
        }
        val = serializeReferenceFilterValue(val, left, table, eb, serializer, resolver);
      } else {
        val = Array.isArray(val)
          ? val.map((item) => serializer.serialize(resolveFragnoIdValue(item, left), left))
          : serializer.serialize(resolveFragnoIdValue(val, left), left);
      }
    }

    let v: BinaryOperator;
    let rhs: unknown;

    switch (op) {
      case "contains":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))}, '%')`
            : `%${val}%`;
        break;
      case "not contains":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))}, '%')`
            : `%${val}%`;
        break;
      case "starts with":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))}, '%')`
            : `${val}%`;
        break;
      case "not starts with":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))}, '%')`
            : `${val}%`;
        break;
      case "ends with":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))})`
            : `%${val}`;
        break;
      case "not ends with":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))})`
            : `%${val}`;
        break;
      default:
        v = op;
        rhs =
          val instanceof Column
            ? eb.ref(fullSQLNameWithAlias(val, resolver, table, tableAlias))
            : val;
    }

    return eb(fullSQLNameWithAlias(left, resolver, table, tableAlias), v, rhs);
  }

  // Nested conditions
  if (condition.type === "and") {
    return eb.and(
      condition.items.map((v) =>
        buildWhere(v, eb, driverConfig, sqliteStorageMode, resolver, table, tableAlias),
      ),
    );
  }

  if (condition.type === "not") {
    return eb.not(
      buildWhere(condition.item, eb, driverConfig, sqliteStorageMode, resolver, table, tableAlias),
    );
  }

  return eb.or(
    condition.items.map((v) =>
      buildWhere(v, eb, driverConfig, sqliteStorageMode, resolver, table, tableAlias),
    ),
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
