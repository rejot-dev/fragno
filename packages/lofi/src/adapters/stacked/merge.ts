import type { AnyColumn, AnyRelation, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import type { CursorResult } from "@fragno-dev/db/cursor";
import { Cursor, createCursorFromRecord, decodeCursor } from "@fragno-dev/db/cursor";
import { FindBuilder } from "@fragno-dev/db/unit-of-work";
import type { LofiQueryInterface, LofiQueryableAdapter } from "../../types";
import type { Condition } from "../../query/conditions";
import { normalizeValue } from "../../query/normalize";
import { compareNormalizedValues } from "../in-memory/value-comparison";
import type { InMemoryLofiAdapter } from "../in-memory/adapter";
import type { InMemoryLofiRow } from "../in-memory/store";

type CompiledJoin = {
  relation: AnyRelation;
  options:
    | {
        select: unknown;
        where?: unknown;
        orderBy?: [AnyColumn, "asc" | "desc"][];
        join?: CompiledJoin[];
        limit?: number;
      }
    | false;
};

type BuiltFindOptions = {
  useIndex: string;
  select?: unknown;
  where?: unknown;
  orderByIndex?: {
    indexName: string;
    direction: "asc" | "desc";
  };
  after?: Cursor | string;
  before?: Cursor | string;
  pageSize?: number;
  joins?: CompiledJoin[];
};

const buildFindBuilder = <TTable extends AnyTable>(tableName: string, table: TTable) =>
  new FindBuilder<TTable>(tableName, table);

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

type JoinCandidates = {
  internal: unknown[];
  external: unknown[];
  normalized: unknown[];
};

const collectJoinCandidates = (value: unknown, column: AnyColumn): JoinCandidates => {
  const candidates: JoinCandidates = { internal: [], external: [], normalized: [] };
  if (isNullish(value)) {
    return candidates;
  }

  const pushInternal = (input: unknown) => {
    const coerced = coerceLocalInternalId(input);
    if (coerced !== null) {
      candidates.internal.push(coerced);
    }
  };

  const pushExternal = (input: unknown) => {
    if (input !== undefined) {
      candidates.external.push(input);
    }
  };

  if (value instanceof FragnoId) {
    pushInternal(value.internalId);
    pushExternal(value.externalId);
    return candidates;
  }

  if (value instanceof FragnoReference) {
    pushInternal(value.internalId);
    return candidates;
  }

  if (typeof value === "object") {
    if ("internalId" in value) {
      pushInternal((value as { internalId?: unknown }).internalId);
    }
    if (
      "externalId" in value &&
      typeof (value as { externalId?: unknown }).externalId === "string"
    ) {
      pushExternal((value as { externalId: string }).externalId);
    }
  }

  if (column.role === "external-id") {
    if (typeof value === "string") {
      pushExternal(value);
      return candidates;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      pushInternal(value);
      return candidates;
    }
  }

  if (column.role === "reference" || column.role === "internal-id") {
    if (typeof value === "string") {
      pushExternal(value);
      return candidates;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      pushInternal(value);
      return candidates;
    }
  }

  candidates.normalized.push(normalizeValue(value, column));
  return candidates;
};

const hasCandidateMatch = (left: unknown[], right: unknown[]): boolean => {
  for (const leftValue of left) {
    for (const rightValue of right) {
      if (compareNormalizedValues(leftValue, rightValue) === 0) {
        return true;
      }
    }
  }
  return false;
};

const matchesJoinCandidates = (left: JoinCandidates, right: JoinCandidates): boolean => {
  if (left.internal.length > 0 && right.internal.length > 0) {
    return hasCandidateMatch(left.internal, right.internal);
  }
  if (left.external.length > 0 && right.external.length > 0) {
    return hasCandidateMatch(left.external, right.external);
  }
  if (left.normalized.length > 0 && right.normalized.length > 0) {
    return hasCandidateMatch(left.normalized, right.normalized);
  }
  return false;
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

const matchesJoinOn = (options: {
  parentRow: Record<string, unknown>;
  targetRow: Record<string, unknown>;
  join: CompiledJoin;
  overlay: InMemoryLofiAdapter;
  schemaName: string;
}): boolean => {
  const { parentRow, targetRow, join, overlay, schemaName } = options;
  const parentTable = join.relation.referencer;
  const targetTable = join.relation.table;
  const parentExternalId = getExternalIdFromRow(parentRow, parentTable);
  const overlayParent = parentExternalId
    ? overlay.store.getRow(schemaName, parentTable.name, parentExternalId)
    : undefined;
  const overlayData = overlayParent?.data;

  for (const [left, right] of join.relation.on) {
    const leftColumn = parentTable.columns[left];
    if (!leftColumn) {
      throw new Error(`Column "${left}" not found on table "${parentTable.name}".`);
    }

    const rightColumn = targetTable.columns[right];
    if (!rightColumn) {
      throw new Error(`Column "${right}" not found on table "${targetTable.name}".`);
    }

    const leftValue = getRowValueWithOverlay(parentRow, left, overlayData);
    const rightValue = targetRow[right];

    const leftCandidates = collectJoinCandidates(leftValue, leftColumn);
    const rightCandidates = collectJoinCandidates(rightValue, rightColumn);

    if (!matchesJoinCandidates(leftCandidates, rightCandidates)) {
      return false;
    }
  }

  return true;
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
      output[column.name] =
        value === null || value === undefined
          ? null
          : FragnoReference.fromInternal(BigInt(value as number));
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
    if (join.options === false) {
      continue;
    }

    const joinOptions = join.options;
    const relationName = join.relation.name;
    let target = row[relationName];

    if (target !== undefined && target !== null) {
      const canCheck = (targetRow: Record<string, unknown>) =>
        join.relation.on.every(([, right]) => right in targetRow);

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
        target = join.relation.type === "many" ? baseMatches : baseMatches[0];
        row[relationName] = target;
      }
    }

    if (target === undefined || target === null) {
      continue;
    }

    const patchTarget = async (
      targetRow: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null> => {
      const targetTable = join.relation.table;
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
  if (join.options === false) {
    return [];
  }

  const joinOptions = join.options;
  const targetTable = join.relation.table;
  let baseRows = baseRowsCache.get(targetTable.name);
  if (!baseRows) {
    baseRows = (await baseQuery.find(targetTable.name, (b) => b.whereIndex("primary"))) as Record<
      string,
      unknown
    >[];
    baseRowsCache.set(targetTable.name, baseRows);
  }

  const matches: Record<string, unknown>[] = [];
  for (const baseRow of baseRows) {
    if (!matchesJoinOn({ parentRow, targetRow: baseRow, join, overlay, schemaName })) {
      continue;
    }
    if (joinOptions.where && !evaluateCondition(joinOptions.where as Condition, baseRow)) {
      continue;
    }
    matches.push({ ...baseRow });
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
      if (join.options === false) {
        continue;
      }
      const joinOptions = join.options;
      const relationName = join.relation.name;
      const child = stripped[relationName];
      if (!child) {
        continue;
      }
      if (Array.isArray(child)) {
        stripped[relationName] = child.map((entry) =>
          stripSelection({
            row: entry as Record<string, unknown>,
            table: join.relation.table,
            select: joinOptions.select as undefined | true | readonly string[],
            joins: joinOptions.join,
          }),
        );
      } else if (typeof child === "object") {
        stripped[relationName] = stripSelection({
          row: child as Record<string, unknown>,
          table: join.relation.table,
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
    tableName: string,
    builderFn: ((builder: FindBuilder<AnyTable>) => unknown) | undefined,
    withCursor: boolean,
  ): Promise<Record<string, unknown>[] | CursorResult<Record<string, unknown>> | number> => {
    const tableMap = options.schema.tables as Record<string, AnyTable>;
    const table = tableMap[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const baseFind = baseQuery.find as unknown as (
      name: string,
      builder: (builder: FindBuilder<AnyTable>) => unknown,
    ) => Promise<Record<string, unknown>[] | number>;
    const baseFindWithCursor = baseQuery.findWithCursor as unknown as (
      name: string,
      builder: (builder: FindBuilder<AnyTable>) => unknown,
    ) => Promise<CursorResult<Record<string, unknown>>>;
    const overlayFind = overlayQuery.find as unknown as (
      name: string,
      builder: (builder: FindBuilder<AnyTable>) => unknown,
    ) => Promise<Record<string, unknown>[] | number>;

    const builder = buildFindBuilder(tableName, table);
    if (builderFn) {
      builderFn(builder);
    } else {
      builder.whereIndex("primary");
    }

    const built = builder.build() as
      | { type: "find"; indexName: string; options: BuiltFindOptions }
      | { type: "count"; indexName: string; options: Pick<BuiltFindOptions, "where"> };

    if (built.type === "count") {
      const countBuilder = (b: FindBuilder<AnyTable>) => {
        if (!built.options.where) {
          b.whereIndex(built.indexName as "primary");
          return;
        }
        if (typeof built.options.where === "function") {
          b.whereIndex(built.indexName as "primary", built.options.where as () => Condition);
          return;
        }
        b.whereIndex(built.indexName as "primary", () => built.options.where as Condition);
      };

      const baseRows = (await baseFind(tableName, countBuilder)) as Record<string, unknown>[];
      const overlayRows = (await overlayFind(tableName, countBuilder)) as Record<string, unknown>[];

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

    const orderIndexName = built.options.orderByIndex?.indexName ?? built.indexName;
    const direction = built.options.orderByIndex?.direction ?? "asc";
    const orderColumns = buildOrderColumns(table, orderIndexName);
    const originalSelect = built.options.select as undefined | true | readonly string[];
    const select = augmentSelect({
      table,
      select: originalSelect,
      orderColumns,
    });

    const overlayPageSize = built.options.pageSize;
    const overlayBuilder = (b: FindBuilder<AnyTable>) => {
      if (builderFn) {
        builderFn(b);
      } else {
        b.whereIndex("primary");
      }
      if (select && select !== originalSelect) {
        b.select(select as unknown as true | string[]);
      }
      if (overlayPageSize !== undefined) {
        b.pageSize(overlayPageSize);
      }
    };

    const overlayRows = (await overlayFind(tableName, overlayBuilder)) as Record<string, unknown>[];

    const baseRows: Record<string, unknown>[] = [];
    let mergedRows: Record<string, unknown>[] = [];
    let hasNextBase = false;
    let cursor: Cursor | undefined;

    const pageSize = built.options.pageSize;
    if (pageSize === undefined) {
      const baseBuilder = (b: FindBuilder<AnyTable>) => {
        if (builderFn) {
          builderFn(b);
        } else {
          b.whereIndex("primary");
        }
        if (select && select !== originalSelect) {
          b.select(select as unknown as true | string[]);
        }
      };

      baseRows.push(...((await baseFind(tableName, baseBuilder)) as Record<string, unknown>[]));
    } else {
      let nextAfter: Cursor | string | undefined = built.options.after;
      let nextBefore: Cursor | string | undefined = built.options.before;
      let firstPage = true;
      let keepFetching = true;

      while (keepFetching) {
        const baseBuilder = (b: FindBuilder<AnyTable>) => {
          if (builderFn) {
            builderFn(b);
          } else {
            b.whereIndex("primary");
          }
          if (select && select !== originalSelect) {
            b.select(select as unknown as true | string[]);
          }
          b.pageSize(pageSize);
          if (firstPage) {
            if (nextAfter) {
              b.after(nextAfter);
            }
            if (nextBefore) {
              b.before(nextBefore);
            }
          } else if (cursor) {
            b.after(cursor);
          }
        };

        const page = (await baseFindWithCursor(tableName, baseBuilder)) as CursorResult<
          Record<string, unknown>
        >;

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
          after: built.options.after,
          before: built.options.before,
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
      after: built.options.after,
      before: built.options.before,
    });

    const baseRowsCache = new Map<string, Record<string, unknown>[]>();
    for (const row of mergedRows) {
      await patchJoinRows({
        row,
        joins: built.options.joins,
        overlay: options.overlay,
        baseQuery,
        schemaName,
        baseRowsCache,
      });
    }

    if (!withCursor) {
      const limited =
        pageSize !== undefined ? mergedRows.slice(0, Math.max(0, pageSize)) : mergedRows;
      return limited.map((row) =>
        stripSelection({
          row,
          table,
          select: originalSelect,
          joins: built.options.joins,
        }),
      );
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
      items: items.map((row) =>
        stripSelection({
          row,
          table,
          select: originalSelect,
          joins: built.options.joins,
        }),
      ),
      cursor: nextCursor,
      hasNextPage,
    };
  };

  return {
    async find(tableName, builderFn) {
      const result = await runFind(
        tableName,
        builderFn as unknown as (builder: FindBuilder<AnyTable>) => unknown,
        false,
      );
      return result as Record<string, unknown>[] | number;
    },

    async findWithCursor(tableName, builderFn) {
      const result = await runFind(
        tableName,
        builderFn as unknown as (builder: FindBuilder<AnyTable>) => unknown,
        true,
      );
      return result as CursorResult<Record<string, unknown>>;
    },

    async findFirst(tableName, builderFn) {
      const result = await runFind(
        tableName,
        builderFn
          ? (builder: FindBuilder<AnyTable>) => {
              (builderFn as unknown as (b: FindBuilder<AnyTable>) => unknown)(builder);
              builder.pageSize(1);
              return builder;
            }
          : (builder: FindBuilder<AnyTable>) => builder.whereIndex("primary").pageSize(1),
        false,
      );

      if (typeof result === "number") {
        return null;
      }

      return (result as Record<string, unknown>[])[0] ?? null;
    },
  } as LofiQueryInterface<T>;
};
