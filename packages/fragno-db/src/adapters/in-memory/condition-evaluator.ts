import type { NamingResolver } from "../../naming/sql-naming";
import type { Condition } from "../../query/condition-builder";
import { getDbNowOffsetMs, isDbNow } from "../../query/db-now";
import { ReferenceSubquery, resolveFragnoIdValue } from "../../query/value-encoding";
import type { AnyColumn, AnyTable } from "../../schema/create";
import { Column, FragnoId, FragnoReference, getTableForeignKey } from "../../schema/create";
import { resolveReferenceSubquery } from "./reference-resolution";
import type { InMemoryNamespaceStore, InMemoryRow } from "./store";
import { normalizeIndexValue } from "./store";
import { compareNormalizedValues } from "./value-comparison";

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const resolveReferenceValue = (
  value: unknown,
  column: AnyColumn,
  table: AnyTable,
  namespaceStore?: InMemoryNamespaceStore,
  resolver?: NamingResolver,
): unknown => {
  if (value instanceof FragnoReference) {
    return value.internalId;
  }

  if (value instanceof FragnoId) {
    if (value.internalId !== undefined) {
      return value.internalId;
    }
    return resolveReferenceValue(value.externalId, column, table, namespaceStore, resolver);
  }

  if (value instanceof ReferenceSubquery) {
    if (!namespaceStore) {
      throw new Error("In-memory condition evaluation requires a namespace store.");
    }
    return resolveReferenceSubquery(namespaceStore, value, resolver);
  }

  if (typeof value === "string") {
    if (!namespaceStore) {
      throw new Error("In-memory condition evaluation requires a namespace store.");
    }

    const foreignKey = getTableForeignKey(table, column.name);
    if (!foreignKey) {
      throw new Error(`Missing foreign key for reference column "${column.name}".`);
    }

    return resolveReferenceSubquery(
      namespaceStore,
      new ReferenceSubquery(foreignKey.referencedTable, value),
      resolver,
    );
  }

  return resolveFragnoIdValue(value, column);
};

const resolveComparisonValue = (
  value: unknown,
  column: AnyColumn,
  table: AnyTable,
  row: InMemoryRow,
  namespaceStore?: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): { value: unknown; column: AnyColumn } => {
  if (value instanceof Column) {
    const columnName = resolver ? resolver.getColumnName(table.name, value.name) : value.name;
    return { value: row[columnName], column: value };
  }

  return {
    value: resolveLiteralValue(value, column, table, namespaceStore, resolver, now),
    column,
  };
};

const resolveLiteralValue = (
  value: unknown,
  column: AnyColumn,
  table: AnyTable,
  namespaceStore?: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): unknown => {
  if (isDbNow(value)) {
    const base = now();
    const offsetMs = getDbNowOffsetMs(value);
    return offsetMs === 0 ? base : new Date(base.getTime() + offsetMs);
  }

  if (column.role === "reference") {
    return resolveReferenceValue(value, column, table, namespaceStore, resolver);
  }

  return resolveFragnoIdValue(value, column);
};

/**
 * The leading key values of an index that every row matching `condition` has: the values its
 * top-level `=` comparisons fix, normalized as `evaluateCondition` compares them.
 */
export const indexEqualityPrefix = (
  condition: Condition,
  table: AnyTable,
  indexColumnNames: readonly string[],
  namespaceStore: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): unknown[] => {
  const fixedValues = new Map<string, unknown>();
  const collect = (item: Condition) => {
    if (item.type === "and") {
      item.items.forEach(collect);
      return;
    }
    // A column of another table, such as a join's, says nothing about this table's rows.
    if (
      item.type !== "compare" ||
      item.operator !== "=" ||
      item.b instanceof Column ||
      table.columns[item.a.name] !== item.a
    ) {
      return;
    }
    const value = resolveLiteralValue(item.b, item.a, table, namespaceStore, resolver, now);
    if (isNullish(value)) {
      return;
    }
    const columnName = resolver ? resolver.getColumnName(table.name, item.a.name) : item.a.name;
    fixedValues.set(columnName, normalizeIndexValue(value, item.a));
  };
  collect(condition);

  const prefix: unknown[] = [];
  for (const columnName of indexColumnNames) {
    if (!fixedValues.has(columnName)) {
      break;
    }
    prefix.push(fixedValues.get(columnName));
  }
  return prefix;
};

const normalizeLikeValue = (value: unknown, column: AnyColumn): string | null => {
  const normalized = normalizeIndexValue(value, column);
  if (normalized === null || normalized === undefined) {
    return null;
  }
  if (normalized instanceof Buffer) {
    return normalized.toString("hex");
  }
  return String(normalized);
};

const compareNormalized = (left: unknown, right: unknown): number =>
  compareNormalizedValues(left, right);

export const evaluateCondition = (
  condition: Condition | boolean,
  table: AnyTable,
  row: InMemoryRow,
  namespaceStore?: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): boolean => {
  if (typeof condition === "boolean") {
    return condition;
  }

  switch (condition.type) {
    case "and": {
      for (const item of condition.items) {
        if (!evaluateCondition(item, table, row, namespaceStore, resolver, now)) {
          return false;
        }
      }
      return true;
    }
    case "or": {
      for (const item of condition.items) {
        if (evaluateCondition(item, table, row, namespaceStore, resolver, now)) {
          return true;
        }
      }
      return false;
    }
    case "not":
      return !evaluateCondition(condition.item, table, row, namespaceStore, resolver, now);
    case "compare":
      break;
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const leftColumn = condition.a;
  const leftColumnName = resolver
    ? resolver.getColumnName(table.name, leftColumn.name)
    : leftColumn.name;
  const leftValue = row[leftColumnName];
  const right = resolveComparisonValue(
    condition.b,
    leftColumn,
    table,
    row,
    namespaceStore,
    resolver,
    now,
  );

  const op = condition.operator;
  const rightValue = right.value;

  if (op === "is" || op === "is not") {
    if (isNullish(rightValue)) {
      const matches = isNullish(leftValue);
      return op === "is" ? matches : !matches;
    }

    if (isNullish(leftValue)) {
      return op === "is not";
    }

    const leftNormalized = normalizeIndexValue(leftValue, leftColumn);
    const rightNormalized = normalizeIndexValue(rightValue, right.column);
    const matches = compareNormalized(leftNormalized, rightNormalized) === 0;
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
    let hasNull = false;
    let hasMatch = false;

    for (const item of rightValue) {
      const resolved = resolveComparisonValue(
        item,
        leftColumn,
        table,
        row,
        namespaceStore,
        resolver,
        now,
      );
      if (isNullish(resolved.value)) {
        hasNull = true;
        continue;
      }
      const normalized = normalizeIndexValue(resolved.value, leftColumn);
      if (compareNormalized(leftNormalized, normalized) === 0) {
        hasMatch = true;
        break;
      }
    }

    if (hasMatch) {
      return op === "in";
    }

    if (hasNull) {
      return false;
    }

    return op === "not in";
  }

  if (
    op === "contains" ||
    op === "starts with" ||
    op === "ends with" ||
    op === "not contains" ||
    op === "not starts with" ||
    op === "not ends with"
  ) {
    const leftLike = normalizeLikeValue(leftValue, leftColumn);
    const rightLike = normalizeLikeValue(rightValue, right.column);

    if (leftLike === null || rightLike === null) {
      return false;
    }

    // `contains` and `ends with` compile to LIKE, which SQLite matches ignoring ASCII case;
    // `starts with` compiles to case-sensitive range bounds.
    const leftText = leftLike.toLowerCase();
    const rightText = rightLike.toLowerCase();
    let matches = false;

    if (op.includes("contains")) {
      matches = leftText.includes(rightText);
    } else if (op.includes("starts with")) {
      matches = leftLike.startsWith(rightLike);
    } else {
      matches = leftText.endsWith(rightText);
    }

    if (op.startsWith("not ")) {
      return !matches;
    }
    return matches;
  }

  const leftNormalized = normalizeIndexValue(leftValue, leftColumn);
  const rightNormalized = normalizeIndexValue(rightValue, right.column);
  const comparison = compareNormalized(leftNormalized, rightNormalized);

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
      throw new Error(`Unsupported operator "${String(op)}".`);
  }
};
