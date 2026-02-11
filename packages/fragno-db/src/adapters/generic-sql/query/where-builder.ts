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
import { isDbNow } from "../../../query/db-now";
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
function resolveDbNowValue(
  left: AnyColumn,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
): unknown {
  if (driverConfig.databaseType === "sqlite") {
    const storageMode = sqliteStorageMode ?? sqliteStorageDefault;
    const storage =
      left.type === "date" ? storageMode.dateStorage : storageMode.timestampStorage;
    if ((left.type === "timestamp" || left.type === "date") && storage === "epoch-ms") {
      return sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`;
    }
  }
  return sql`CURRENT_TIMESTAMP`;
}

function buildReferenceSubquery(
  externalId: unknown,
  left: AnyColumn,
  table: AnyTable,
  eb: AnyExpressionBuilder,
  resolver?: NamingResolver,
): unknown | undefined {
  const relation = Object.values(table.relations).find((rel) =>
    rel.on.some(([localCol]) => localCol === left.name),
  );
  if (!relation) {
    return undefined;
  }

  const refTable = relation.table;
  const internalIdCol = refTable.getInternalIdColumn();
  const idCol = refTable.getIdColumn();
  const physicalTableName = resolver ? resolver.getTableName(refTable.name) : refTable.name;

  return eb
    .selectFrom(physicalTableName)
    .select(
      resolver
        ? resolver.getColumnName(refTable.name, internalIdCol.name)
        : internalIdCol.name,
    )
    .where(
      resolver ? resolver.getColumnName(refTable.name, idCol.name) : idCol.name,
      "=",
      externalId,
    )
    .limit(1);
}

function resolveCompareValue(
  val: unknown,
  left: AnyColumn,
  table: AnyTable | undefined,
  eb: AnyExpressionBuilder,
  driverConfig: DriverConfig,
  sqliteStorageMode: SQLiteStorageMode | undefined,
  resolver: NamingResolver | undefined,
  serializer: ReturnType<typeof createSQLSerializer>,
): unknown {
  if (val instanceof Column) {
    return val;
  }

  if (isDbNow(val)) {
    return resolveDbNowValue(left, driverConfig, sqliteStorageMode);
  }

  if (left.role === "reference" && table) {
    if (typeof val === "string") {
      return buildReferenceSubquery(val, left, table, eb, resolver) ?? val;
    }
    if (val instanceof FragnoId && val.internalId !== undefined) {
      return val.internalId;
    }
    if (val instanceof FragnoId && val.internalId === undefined) {
      return buildReferenceSubquery(val.externalId, left, table, eb, resolver) ?? val;
    }
    if (val instanceof FragnoReference) {
      return val.internalId;
    }
    const resolvedVal = resolveFragnoIdValue(val, left);
    return serializer.serialize(resolvedVal, left);
  }

  const resolvedVal = resolveFragnoIdValue(val, left);
  return serializer.serialize(resolvedVal, left);
}

function mapOperatorToSQL(
  op: string,
  val: unknown,
  eb: AnyExpressionBuilder,
  resolver?: NamingResolver,
): { binaryOp: BinaryOperator; rhs: unknown } {
  switch (op) {
    case "contains":
      return {
        binaryOp: "like",
        rhs:
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `%${val}%`,
      };
    case "not contains":
      return {
        binaryOp: "not like",
        rhs:
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `%${val}%`,
      };
    case "starts with":
      return {
        binaryOp: "like",
        rhs:
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `${val}%`,
      };
    case "not starts with":
      return {
        binaryOp: "not like",
        rhs:
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLName(val, resolver))}, '%')`
            : `${val}%`,
      };
    case "ends with":
      return {
        binaryOp: "like",
        rhs:
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))})`
            : `%${val}`,
      };
    case "not ends with":
      return {
        binaryOp: "not like",
        rhs:
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, resolver))})`
            : `%${val}`,
      };
    default:
      return {
        binaryOp: op as BinaryOperator,
        rhs: val instanceof Column ? eb.ref(fullSQLName(val, resolver)) : val,
      };
  }
}

export function buildWhere(
  condition: Condition,
  eb: AnyExpressionBuilder,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
  table?: AnyTable,
): AnyExpressionWrapper {
  if (condition.type === "compare") {
    const left = condition.a;
    const serializer = createSQLSerializer(driverConfig, sqliteStorageMode);
    const val = resolveCompareValue(
      condition.b,
      left,
      table,
      eb,
      driverConfig,
      sqliteStorageMode,
      resolver,
      serializer,
    );
    const { binaryOp, rhs } = mapOperatorToSQL(condition.operator, val, eb, resolver);
    return eb(fullSQLName(left, resolver), binaryOp, rhs);
  }

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
