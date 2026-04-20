import type { CursorResult } from "@fragno-dev/db/cursor";
import { Cursor, createCursorFromRecord, decodeCursor } from "@fragno-dev/db/cursor";
import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import { isParentColumnRef, type CompiledQueryTreeChildNode } from "@fragno-dev/db/unit-of-work";

import type { Condition } from "../../query/conditions";
import { normalizeValue } from "../../query/normalize";
import {
  buildReadPlan,
  lofiExecuteReadPlan,
  type LofiExecutableQueryInterface,
  type LofiReadPlan,
} from "../../query/read-plan";
import type { LofiQueryInterface, LofiQueryableAdapter } from "../../types";
import type { InMemoryLofiAdapter } from "../in-memory/adapter";
import type { InMemoryLofiRow } from "../in-memory/store";
import { compareNormalizedValues } from "../in-memory/value-comparison";

type CompiledJoin = {
  alias: string;
  table: AnyTable;
  parentTable: AnyTable;
  cardinality: "one" | "many";
  on?: Condition;
  options: {
    select: unknown;
    where?: Condition;
    orderBy?: [AnyColumn, "asc" | "desc"][];
    join?: CompiledJoin[];
    limit?: number;
  };
};

const buildOrderColumns = (table: AnyTable, indexName: string): AnyColumn[] => {
  if (indexName === "_primary") {
    return [table.getIdColumn()];
  }

  const index = table.indexes[indexName];
  const columns = index ? [...index.columns] : [table.getIdColumn()];
  const idColumn = table.getIdColumn();
  if (!columns.some((col) => col.name === idColumn.name)) {
    columns.push(idColumn);
  }
  return columns;
};

const coerceLocalInternalId = (value: unknown): number | null => {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  return null;
};

const resolveOrderValue = (value: unknown, column: AnyColumn): unknown => {
  if (column.role === "external-id") {
    if (
      value &&
      typeof value === "object" &&
      "externalId" in value &&
      typeof (value as { externalId?: unknown }).externalId === "string"
    ) {
      return (value as { externalId: string }).externalId;
    }
    return value;
  }

  if (column.role === "internal-id" || column.role === "reference") {
    if (value instanceof FragnoReference) {
      return coerceLocalInternalId(value.internalId);
    }
    if (value instanceof FragnoId) {
      return coerceLocalInternalId(value.internalId);
    }
    if (typeof value === "string") {
      return value;
    }
    return coerceLocalInternalId(value);
  }

  return normalizeValue(value, column);
};

const compareRows = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  orderColumns: AnyColumn[],
  direction: "asc" | "desc",
): number => {
  for (const column of orderColumns) {
    const leftValue = resolveOrderValue(left[column.name], column);
    const rightValue = resolveOrderValue(right[column.name], column);
    const comparison = compareNormalizedValues(leftValue, rightValue);
    if (comparison !== 0) {
      return direction === "asc" ? comparison : -comparison;
    }
  }
  return 0;
};

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const toByteArray = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

const bytesToHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

const getRowValueWithOverlay = (
  row: Record<string, unknown>,
  columnName: string,
  overlayData: Record<string, unknown> | undefined,
): unknown => {
  if (overlayData && columnName in overlayData) {
    return overlayData[columnName];
  }
  return row[columnName];
};

const isConditionColumn = (value: unknown): value is AnyColumn =>
  !!value && typeof value === "object" && "name" in value && "role" in value && "type" in value;

const normalizeConditionValue = (value: unknown, column: AnyColumn): unknown => {
  if (isNullish(value)) {
    return value;
  }

  if (column.role === "external-id") {
    if (value instanceof FragnoId) {
      return value.externalId;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "externalId" in value &&
      typeof (value as { externalId?: unknown }).externalId === "string"
    ) {
      return (value as { externalId: string }).externalId;
    }
    return value;
  }

  if (column.role === "reference" || column.role === "internal-id") {
    if (value instanceof FragnoReference) {
      return coerceLocalInternalId(value.internalId);
    }
    if (value instanceof FragnoId) {
      return coerceLocalInternalId(value.internalId);
    }
    if (typeof value === "object" && value !== null && "internalId" in value) {
      return coerceLocalInternalId((value as { internalId?: unknown }).internalId);
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return coerceLocalInternalId(value);
    }
    if (typeof value === "string") {
      return value;
    }
  }

  return normalizeValue(value, column);
};

const normalizeLikeValue = (value: unknown, column: AnyColumn): string | null => {
  const normalized =
    column.role === "reference" || column.role === "internal-id"
      ? coerceLocalInternalId(value)
      : normalizeConditionValue(value, column);
  if (normalized === null || normalized === undefined) {
    return null;
  }
  const bytes = toByteArray(normalized);
  if (bytes) {
    return bytesToHex(bytes);
  }
  return String(normalized);
};

const resolveConditionValue = (options: {
  value: unknown;
  column: AnyColumn;
  row: Record<string, unknown>;
}): { value: unknown; column: AnyColumn } => {
  const { value, column, row } = options;

  if (isConditionColumn(value)) {
    return { value: row[value.name], column: value };
  }

  return { value, column };
};

const evaluateCondition = (
  condition: Condition | boolean,
  row: Record<string, unknown>,
): boolean => {
  if (typeof condition === "boolean") {
    return condition;
  }

  switch (condition.type) {
    case "and":
      return condition.items.every((item) => evaluateCondition(item, row));
    case "or":
      return condition.items.some((item) => evaluateCondition(item, row));
    case "not":
      return !evaluateCondition(condition.item, row);
    case "compare":
      break;
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const leftColumn = condition.a;
  const leftValue = normalizeConditionValue(row[leftColumn.name], leftColumn);
  const right = resolveConditionValue({ value: condition.b, column: leftColumn, row });
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

    const rightNormalized = normalizeConditionValue(rightValue, right.column);
    const matches = compareNormalizedValues(leftValue, rightNormalized) === 0;
    return op === "is" ? matches : !matches;
  }

  if (op === "in" || op === "not in") {
    const values = Array.isArray(rightValue) ? rightValue : [];
    let hasNull = false;
    let hasMatch = false;

    for (const entry of values) {
      if (isNullish(entry)) {
        hasNull = true;
        continue;
      }
      const normalized = normalizeConditionValue(entry, leftColumn);
      if (compareNormalizedValues(leftValue, normalized) === 0) {
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

  const rightNormalized = normalizeConditionValue(rightValue, right.column);
  const comparison = compareNormalizedValues(leftValue, rightNormalized);

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

const orderJoinRows = (
  rows: Record<string, unknown>[],
  orderBy: [AnyColumn, "asc" | "desc"][] | undefined,
): Record<string, unknown>[] => {
  if (!orderBy || orderBy.length === 0) {
    return rows;
  }

  return rows.slice().sort((left, right) => {
    for (const [column, direction] of orderBy) {
      const leftValue = resolveOrderValue(left[column.name], column);
      const rightValue = resolveOrderValue(right[column.name], column);
      const comparison = compareNormalizedValues(leftValue, rightValue);
      if (comparison !== 0) {
        return direction === "asc" ? comparison : -comparison;
      }
    }
    return 0;
  });
};

const resolveComparableColumn = (column: AnyColumn, table: AnyTable): AnyColumn =>
  column.role === "external-id" ? table.getInternalIdColumn() : column;

const resolveCorrelatedConditionValue = (options: {
  value: unknown;
  column: AnyColumn;
  row: Record<string, unknown>;
  currentTable: AnyTable;
  parentRow: Record<string, unknown>;
  parentTable: AnyTable;
  parentOverlayData?: Record<string, unknown>;
}): { value: unknown; column: AnyColumn } => {
  const { value, column, row, parentRow, parentOverlayData } = options;

  if (isParentColumnRef(value)) {
    return {
      value: getRowValueWithOverlay(parentRow, value.column.name, parentOverlayData),
      column: value.column,
    };
  }

  if (isConditionColumn(value)) {
    return { value: row[value.name], column: value };
  }

  return { value, column };
};

const evaluateCorrelatedCondition = (options: {
  condition: Condition | undefined;
  row: Record<string, unknown>;
  currentTable: AnyTable;
  parentRow: Record<string, unknown>;
  parentTable: AnyTable;
  parentOverlayData?: Record<string, unknown>;
}): boolean => {
  const { condition, row, currentTable, parentRow, parentTable, parentOverlayData } = options;
  if (!condition) {
    return true;
  }

  switch (condition.type) {
    case "and":
      return condition.items.every((item) =>
        evaluateCorrelatedCondition({
          condition: item,
          row,
          currentTable,
          parentRow,
          parentTable,
          parentOverlayData,
        }),
      );
    case "or":
      return condition.items.some((item) =>
        evaluateCorrelatedCondition({
          condition: item,
          row,
          currentTable,
          parentRow,
          parentTable,
          parentOverlayData,
        }),
      );
    case "not":
      return !evaluateCorrelatedCondition({
        condition: condition.item,
        row,
        currentTable,
        parentRow,
        parentTable,
        parentOverlayData,
      });
    case "compare":
      break;
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const leftSourceColumn = condition.a;
  let leftColumn = leftSourceColumn;
  let rightColumn = leftSourceColumn;
  const right = resolveCorrelatedConditionValue({
    value: condition.b,
    column: leftColumn,
    row,
    currentTable,
    parentRow,
    parentTable,
    parentOverlayData,
  });
  const rightValue = right.value;

  if (isParentColumnRef(condition.b)) {
    const rawLeftValue = row[leftSourceColumn.name];
    if (
      leftColumn.role === "external-id" &&
      right.column.role !== "external-id" &&
      typeof rightValue !== "string"
    ) {
      leftColumn = resolveComparableColumn(leftColumn, currentTable);
    }
    if (
      right.column.role === "external-id" &&
      leftColumn.role !== "external-id" &&
      typeof rawLeftValue !== "string"
    ) {
      rightColumn = resolveComparableColumn(right.column, parentTable);
    } else {
      rightColumn = right.column;
    }
  }

  const leftValue = normalizeConditionValue(row[leftSourceColumn.name], leftColumn);

  if (condition.operator === "is" || condition.operator === "is not") {
    if (isNullish(rightValue)) {
      const matches = isNullish(leftValue);
      return condition.operator === "is" ? matches : !matches;
    }
    if (isNullish(leftValue)) {
      return condition.operator === "is not";
    }
    const rightNormalized = normalizeConditionValue(rightValue, rightColumn);
    const matches = compareNormalizedValues(leftValue, rightNormalized) === 0;
    return condition.operator === "is" ? matches : !matches;
  }

  if (condition.operator === "in" || condition.operator === "not in") {
    const values = Array.isArray(rightValue) ? rightValue : [];
    let hasNull = false;
    let hasMatch = false;

    for (const entry of values) {
      if (isNullish(entry)) {
        hasNull = true;
        continue;
      }
      const normalized = normalizeConditionValue(entry, leftColumn);
      if (compareNormalizedValues(leftValue, normalized) === 0) {
        hasMatch = true;
        break;
      }
    }

    if (hasMatch) {
      return condition.operator === "in";
    }
    if (hasNull) {
      return false;
    }
    return condition.operator === "not in";
  }

  if (
    condition.operator === "contains" ||
    condition.operator === "starts with" ||
    condition.operator === "ends with" ||
    condition.operator === "not contains" ||
    condition.operator === "not starts with" ||
    condition.operator === "not ends with"
  ) {
    const leftLike = normalizeLikeValue(leftValue, leftColumn);
    const rightLike = normalizeLikeValue(rightValue, rightColumn);

    if (leftLike === null || rightLike === null) {
      return false;
    }

    const leftText = leftLike.toLowerCase();
    const rightText = rightLike.toLowerCase();
    let matches = false;

    if (condition.operator.includes("contains")) {
      matches = leftText.includes(rightText);
    } else if (condition.operator.includes("starts with")) {
      matches = leftText.startsWith(rightText);
    } else {
      matches = leftText.endsWith(rightText);
    }

    return condition.operator.startsWith("not ") ? !matches : matches;
  }

  const rightNormalized = normalizeConditionValue(rightValue, rightColumn);
  const comparison = compareNormalizedValues(leftValue, rightNormalized);

  switch (condition.operator) {
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
      throw new Error(`Unsupported operator "${condition.operator}".`);
  }
};

const matchesJoinOn = (options: {
  parentRow: Record<string, unknown>;
  targetRow: Record<string, unknown>;
  join: CompiledJoin;
  overlay: InMemoryLofiAdapter;
  schemaName: string;
}): boolean => {
  const { parentRow, targetRow, join, overlay, schemaName } = options;
  const parentExternalId = getExternalIdFromRow(parentRow, join.parentTable);
  const overlayParent = parentExternalId
    ? overlay.store.getRow(schemaName, join.parentTable.name, parentExternalId)
    : undefined;

  return evaluateCorrelatedCondition({
    condition: join.on,
    row: targetRow,
    currentTable: join.table,
    parentRow,
    parentTable: join.parentTable,
    parentOverlayData: overlayParent?.data,
  });
};

const buildCursorValues = (
  cursor: Cursor | string | undefined,
  columns: AnyColumn[],
): readonly unknown[] | undefined => {
  if (!cursor) {
    return undefined;
  }

  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
  return columns.map((column) => resolveOrderValue(cursorObj.indexValues[column.name], column));
};

const compareRowToCursor = (
  row: Record<string, unknown>,
  orderColumns: AnyColumn[],
  cursorValues: readonly unknown[],
): number => {
  for (let i = 0; i < orderColumns.length; i += 1) {
    const column = orderColumns[i]!;
    const rowValue = resolveOrderValue(row[column.name], column);
    const cursorValue = cursorValues[i];
    const comparison = compareNormalizedValues(rowValue, cursorValue);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
};

const applyCursorFilters = (options: {
  rows: Record<string, unknown>[];
  orderColumns: AnyColumn[];
  direction: "asc" | "desc";
  after?: Cursor | string;
  before?: Cursor | string;
}): Record<string, unknown>[] => {
  const { rows, orderColumns, direction, after, before } = options;
  const afterValues = buildCursorValues(after, orderColumns);
  const beforeValues = buildCursorValues(before, orderColumns);

  return rows.filter((row) => {
    if (afterValues) {
      const comparison = compareRowToCursor(row, orderColumns, afterValues);
      if (direction === "asc" ? comparison <= 0 : comparison >= 0) {
        return false;
      }
    }

    if (beforeValues) {
      const comparison = compareRowToCursor(row, orderColumns, beforeValues);
      if (direction === "asc" ? comparison >= 0 : comparison <= 0) {
        return false;
      }
    }

    return true;
  });
};

const getExternalIdFromRow = (row: Record<string, unknown>, table: AnyTable): string | null => {
  const idColumn = table.getIdColumn();
  const value = row[idColumn.name];
  if (value == null) {
    return null;
  }
  if (value instanceof FragnoId) {
    return value.externalId;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && "externalId" in value) {
    const ext = (value as { externalId?: unknown }).externalId;
    if (typeof ext === "string") {
      return ext;
    }
  }
  return null;
};

const buildOutputFromLofiRow = (
  row: InMemoryLofiRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  const columnNames = select && select !== true ? select : (Object.keys(table.columns) as string[]);

  for (const columnName of columnNames) {
    const column = table.columns[columnName];
    if (!column || column.isHidden) {
      continue;
    }

    if (column.role === "external-id") {
      output[column.name] = new FragnoId({
        externalId: row.id,
        internalId: BigInt(row._lofi.internalId),
        version: row._lofi.version,
      });
      continue;
    }

    if (column.role === "reference") {
      const value = row._lofi.norm[column.name];
      if (value === null || value === undefined) {
        const rawValue = row.data[column.name];
        output[column.name] = rawValue ?? null;
      } else {
        output[column.name] = FragnoReference.fromInternal(BigInt(value as number));
      }
      continue;
    }

    if (column.role === "internal-id") {
      output[column.name] = BigInt(row._lofi.internalId);
      continue;
    }

    if (column.role === "version") {
      output[column.name] = row._lofi.version;
      continue;
    }

    output[column.name] = row.data[column.name];
  }

  return output;
};

const mergeRowColumns = (
  baseRow: Record<string, unknown>,
  overlayRow: Record<string, unknown>,
  table: AnyTable,
  select: undefined | true | readonly string[],
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...baseRow };
  const columnNames = select && select !== true ? select : (Object.keys(table.columns) as string[]);

  for (const columnName of columnNames) {
    if (!table.columns[columnName]) {
      continue;
    }
    if (columnName in overlayRow) {
      merged[columnName] = overlayRow[columnName];
    }
  }

  return merged;
};

const patchJoinRows = async <TSchema extends AnySchema>(options: {
  row: Record<string, unknown>;
  joins: CompiledJoin[] | undefined;
  overlay: InMemoryLofiAdapter;
  baseQuery: LofiQueryInterface<TSchema>;
  schemaName: string;
  baseRowsCache: Map<string, Record<string, unknown>[]>;
}): Promise<void> => {
  const { row, joins, overlay, baseQuery, schemaName, baseRowsCache } = options;
  if (!joins || joins.length === 0) {
    return;
  }

  for (const join of joins) {
    const joinOptions = join.options;
    const relationName = join.alias;
    let target = row[relationName];

    if (target !== undefined && target !== null) {
      const canCheck = (targetRow: Record<string, unknown>) => {
        if (!join.on) {
          return true;
        }

        const stack: Condition[] = [join.on];
        while (stack.length > 0) {
          const next = stack.pop();
          if (!next) {
            continue;
          }
          if (next.type === "compare") {
            if (!(next.a.name in targetRow)) {
              return false;
            }
            continue;
          }
          if (next.type === "not") {
            stack.push(next.item);
            continue;
          }
          stack.push(...next.items);
        }
        return true;
      };

      const needsRefresh = Array.isArray(target)
        ? target.some(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              canCheck(entry as Record<string, unknown>) &&
              !matchesJoinOn({
                parentRow: row,
                targetRow: entry as Record<string, unknown>,
                join,
                overlay,
                schemaName,
              }),
          )
        : typeof target === "object" &&
          canCheck(target as Record<string, unknown>) &&
          !matchesJoinOn({
            parentRow: row,
            targetRow: target as Record<string, unknown>,
            join,
            overlay,
            schemaName,
          });

      if (needsRefresh) {
        delete row[relationName];
        target = undefined;
      }
    }

    if (target === undefined || target === null || (Array.isArray(target) && target.length === 0)) {
      const baseMatches = await loadBaseJoinMatches({
        parentRow: row,
        join,
        overlay,
        baseQuery,
        schemaName,
        baseRowsCache,
      });
      if (baseMatches.length > 0) {
        target = join.cardinality === "many" ? baseMatches : baseMatches[0];
        row[relationName] = target;
      }
    }

    if (target === undefined || target === null) {
      continue;
    }

    const patchTarget = async (
      targetRow: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null> => {
      const targetTable = join.table;
      const externalId = getExternalIdFromRow(targetRow, targetTable);
      if (!externalId) {
        await patchJoinRows({
          row: targetRow,
          joins: joinOptions.join,
          overlay,
          baseQuery,
          schemaName,
          baseRowsCache,
        });
        return targetRow;
      }

      if (overlay.store.hasTombstone(schemaName, targetTable.name, externalId)) {
        return null;
      }

      let mergedTarget = targetRow;
      const overlayRow = overlay.store.getRow(schemaName, targetTable.name, externalId);
      if (overlayRow) {
        const overlayOutput = buildOutputFromLofiRow(
          overlayRow,
          targetTable,
          joinOptions.select as undefined | true | readonly string[],
        );
        mergedTarget = mergeRowColumns(
          targetRow,
          overlayOutput,
          targetTable,
          joinOptions.select as undefined | true | readonly string[],
        );
      }

      await patchJoinRows({
        row: mergedTarget,
        joins: joinOptions.join,
        overlay,
        baseQuery,
        schemaName,
        baseRowsCache,
      });

      return mergedTarget;
    };

    if (Array.isArray(target)) {
      const next: Record<string, unknown>[] = [];
      for (const entry of target) {
        if (entry && typeof entry === "object") {
          const patched = await patchTarget(entry as Record<string, unknown>);
          if (patched) {
            next.push(patched);
          }
        }
      }
      row[relationName] = next;
      continue;
    }

    if (typeof target === "object") {
      const patched = await patchTarget(target as Record<string, unknown>);
      if (!patched) {
        delete row[relationName];
      } else {
        row[relationName] = patched;
      }
    }
  }
};

async function loadBaseJoinMatches<TSchema extends AnySchema>(options: {
  parentRow: Record<string, unknown>;
  join: CompiledJoin;
  overlay: InMemoryLofiAdapter;
  baseQuery: LofiQueryInterface<TSchema>;
  schemaName: string;
  baseRowsCache: Map<string, Record<string, unknown>[]>;
}): Promise<Record<string, unknown>[]> {
  const { parentRow, join, overlay, baseQuery, schemaName, baseRowsCache } = options;

  const joinOptions = join.options;
  const targetTable = join.table;
  let baseRows = baseRowsCache.get(targetTable.name);
  if (!baseRows) {
    baseRows = (await baseQuery.find(targetTable.name, (b) => b.whereIndex("primary"))) as Record<
      string,
      unknown
    >[];
    baseRowsCache.set(targetTable.name, baseRows);
  }

  const matches: Record<string, unknown>[] = [];
  const matchedIds = new Set<string>();

  const addMatch = (candidate: Record<string, unknown>) => {
    const externalId = getExternalIdFromRow(candidate, targetTable);
    if (externalId) {
      if (matchedIds.has(externalId)) {
        return;
      }
      matchedIds.add(externalId);
    }
    matches.push(candidate);
  };

  for (const baseRow of baseRows) {
    if (!matchesJoinOn({ parentRow, targetRow: baseRow, join, overlay, schemaName })) {
      continue;
    }
    if (joinOptions.where && !evaluateCondition(joinOptions.where as Condition, baseRow)) {
      continue;
    }
    addMatch({ ...baseRow });
  }

  for (const overlayRow of overlay.store.getTableRows(schemaName, targetTable.name)) {
    if (overlay.store.hasTombstone(schemaName, targetTable.name, overlayRow.id)) {
      continue;
    }

    const candidate = buildOutputFromLofiRow(overlayRow, targetTable, true);
    if (!matchesJoinOn({ parentRow, targetRow: candidate, join, overlay, schemaName })) {
      continue;
    }
    if (joinOptions.where && !evaluateCondition(joinOptions.where as Condition, candidate)) {
      continue;
    }
    addMatch(candidate);
  }

  let ordered = orderJoinRows(matches, joinOptions.orderBy);
  if (joinOptions.limit !== undefined) {
    ordered = ordered.slice(0, Math.max(0, joinOptions.limit));
  }

  for (const row of ordered) {
    await patchJoinRows({
      row,
      joins: joinOptions.join,
      overlay,
      baseQuery,
      schemaName,
      baseRowsCache,
    });
  }

  if (joinOptions.select && joinOptions.select !== true) {
    return ordered.map((row) =>
      stripSelection({
        row,
        table: targetTable,
        select: joinOptions.select as undefined | true | readonly string[],
        joins: joinOptions.join,
      }),
    );
  }

  if (joinOptions.join && joinOptions.join.length > 0) {
    return ordered.map((row) =>
      stripSelection({
        row,
        table: targetTable,
        select: joinOptions.select as undefined | true | readonly string[],
        joins: joinOptions.join,
      }),
    );
  }

  return ordered;
}

const stripSelection = (options: {
  row: Record<string, unknown>;
  table: AnyTable;
  select: undefined | true | readonly string[];
  joins: CompiledJoin[] | undefined;
}): Record<string, unknown> => {
  const { row, table, select, joins } = options;
  const stripped: Record<string, unknown> = { ...row };

  if (select && select !== true) {
    const keep = new Set(select);
    for (const key of Object.keys(stripped)) {
      if (table.columns[key] && !keep.has(key)) {
        delete stripped[key];
      }
    }
  }

  if (joins) {
    for (const join of joins) {
      const joinOptions = join.options;
      const relationName = join.alias;
      const child = stripped[relationName];
      if (!child) {
        continue;
      }
      if (Array.isArray(child)) {
        stripped[relationName] = child.map((entry) =>
          stripSelection({
            row: entry as Record<string, unknown>,
            table: join.table,
            select: joinOptions.select as undefined | true | readonly string[],
            joins: joinOptions.join,
          }),
        );
      } else if (typeof child === "object") {
        stripped[relationName] = stripSelection({
          row: child as Record<string, unknown>,
          table: join.table,
          select: joinOptions.select as undefined | true | readonly string[],
          joins: joinOptions.join,
        });
      }
    }
  }

  return stripped;
};

const augmentSelect = (options: {
  table: AnyTable;
  select: undefined | true | readonly string[];
  orderColumns: AnyColumn[];
}): undefined | true | readonly string[] => {
  const { table, select, orderColumns } = options;
  if (!select || select === true) {
    return select;
  }

  const augmented = new Set(select);
  augmented.add(table.getIdColumn().name);
  for (const column of orderColumns) {
    augmented.add(column.name);
  }

  const result = Array.from(augmented);
  return result.length === select.length ? select : result;
};

const compileJoins = (
  parentTable: AnyTable,
  children: CompiledQueryTreeChildNode[],
): CompiledJoin[] =>
  children.map((child) => ({
    alias: child.alias,
    table: child.table,
    parentTable,
    cardinality: child.cardinality,
    on: child.onIndex,
    options: {
      select: child.select,
      where: child.where,
      orderBy: child.orderByIndex
        ? buildOrderColumns(child.table, child.orderByIndex.indexName).map(
            (column) => [column, child.orderByIndex!.direction] as [AnyColumn, "asc" | "desc"],
          )
        : undefined,
      join: compileJoins(child.table, child.children),
      limit: child.pageSize,
    },
  }));

const normalizeIndexName = (indexName: string): "primary" | string =>
  indexName === "_primary" ? "primary" : indexName;

const mergeRows = (options: {
  baseRows: Record<string, unknown>[];
  overlayRows: Record<string, unknown>[];
  overlay: InMemoryLofiAdapter;
  schemaName: string;
  table: AnyTable;
  select: undefined | true | readonly string[];
}): Record<string, unknown>[] => {
  const { baseRows, overlayRows, overlay, schemaName, table, select } = options;
  const baseIds = new Set<string>();
  const merged: Record<string, unknown>[] = [];

  const overlayOutputById = new Map<string, Record<string, unknown>>();

  for (const baseRow of baseRows) {
    const externalId = getExternalIdFromRow(baseRow, table);
    if (!externalId) {
      continue;
    }
    baseIds.add(externalId);

    if (overlay.store.hasTombstone(schemaName, table.name, externalId)) {
      continue;
    }

    const overlayRow = overlay.store.getRow(schemaName, table.name, externalId);
    if (overlayRow) {
      let overlayOutput = overlayOutputById.get(externalId);
      if (!overlayOutput) {
        overlayOutput = buildOutputFromLofiRow(overlayRow, table, select);
        overlayOutputById.set(externalId, overlayOutput);
      }
      merged.push(mergeRowColumns(baseRow, overlayOutput, table, select));
      continue;
    }

    merged.push(baseRow);
  }

  for (const overlayRow of overlayRows) {
    const externalId = getExternalIdFromRow(overlayRow, table);
    if (!externalId || baseIds.has(externalId)) {
      continue;
    }
    if (overlay.store.hasTombstone(schemaName, table.name, externalId)) {
      continue;
    }
    merged.push(overlayRow);
  }

  return merged;
};

type StackedFindBuilder = {
  whereIndex(
    indexName: string,
    condition?: (builder: unknown) => Condition | boolean,
  ): StackedFindBuilder;
  select(columns: readonly string[]): StackedFindBuilder;
  orderByIndex(indexName: string, direction: "asc" | "desc"): StackedFindBuilder;
  after(cursor: Cursor | string): StackedFindBuilder;
  before(cursor: Cursor | string): StackedFindBuilder;
  pageSize(size: number): StackedFindBuilder;
};

type StackedFindBuilderFn = (builder: StackedFindBuilder) => unknown;

export const createStackedQueryEngine = <T extends AnySchema>(options: {
  schema: T;
  base: LofiQueryableAdapter;
  overlay: InMemoryLofiAdapter;
  schemaName?: string;
}): LofiQueryInterface<T> => {
  const schemaName = options.schemaName ?? options.schema.name;
  const baseQuery = options.base.createQueryEngine(options.schema, { schemaName });
  const overlayQuery = options.overlay.createQueryEngine(options.schema, { schemaName });

  const runFind = async (
    query: LofiQueryInterface<T>,
    tableName: keyof T["tables"] & string,
    builder: StackedFindBuilderFn,
  ): Promise<Record<string, unknown>[] | number> =>
    (await query.find(tableName, builder)) as Record<string, unknown>[] | number;

  const runFindWithCursor = async (
    query: LofiQueryInterface<T>,
    tableName: keyof T["tables"] & string,
    builder: StackedFindBuilderFn,
  ): Promise<CursorResult<Record<string, unknown>>> =>
    (await query.findWithCursor(tableName, builder)) as CursorResult<Record<string, unknown>>;

  const buildRootBuilder =
    (
      plan: LofiReadPlan,
      selectOverride?: undefined | true | readonly string[],
    ): StackedFindBuilderFn =>
    (builder) => {
      const useIndex = normalizeIndexName(plan.queryTree.useIndex);
      if (plan.queryTree.where) {
        builder.whereIndex(useIndex, () => plan.queryTree.where as Condition);
      } else {
        builder.whereIndex(useIndex);
      }

      if (plan.kind === "find") {
        const select =
          selectOverride ?? (plan.queryTree.select as undefined | true | readonly string[]);
        if (select && select !== true) {
          builder.select(select as readonly string[]);
        }
        if (plan.queryTree.orderByIndex) {
          builder.orderByIndex(
            normalizeIndexName(plan.queryTree.orderByIndex.indexName),
            plan.queryTree.orderByIndex.direction,
          );
        }
        if (plan.queryTree.after) {
          builder.after(plan.queryTree.after);
        }
        if (plan.queryTree.before) {
          builder.before(plan.queryTree.before);
        }
        if (plan.queryTree.pageSize !== undefined) {
          builder.pageSize(plan.queryTree.pageSize);
        }
      }

      return builder;
    };

  const runPlan = async (
    plan: LofiReadPlan,
  ): Promise<
    | Record<string, unknown>
    | Record<string, unknown>[]
    | CursorResult<Record<string, unknown>>
    | number
    | null
  > => {
    const table = plan.table;
    const tableName = table.name as keyof T["tables"] & string;

    if (plan.kind === "count") {
      const rowBuilder = buildRootBuilder(plan);
      const baseRows = (await runFind(baseQuery, tableName, rowBuilder)) as Record<
        string,
        unknown
      >[];
      const overlayRows = (await runFind(overlayQuery, tableName, rowBuilder)) as Record<
        string,
        unknown
      >[];

      const merged = mergeRows({
        baseRows,
        overlayRows,
        overlay: options.overlay,
        schemaName,
        table,
        select: undefined,
      });

      return merged.length;
    }

    const joins = compileJoins(table, plan.queryTree.children);
    const orderIndexName = plan.queryTree.orderByIndex?.indexName ?? plan.queryTree.useIndex;
    const direction = plan.queryTree.orderByIndex?.direction ?? "asc";
    const orderColumns = buildOrderColumns(table, orderIndexName);
    const originalSelect = plan.queryTree.select as undefined | true | readonly string[];
    const select = augmentSelect({ table, select: originalSelect, orderColumns });

    const overlayRows = (await runFind(
      overlayQuery,
      tableName,
      buildRootBuilder(plan, select),
    )) as Record<string, unknown>[];

    const baseRows: Record<string, unknown>[] = [];
    let mergedRows: Record<string, unknown>[] = [];
    let hasNextBase = false;
    let cursor: Cursor | undefined;

    const pageSize = plan.queryTree.pageSize;
    if (pageSize === undefined) {
      baseRows.push(
        ...((await runFind(baseQuery, tableName, buildRootBuilder(plan, select))) as Record<
          string,
          unknown
        >[]),
      );
    } else {
      let nextAfter: Cursor | string | undefined = plan.queryTree.after;
      let nextBefore: Cursor | string | undefined = plan.queryTree.before;
      let firstPage = true;

      while (true) {
        const pageBuilder: StackedFindBuilderFn = (builder) => {
          buildRootBuilder(plan, select)(builder);
          builder.pageSize(pageSize);
          if (firstPage) {
            if (nextAfter) {
              builder.after(nextAfter);
            }
            if (nextBefore) {
              builder.before(nextBefore);
            }
          } else if (cursor) {
            builder.after(cursor);
          }
          return builder;
        };

        const page = await runFindWithCursor(baseQuery, tableName, pageBuilder);
        baseRows.push(...page.items);
        hasNextBase = page.hasNextPage;
        cursor = page.cursor;
        nextAfter = undefined;
        nextBefore = undefined;
        firstPage = false;

        mergedRows = mergeRows({
          baseRows,
          overlayRows,
          overlay: options.overlay,
          schemaName,
          table,
          select,
        });

        mergedRows = mergedRows.sort((left, right) =>
          compareRows(left, right, orderColumns, direction),
        );
        mergedRows = applyCursorFilters({
          rows: mergedRows,
          orderColumns,
          direction,
          after: plan.queryTree.after,
          before: plan.queryTree.before,
        });

        if (!pageSize || mergedRows.length > pageSize || !hasNextBase) {
          break;
        }
      }
    }

    if (pageSize === undefined || baseRows.length > 0) {
      mergedRows = mergeRows({
        baseRows,
        overlayRows,
        overlay: options.overlay,
        schemaName,
        table,
        select,
      });
    }

    mergedRows = mergedRows.sort((left, right) =>
      compareRows(left, right, orderColumns, direction),
    );
    mergedRows = applyCursorFilters({
      rows: mergedRows,
      orderColumns,
      direction,
      after: plan.queryTree.after,
      before: plan.queryTree.before,
    });

    const baseRowsCache = new Map<string, Record<string, unknown>[]>();
    for (const row of mergedRows) {
      await patchJoinRows({
        row,
        joins,
        overlay: options.overlay,
        baseQuery,
        schemaName,
        baseRowsCache,
      });
    }

    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((row) =>
        stripSelection({
          row,
          table,
          select: originalSelect,
          joins,
        }),
      );

    if (plan.resultMode === "find") {
      const limited =
        pageSize !== undefined ? mergedRows.slice(0, Math.max(0, pageSize)) : mergedRows;
      return strip(limited);
    }

    if (plan.resultMode === "findFirst") {
      const limited =
        pageSize !== undefined ? mergedRows.slice(0, Math.max(0, pageSize)) : mergedRows;
      return strip(limited)[0] ?? null;
    }

    let hasNextPage = false;
    let items = mergedRows;
    if (pageSize && mergedRows.length > pageSize) {
      hasNextPage = true;
      items = mergedRows.slice(0, pageSize);
    }

    let nextCursor: Cursor | undefined;
    const lastRow = items[items.length - 1];
    if (lastRow && pageSize) {
      nextCursor = createCursorFromRecord(lastRow, orderColumns, {
        indexName: orderIndexName,
        orderDirection: direction,
        pageSize,
      });
    }

    return {
      items: strip(items),
      cursor: nextCursor,
      hasNextPage,
    };
  };

  const queryEngine = {
    [lofiExecuteReadPlan]: runPlan,

    async find(tableName, builderFn) {
      const plan = buildReadPlan({
        schema: options.schema,
        tableName,
        builderFn,
        resultMode: "find",
      });
      return (await runPlan(plan)) as Record<string, unknown>[] | number;
    },

    async findWithCursor(tableName, builderFn) {
      const plan = buildReadPlan({
        schema: options.schema,
        tableName,
        builderFn,
        resultMode: "findWithCursor",
      });
      return (await runPlan(plan)) as CursorResult<Record<string, unknown>>;
    },

    async findFirst(tableName, builderFn) {
      const plan = buildReadPlan({
        schema: options.schema,
        tableName,
        builderFn,
        resultMode: "findFirst",
      });
      return (await runPlan(plan)) as Record<string, unknown> | number | null;
    },
  } as LofiExecutableQueryInterface<T>;

  return queryEngine;
};
