import { sql, type BinaryOperator } from "kysely";

import type { NamingResolver } from "../../../naming/sql-naming";
import type { Condition } from "../../../query/condition-builder";
import { getDbNowOffsetMs, isDbNow } from "../../../query/db-now";
import { createSQLSerializer } from "../../../query/serialize/create-sql-serializer";
import { isParentColumnRef } from "../../../query/unit-of-work/query-tree";
import { resolveFragnoIdValue } from "../../../query/value-encoding";
import type { AnyColumn, AnyTable } from "../../../schema/create";
import { Column } from "../../../schema/create";
import type { DriverConfig } from "../driver-config";
import type { SQLiteStorageMode } from "../sqlite-storage";
import { buildDbNowSql } from "./db-now-sql";
import type { AnyExpressionBuilder, AnyExpressionWrapper } from "./sql-query-compiler";
import {
  buildReferenceArrayWhere,
  fullSQLName,
  serializeReferenceFilterValue,
} from "./where-builder";

function getColumnSqlName(
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

function getComparableColumn(column: AnyColumn, table: AnyTable): AnyColumn {
  if (column.role === "external-id") {
    return table.getInternalIdColumn();
  }
  return column;
}

function getComparableParentColumn(column: AnyColumn, table: AnyTable): AnyColumn {
  if (column.role === "external-id") {
    return table.getInternalIdColumn();
  }
  return column;
}

export function buildQueryTreeWhere(
  condition: Condition,
  eb: AnyExpressionBuilder,
  driverConfig: DriverConfig,
  sqliteStorageMode: SQLiteStorageMode | undefined,
  resolver: NamingResolver | undefined,
  childTable: AnyTable,
  childAlias: string,
  parentTable?: AnyTable,
  parentAlias?: string,
): AnyExpressionWrapper {
  const serializer = createSQLSerializer(driverConfig, sqliteStorageMode);

  if (condition.type === "compare") {
    let left = condition.a;
    let rightValue = condition.b;

    if (isParentColumnRef(rightValue)) {
      if (!parentTable || !parentAlias) {
        throw new Error(
          "Parent column references can only be used inside correlated query-tree joins.",
        );
      }

      let parentColumn = rightValue.column;
      if (left.role === "external-id" && parentColumn.role !== "external-id") {
        left = getComparableColumn(left, childTable);
      }
      if (parentColumn.role === "external-id" && left.role !== "external-id") {
        parentColumn = getComparableParentColumn(parentColumn, parentTable);
      }

      return eb(
        getColumnSqlName(left, resolver, childTable, childAlias),
        condition.operator as BinaryOperator,
        eb.ref(getColumnSqlName(parentColumn, resolver, parentTable, parentAlias)),
      );
    }

    if (!(rightValue instanceof Column)) {
      if (isDbNow(rightValue)) {
        rightValue = buildDbNowSql({
          driverConfig,
          columnType: left.type,
          offsetMs: getDbNowOffsetMs(rightValue),
          sqliteStorageMode,
        });
      } else if (left.role === "reference") {
        if (
          (condition.operator === "in" || condition.operator === "not in") &&
          Array.isArray(rightValue)
        ) {
          return buildReferenceArrayWhere({
            values: rightValue,
            operator: condition.operator,
            column: left,
            columnSqlName: getColumnSqlName(left, resolver, childTable, childAlias),
            table: childTable,
            eb,
            serializer,
            resolver,
          });
        }
        rightValue = serializeReferenceFilterValue(
          rightValue,
          left,
          childTable,
          eb,
          serializer,
          resolver,
        );
      } else {
        rightValue = Array.isArray(rightValue)
          ? rightValue.map((item) => serializer.serialize(resolveFragnoIdValue(item, left), left))
          : serializer.serialize(resolveFragnoIdValue(rightValue, left), left);
      }
    }

    let operator: BinaryOperator;
    let rhs: unknown;

    switch (condition.operator) {
      case "contains":
        operator = "like";
        rhs =
          rightValue instanceof Column
            ? sql`concat('%', ${eb.ref(getColumnSqlName(rightValue, resolver))}, '%')`
            : `%${rightValue}%`;
        break;
      case "not contains":
        operator = "not like";
        rhs =
          rightValue instanceof Column
            ? sql`concat('%', ${eb.ref(getColumnSqlName(rightValue, resolver))}, '%')`
            : `%${rightValue}%`;
        break;
      case "starts with":
        operator = "like";
        rhs =
          rightValue instanceof Column
            ? sql`concat(${eb.ref(getColumnSqlName(rightValue, resolver))}, '%')`
            : `${rightValue}%`;
        break;
      case "not starts with":
        operator = "not like";
        rhs =
          rightValue instanceof Column
            ? sql`concat(${eb.ref(getColumnSqlName(rightValue, resolver))}, '%')`
            : `${rightValue}%`;
        break;
      case "ends with":
        operator = "like";
        rhs =
          rightValue instanceof Column
            ? sql`concat('%', ${eb.ref(getColumnSqlName(rightValue, resolver))})`
            : `%${rightValue}`;
        break;
      case "not ends with":
        operator = "not like";
        rhs =
          rightValue instanceof Column
            ? sql`concat('%', ${eb.ref(getColumnSqlName(rightValue, resolver))})`
            : `%${rightValue}`;
        break;
      default:
        operator = condition.operator as BinaryOperator;
        rhs =
          rightValue instanceof Column
            ? eb.ref(getColumnSqlName(rightValue, resolver))
            : rightValue;
    }

    return eb(getColumnSqlName(left, resolver, childTable, childAlias), operator, rhs);
  }

  if (condition.type === "and") {
    return eb.and(
      condition.items.map((item) =>
        buildQueryTreeWhere(
          item,
          eb,
          driverConfig,
          sqliteStorageMode,
          resolver,
          childTable,
          childAlias,
          parentTable,
          parentAlias,
        ),
      ),
    );
  }

  if (condition.type === "not") {
    return eb.not(
      buildQueryTreeWhere(
        condition.item,
        eb,
        driverConfig,
        sqliteStorageMode,
        resolver,
        childTable,
        childAlias,
        parentTable,
        parentAlias,
      ),
    );
  }

  return eb.or(
    condition.items.map((item) =>
      buildQueryTreeWhere(
        item,
        eb,
        driverConfig,
        sqliteStorageMode,
        resolver,
        childTable,
        childAlias,
        parentTable,
        parentAlias,
      ),
    ),
  );
}
