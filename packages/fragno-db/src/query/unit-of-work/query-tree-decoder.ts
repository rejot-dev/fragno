import type { DriverConfig } from "../../adapters/generic-sql/driver-config";
import {
  decodeSQLiteJsonBlobValue,
  isSQLiteBlobStoredColumn,
  SQLITE_JSON_BLOB_HEX_PREFIX,
  type SQLiteStorageMode,
} from "../../adapters/generic-sql/sqlite-storage";
import type { NamingResolver } from "../../naming/sql-naming";
import type { AnyColumn, AnyTable } from "../../schema/create";
import { decodeResult } from "../value-decoding";
import type { CompiledQueryTreeChildNode, CompiledQueryTreeRootNode } from "./query-tree";

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const decodeJsonProjectedColumnValue = (
  value: unknown,
  column: AnyColumn,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
): unknown => {
  if (
    driverConfig.databaseType === "sqlite" &&
    isSQLiteBlobStoredColumn(column, sqliteStorageMode) &&
    typeof value === "string" &&
    value.startsWith(SQLITE_JSON_BLOB_HEX_PREFIX)
  ) {
    return decodeSQLiteJsonBlobValue(value);
  }
  return value;
};

const decodeNodeColumns = (
  row: Record<string, unknown>,
  table: AnyTable,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): Record<string, unknown> => {
  const columnOnlyRow: Record<string, unknown> = {};

  for (const key in row) {
    const directColumn = table.columns[key];
    if (directColumn) {
      columnOnlyRow[key] = decodeJsonProjectedColumnValue(
        row[key],
        directColumn,
        driverConfig,
        sqliteStorageMode,
      );
      continue;
    }

    if (resolver) {
      const columnMap = resolver.getColumnNameMap(table);
      const logicalName = columnMap[key];
      const mappedColumn = logicalName ? table.columns[logicalName] : undefined;
      if (mappedColumn) {
        columnOnlyRow[key] = decodeJsonProjectedColumnValue(
          row[key],
          mappedColumn,
          driverConfig,
          sqliteStorageMode,
        );
      }
    }
  }

  return decodeResult(columnOnlyRow, table, driverConfig, sqliteStorageMode, resolver);
};

type MySQLOrderedJoinManyItem = [ordinal: number, row: Record<string, unknown>];

const restoreMySQLJoinManyOrderInPlace = (items: unknown[]): MySQLOrderedJoinManyItem[] => {
  const orderedItems = items as MySQLOrderedJoinManyItem[];

  // JSON_ARRAYAGG normally leaves the ordinals already or nearly ordered. Insertion sort keeps that
  // common case linear, with the remaining work proportional to the number of inversions.
  for (let index = 1; index < orderedItems.length; index++) {
    const current = orderedItems[index];
    let position = index;

    while (position > 0 && orderedItems[position - 1][0] > current[0]) {
      orderedItems[position] = orderedItems[position - 1]!;
      position--;
    }

    orderedItems[position] = current;
  }

  return orderedItems;
};

const decodeChildNode = (
  value: unknown,
  node: CompiledQueryTreeChildNode,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): unknown => {
  if (value === null || value === undefined) {
    return node.cardinality === "many" ? [] : null;
  }

  const parsed = parseJsonValue(value);
  if (node.cardinality === "many") {
    if (!Array.isArray(parsed)) {
      return [];
    }

    const hasMySQLOrderOrdinal =
      driverConfig.databaseType === "mysql" && node.orderByIndex !== undefined;
    const items = hasMySQLOrderOrdinal ? restoreMySQLJoinManyOrderInPlace(parsed) : parsed;

    return items.map((item) =>
      decodeQueryTreeRow(
        (hasMySQLOrderOrdinal ? (item as MySQLOrderedJoinManyItem)[1] : item) as Record<
          string,
          unknown
        >,
        node,
        driverConfig,
        sqliteStorageMode,
        resolver,
      ),
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  return decodeQueryTreeRow(
    parsed as Record<string, unknown>,
    node,
    driverConfig,
    sqliteStorageMode,
    resolver,
  );
};

export const decodeQueryTreeRow = (
  row: Record<string, unknown>,
  node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): Record<string, unknown> => {
  const output = decodeNodeColumns(row, node.table, driverConfig, sqliteStorageMode, resolver);

  for (const child of node.children) {
    output[child.alias] = decodeChildNode(
      row[child.alias],
      child,
      driverConfig,
      sqliteStorageMode,
      resolver,
    );
  }

  return output;
};
