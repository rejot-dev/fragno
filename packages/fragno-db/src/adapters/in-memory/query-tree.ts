import type { NamingResolver } from "../../naming/sql-naming";
import type { Condition } from "../../query/condition-builder";
import { getDbNowOffsetMs, isDbNow } from "../../query/db-now";
import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
} from "../../query/unit-of-work/query-tree";
import {
  getQueryTreeSelectedColumnNames,
  isParentColumnRef,
} from "../../query/unit-of-work/query-tree";
import { resolveFragnoIdValue } from "../../query/value-encoding";
import type { AnyColumn, AnyTable } from "../../schema/create";
import { Column, FragnoId, FragnoReference } from "../../schema/create";
import type { InMemoryNamespaceStore, InMemoryRow, InMemoryTableStore } from "./store";
import { normalizeIndexValue } from "./store";
import { compareNormalizedValues } from "./value-comparison";

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const getPhysicalColumnName = (table: AnyTable, columnName: string, resolver?: NamingResolver) =>
  resolver ? resolver.getColumnName(table.name, columnName) : columnName;

const getTableStore = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
  resolver?: NamingResolver,
): InMemoryTableStore => {
  const physicalTableName = resolver ? resolver.getTableName(table.name) : table.name;
  const tableStore = namespaceStore.tables.get(physicalTableName);
  if (!tableStore) {
    throw new Error(`Missing in-memory table store for "${physicalTableName}".`);
  }
  return tableStore;
};

const selectNodeRow = (
  row: InMemoryRow,
  table: AnyTable,
  select: true | readonly string[],
  resolver?: NamingResolver,
  extraColumnNames: readonly string[] = [],
): InMemoryRow => {
  const selected: InMemoryRow = {};

  for (const columnName of getQueryTreeSelectedColumnNames(table, select, extraColumnNames)) {
    const physical = getPhysicalColumnName(table, columnName, resolver);
    if (Object.prototype.hasOwnProperty.call(row, physical)) {
      selected[columnName] = row[physical];
    }
  }

  return selected;
};

const resolveComparableColumn = (column: AnyColumn, table: AnyTable) =>
  column.role === "external-id" ? table.getInternalIdColumn() : column;

const resolveComparisonValue = (
  value: unknown,
  column: AnyColumn,
  currentTable: AnyTable,
  currentRow: InMemoryRow,
  parentTable: AnyTable | undefined,
  parentRow: InMemoryRow | undefined,
  now: () => Date,
  resolver?: NamingResolver,
): { value: unknown; column: AnyColumn } => {
  if (isParentColumnRef(value)) {
    if (!parentTable || !parentRow) {
      throw new Error("Parent column references can only be evaluated for child query-tree nodes.");
    }

    let leftColumn = column;
    let parentColumn = value.column;

    if (leftColumn.role === "external-id" && parentColumn.role !== "external-id") {
      leftColumn = resolveComparableColumn(leftColumn, currentTable);
    }
    if (parentColumn.role === "external-id" && leftColumn.role !== "external-id") {
      parentColumn = resolveComparableColumn(parentColumn, parentTable);
    }

    const parentColumnName = getPhysicalColumnName(parentTable, parentColumn.name, resolver);
    return {
      value: parentRow[parentColumnName],
      column: parentColumn,
    };
  }

  if (value instanceof Column) {
    const columnName = getPhysicalColumnName(currentTable, value.name, resolver);
    return { value: currentRow[columnName], column: value };
  }

  if (isDbNow(value)) {
    const base = now();
    const offsetMs = getDbNowOffsetMs(value);
    return {
      value: offsetMs === 0 ? base : new Date(base.getTime() + offsetMs),
      column,
    };
  }

  if (value instanceof FragnoReference) {
    return { value: value.internalId, column };
  }

  if (value instanceof FragnoId) {
    if (column.role === "reference" || column.role === "internal-id") {
      return { value: value.internalId, column };
    }
    return { value: value.externalId, column };
  }

  return { value: resolveFragnoIdValue(value, column), column };
};

export const evaluateQueryTreeCondition = (
  condition: Condition | undefined,
  currentTable: AnyTable,
  currentRow: InMemoryRow,
  parentTable: AnyTable | undefined,
  parentRow: InMemoryRow | undefined,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): boolean => {
  if (!condition) {
    return true;
  }

  switch (condition.type) {
    case "and":
      return condition.items.every((item) =>
        evaluateQueryTreeCondition(
          item,
          currentTable,
          currentRow,
          parentTable,
          parentRow,
          resolver,
          now,
        ),
      );
    case "or":
      return condition.items.some((item) =>
        evaluateQueryTreeCondition(
          item,
          currentTable,
          currentRow,
          parentTable,
          parentRow,
          resolver,
          now,
        ),
      );
    case "not":
      return !evaluateQueryTreeCondition(
        condition.item,
        currentTable,
        currentRow,
        parentTable,
        parentRow,
        resolver,
        now,
      );
    case "compare":
      break;
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  let leftColumn = condition.a;
  let rightColumn = condition.a;
  const right = resolveComparisonValue(
    condition.b,
    leftColumn,
    currentTable,
    currentRow,
    parentTable,
    parentRow,
    now,
    resolver,
  );

  if (isParentColumnRef(condition.b)) {
    if (leftColumn.role === "external-id" && right.column.role !== "external-id") {
      leftColumn = resolveComparableColumn(leftColumn, currentTable);
    }
    if (right.column.role === "external-id" && leftColumn.role !== "external-id" && parentTable) {
      rightColumn = resolveComparableColumn(right.column, parentTable);
    } else {
      rightColumn = right.column;
    }
  }

  const leftColumnName = getPhysicalColumnName(currentTable, leftColumn.name, resolver);
  const leftValue = currentRow[leftColumnName];
  const rightValue = right.value;
  const op = condition.operator;

  if (op === "is" || op === "is not") {
    if (isNullish(rightValue)) {
      const matches = isNullish(leftValue);
      return op === "is" ? matches : !matches;
    }

    if (isNullish(leftValue)) {
      return op === "is not";
    }

    const leftNormalized = normalizeIndexValue(leftValue, leftColumn);
    const rightNormalized = normalizeIndexValue(rightValue, rightColumn);
    const matches = compareNormalizedValues(leftNormalized, rightNormalized) === 0;
    return op === "is" ? matches : !matches;
  }

  if (isNullish(leftValue) || isNullish(rightValue)) {
    return false;
  }

  if (op === "in" || op === "not in") {
    if (!Array.isArray(rightValue)) {
      throw new Error(`Operator "${op}" expects an array value.`);
    }

    const leftNormalized = normalizeIndexValue(leftValue, leftColumn);
    const matches = rightValue.some((item) => {
      if (isNullish(item)) {
        return false;
      }
      return compareNormalizedValues(leftNormalized, normalizeIndexValue(item, leftColumn)) === 0;
    });

    return op === "in" ? matches : !matches;
  }

  if (
    op === "contains" ||
    op === "starts with" ||
    op === "ends with" ||
    op === "not contains" ||
    op === "not starts with" ||
    op === "not ends with"
  ) {
    const leftText = String(normalizeIndexValue(leftValue, leftColumn) ?? "").toLowerCase();
    const rightText = String(normalizeIndexValue(rightValue, rightColumn) ?? "").toLowerCase();

    let matches = false;
    if (op.includes("contains")) {
      matches = leftText.includes(rightText);
    } else if (op.includes("starts with")) {
      matches = leftText.startsWith(rightText);
    } else {
      matches = leftText.endsWith(rightText);
    }

    return op.startsWith("not ") ? !matches : matches;
  }

  const leftNormalized = normalizeIndexValue(leftValue, leftColumn);
  const rightNormalized = normalizeIndexValue(rightValue, rightColumn);
  const comparison = compareNormalizedValues(leftNormalized, rightNormalized);

  switch (op) {
    case "=":
      return comparison === 0;
    case "!=":
      return comparison !== 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    default:
      throw new Error(`Unsupported operator ${op}`);
  }
};

const resolveOrderByColumns = (table: AnyTable, indexName: string): AnyColumn[] => {
  if (indexName === "_primary") {
    return [table.getIdColumn()];
  }

  const index = table.indexes[indexName];
  if (!index) {
    throw new Error(`Index "${indexName}" not found on table "${table.name}".`);
  }

  return index.columns;
};

const orderRows = (
  rows: InMemoryRow[],
  table: AnyTable,
  orderByIndex: { indexName: string; direction: "asc" | "desc" } | undefined,
  resolver?: NamingResolver,
): InMemoryRow[] => {
  if (!orderByIndex) {
    return rows;
  }

  const columns = resolveOrderByColumns(table, orderByIndex.indexName);
  return rows.slice().sort((left, right) => {
    for (const column of columns) {
      const columnName = getPhysicalColumnName(table, column.name, resolver);
      const leftValue = normalizeIndexValue(left[columnName], column);
      const rightValue = normalizeIndexValue(right[columnName], column);
      const comparison = compareNormalizedValues(leftValue, rightValue);
      if (comparison !== 0) {
        return orderByIndex.direction === "asc" ? comparison : -comparison;
      }
    }
    return 0;
  });
};

const buildChildRawValue = (
  child: CompiledQueryTreeChildNode,
  parentTable: AnyTable,
  parentRow: InMemoryRow,
  namespaceStore: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
  readTracking = false,
): unknown => {
  const childStore = getTableStore(namespaceStore, child.table, resolver);
  const matchingRows: InMemoryRow[] = [];

  for (const row of childStore.rows.values()) {
    if (
      !evaluateQueryTreeCondition(
        child.onIndex,
        child.table,
        row,
        parentTable,
        parentRow,
        resolver,
        now,
      )
    ) {
      continue;
    }

    if (
      !evaluateQueryTreeCondition(
        child.where,
        child.table,
        row,
        undefined,
        undefined,
        resolver,
        now,
      )
    ) {
      continue;
    }

    matchingRows.push(row);
  }

  const ordered = orderRows(matchingRows, child.table, child.orderByIndex, resolver);
  const limited = child.pageSize !== undefined ? ordered.slice(0, child.pageSize) : ordered;
  const items = limited.map((row) =>
    buildQueryTreeRowRaw(child, row, namespaceStore, resolver, now, readTracking),
  );

  if (child.cardinality === "one") {
    return items[0] ?? null;
  }

  return items;
};

export const buildQueryTreeRowRaw = (
  node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
  row: InMemoryRow,
  namespaceStore: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
  readTracking = false,
): InMemoryRow => {
  const output = selectNodeRow(
    row,
    node.table,
    node.select,
    resolver,
    readTracking ? [node.table.getIdColumn().name] : [],
  );

  for (const child of node.children) {
    output[child.alias] = buildChildRawValue(
      child,
      node.table,
      row,
      namespaceStore,
      resolver,
      now,
      readTracking,
    );
  }

  return output;
};

export const executeQueryTreeRoot = (
  root: CompiledQueryTreeRootNode,
  tableStore: InMemoryTableStore,
  namespaceStore: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
  readTracking = false,
): InMemoryRow[] => {
  const matches: InMemoryRow[] = [];

  for (const row of tableStore.rows.values()) {
    if (
      !evaluateQueryTreeCondition(root.where, root.table, row, undefined, undefined, resolver, now)
    ) {
      continue;
    }
    matches.push(row);
  }

  const ordered = orderRows(matches, root.table, root.orderByIndex, resolver);
  const limited = root.pageSize !== undefined ? ordered.slice(0, root.pageSize) : ordered;

  return limited.map((row) =>
    buildQueryTreeRowRaw(root, row, namespaceStore, resolver, now, readTracking),
  );
};
