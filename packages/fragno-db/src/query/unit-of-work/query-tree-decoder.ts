import type { DriverConfig } from "../../adapters/generic-sql/driver-config";
import type { SQLiteStorageMode } from "../../adapters/generic-sql/sqlite-storage";
import type { NamingResolver } from "../../naming/sql-naming";
import type { AnyTable } from "../../schema/create";
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

const decodeNodeColumns = (
  row: Record<string, unknown>,
  table: AnyTable,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): Record<string, unknown> => {
  const columnOnlyRow: Record<string, unknown> = {};

  for (const key in row) {
    if (table.columns[key] || key in table.columns) {
      columnOnlyRow[key] = row[key];
      continue;
    }

    if (resolver) {
      const columnMap = resolver.getColumnNameMap(table);
      const logicalName = columnMap[key];
      if (logicalName && table.columns[logicalName]) {
        columnOnlyRow[key] = row[key];
      }
    }
  }

  return decodeResult(columnOnlyRow, table, driverConfig, sqliteStorageMode, resolver);
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

    return parsed.map((item) =>
      decodeQueryTreeRow(
        item as Record<string, unknown>,
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
