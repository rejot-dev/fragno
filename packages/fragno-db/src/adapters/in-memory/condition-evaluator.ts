import type { Condition } from "../../query/condition-builder";
import { ReferenceSubquery, resolveFragnoIdValue } from "../../query/value-encoding";
import { isDbNow } from "../../query/db-now";
import type { AnyColumn, AnyTable } from "../../schema/create";
import { Column, FragnoId, FragnoReference } from "../../schema/create";
import type { InMemoryNamespaceStore, InMemoryRow } from "./store";
import { normalizeIndexValue } from "./store";
import { resolveReferenceSubquery } from "./reference-resolution";
import { compareNormalizedValues } from "./value-comparison";
import type { NamingResolver } from "../../naming/sql-naming";

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

    const relation = Object.values(table.relations).find((rel) =>
      rel.on.some(([localCol]) => localCol === column.name),
    );
    if (!relation) {
      throw new Error(`Missing relation for reference column "${column.name}".`);
    }

    return resolveReferenceSubquery(
      namespaceStore,
      new ReferenceSubquery(relation.table, value),
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

  if (isDbNow(value)) {
    return { value: now(), column };
  }

  if (column.role === "reference") {
    return {
      value: resolveReferenceValue(value, column, table, namespaceStore, resolver),
      column,
    };
  }

  return { value: resolveFragnoIdValue(value, column), column };
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

    const leftText = leftLike.toLowerCase();
    const rightText = rightLike.toLowerCase();
    let matches = false;

    if (op.includes("contains")) {
      matches = leftText.includes(rightText);
    } else if (op.includes("starts with")) {
      matches = leftText.startsWith(rightText);
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
      throw new Error(`Unsupported operator "${op}".`);
  }
};
