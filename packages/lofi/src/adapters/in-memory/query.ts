import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { Column, FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import type { CursorResult } from "@fragno-dev/db/cursor";
import { Cursor, createCursorFromRecord, decodeCursor } from "@fragno-dev/db/cursor";
import { FindBuilder } from "@fragno-dev/db/unit-of-work";
import type { LofiQueryInterface } from "../../types";
import type { ReferenceTarget } from "../../indexeddb/types";
import { normalizeValue } from "../../query/normalize";
import { buildCondition, type Condition, type ConditionBuilder } from "../../query/conditions";
import { compareNormalizedValues } from "./value-comparison";
import type { InMemoryLofiRow } from "./store";
import { InMemoryLofiStore } from "./store";
import { shouldIgnoreSystemColumn } from "../../system-columns";

export type InMemoryQueryContext = {
  endpointName: string;
  schemaName: string;
  store: InMemoryLofiStore;
  referenceTargets: Map<string, ReferenceTarget>;
};

type QueryContext = InMemoryQueryContext;

type RowSelection = Record<string, unknown>;

type CompiledJoin = {
  relation: { name: string; table: AnyTable; on: [string, string][] };
  options:
    | {
        select: unknown;
        where?: Condition;
        orderBy?: [AnyColumn, "asc" | "desc"][];
        join?: CompiledJoin[];
        limit?: number;
      }
    | false;
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

type DbNow = { tag: "db-now" };

const isDbNow = (value: unknown): value is DbNow =>
  typeof value === "object" && value !== null && (value as { tag?: string }).tag === "db-now";

const resolveFragnoIdValue = (value: unknown, col: AnyColumn): unknown => {
  if (value instanceof FragnoReference) {
    return value.internalId;
  }

  if (value instanceof FragnoId) {
    if (col.role === "external-id") {
      return value.externalId;
    }
    if (col.role === "internal-id") {
      if (value.internalId === undefined) {
        throw new Error(`FragnoId must have internalId for internal-id column ${col.name}`);
      }
      return value.internalId;
    }
    if (col.role === "reference") {
      return value.databaseId;
    }
    return value.externalId;
  }

  return value;
};

const buildSelection = (
  table: AnyTable,
  select: undefined | true | readonly string[],
): Set<string> => {
  const selection = new Set<string>();

  if (!select || select === true) {
    for (const columnName of Object.keys(table.columns)) {
      if (shouldIgnoreSystemColumn(columnName)) {
        continue;
      }
      selection.add(columnName);
    }
  } else {
    for (const columnName of select) {
      if (shouldIgnoreSystemColumn(columnName)) {
        continue;
      }
      selection.add(columnName);
    }
  }

  selection.add("_internalId");
  selection.add("_version");

  return selection;
};

const getColumnValue = (row: InMemoryLofiRow, columnName: string, column: AnyColumn): unknown => {
  if (column.role === "external-id") {
    return row.id;
  }
  if (column.role === "internal-id") {
    return row._lofi.internalId;
  }
  if (column.role === "version") {
    return row._lofi.version;
  }

  return row.data[columnName];
};

const selectRow = (
  row: InMemoryLofiRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
): RowSelection => {
  const selection = buildSelection(table, select);
  const selected: RowSelection = {};

  for (const columnName of selection) {
    if (shouldIgnoreSystemColumn(columnName)) {
      continue;
    }
    if (columnName === "_internalId") {
      selected[columnName] = row._lofi.internalId;
      continue;
    }
    if (columnName === "_version") {
      selected[columnName] = row._lofi.version;
      continue;
    }

    const column = table.columns[columnName];
    if (!column) {
      continue;
    }

    if (column.role === "reference") {
      selected[columnName] = row._lofi.norm[columnName];
      continue;
    }

    selected[columnName] = getColumnValue(row, columnName, column);
  }

  return selected;
};

const prefixSelection = (
  row: InMemoryLofiRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
  prefix: string,
): RowSelection => {
  const selected = selectRow(row, table, select);
  const prefixed: RowSelection = {};

  for (const key in selected) {
    prefixed[`${prefix}:${key}`] = selected[key];
  }

  return prefixed;
};

const buildOutputValueForColumn = (row: InMemoryLofiRow, column: AnyColumn): unknown => {
  if (column.isHidden) {
    return undefined;
  }

  if (column.role === "external-id") {
    return new FragnoId({
      externalId: row.id,
      internalId: BigInt(row._lofi.internalId),
      version: row._lofi.version,
    });
  }

  if (column.role === "reference") {
    const value = row._lofi.norm[column.name];
    return value === null || value === undefined
      ? null
      : FragnoReference.fromInternal(BigInt(value as number));
  }

  if (column.role === "internal-id") {
    return BigInt(row._lofi.internalId);
  }

  if (column.role === "version") {
    return row._lofi.version;
  }

  return row.data[column.name];
};

const decodeRow = (row: RowSelection, table: AnyTable): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  const columnValues: Record<string, unknown> = {};
  const relationData: Record<string, Record<string, unknown>> = {};

  for (const key in row) {
    const colonIndex = key.indexOf(":");
    if (colonIndex === -1) {
      if (table.columns[key]) {
        columnValues[key] = row[key];
      }
      continue;
    }

    const relationName = key.slice(0, colonIndex);
    const remainder = key.slice(colonIndex + 1);
    const relation = table.relations[relationName];
    if (!relation) {
      continue;
    }

    relationData[relationName] ??= {};
    relationData[relationName][remainder] = row[key];
  }

  for (const relationName in relationData) {
    const relation = table.relations[relationName];
    if (!relation) {
      continue;
    }
    output[relationName] = decodeRow(relationData[relationName], relation.table);
  }

  for (const key in columnValues) {
    const column = table.columns[key];
    if (!column || column.isHidden) {
      continue;
    }

    if (column.role === "external-id" && columnValues["_internalId"] !== undefined) {
      output[key] = new FragnoId({
        externalId: columnValues[key] as string,
        internalId: BigInt(columnValues["_internalId"] as number),
        version: columnValues["_version"] as number,
      });
      continue;
    }

    if (column.role === "reference") {
      const value = columnValues[key];
      output[key] =
        value === null || value === undefined
          ? null
          : FragnoReference.fromInternal(BigInt(value as number));
      continue;
    }

    output[key] = columnValues[key];
  }

  return output;
};

const coerceLocalInternalId = (value: unknown): number | unknown => {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new Error(`Local internalId is not a safe integer: ${value.toString()}`);
    }
    return asNumber;
  }
  return value;
};

const resolveReferenceExternalId = (options: {
  value: string;
  schemaName: string;
  table: AnyTable;
  columnName: string;
  store: InMemoryLofiStore;
  referenceTargets: Map<string, ReferenceTarget>;
}): number | null => {
  const { value, schemaName, table, columnName, store, referenceTargets } = options;
  const target = referenceTargets.get(`${schemaName}::${table.name}::${columnName}`);
  if (!target) {
    return null;
  }
  const referenced = store.getRow(target.schema, target.table, value);
  if (!referenced) {
    return null;
  }
  return referenced._lofi.internalId;
};

const resolveReferenceValue = (options: {
  value: unknown;
  column: AnyColumn;
  table: AnyTable;
  schemaName: string;
  store: InMemoryLofiStore;
  referenceTargets: Map<string, ReferenceTarget>;
}): unknown => {
  const { value, column, table, schemaName, store, referenceTargets } = options;

  if (value instanceof FragnoReference) {
    return coerceLocalInternalId(value.internalId);
  }

  if (value instanceof FragnoId) {
    if (value.internalId !== undefined) {
      return coerceLocalInternalId(value.internalId);
    }
    return resolveReferenceExternalId({
      value: value.externalId,
      schemaName,
      table,
      columnName: column.name,
      store,
      referenceTargets,
    });
  }

  if (typeof value === "string") {
    return resolveReferenceExternalId({
      value,
      schemaName,
      table,
      columnName: column.name,
      store,
      referenceTargets,
    });
  }

  return resolveFragnoIdValue(value, column);
};

const resolveComparisonValue = (options: {
  value: unknown;
  column: AnyColumn;
  table: AnyTable;
  row: InMemoryLofiRow;
  schemaName: string;
  store: InMemoryLofiStore;
  referenceTargets: Map<string, ReferenceTarget>;
}): { value: unknown; column: AnyColumn } => {
  const { value, column, table, row, schemaName, store, referenceTargets } = options;

  if (value instanceof Column) {
    return { value: row._lofi.norm[value.name], column: value };
  }

  if (isDbNow(value)) {
    return { value: new Date(), column };
  }

  if (column.role === "reference") {
    const resolved = resolveReferenceValue({
      value,
      column,
      table,
      schemaName,
      store,
      referenceTargets,
    });
    return { value: resolved, column };
  }

  return { value: resolveFragnoIdValue(value, column), column };
};

const normalizeLikeValue = (value: unknown, column: AnyColumn): string | null => {
  const normalized =
    column.role === "reference" || column.role === "internal-id"
      ? coerceLocalInternalId(value)
      : normalizeValue(value, column);
  if (normalized === null || normalized === undefined) {
    return null;
  }
  const bytes = toByteArray(normalized);
  if (bytes) {
    return bytesToHex(bytes);
  }
  return String(normalized);
};

const evaluateCondition = async (
  condition: Condition | boolean,
  table: AnyTable,
  row: InMemoryLofiRow,
  context: QueryContext,
): Promise<boolean> => {
  if (typeof condition === "boolean") {
    return condition;
  }

  switch (condition.type) {
    case "and": {
      for (const item of condition.items) {
        if (!(await evaluateCondition(item, table, row, context))) {
          return false;
        }
      }
      return true;
    }
    case "or": {
      for (const item of condition.items) {
        if (await evaluateCondition(item, table, row, context)) {
          return true;
        }
      }
      return false;
    }
    case "not":
      return !(await evaluateCondition(condition.item, table, row, context));
    case "compare":
      break;
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const leftColumn = condition.a;
  const leftValue = row._lofi.norm[leftColumn.name];
  const right = resolveComparisonValue({
    value: condition.b,
    column: leftColumn,
    table,
    row,
    schemaName: context.schemaName,
    store: context.store,
    referenceTargets: context.referenceTargets,
  });

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

    const leftNormalized = leftValue;
    const rightNormalized =
      right.column.role === "reference" || right.column.role === "internal-id"
        ? coerceLocalInternalId(rightValue)
        : normalizeValue(rightValue, right.column);
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

    const leftNormalized = leftValue;
    let hasNull = false;
    let hasMatch = false;

    for (const item of rightValue) {
      const resolved = resolveComparisonValue({
        value: item,
        column: leftColumn,
        table,
        row,
        schemaName: context.schemaName,
        store: context.store,
        referenceTargets: context.referenceTargets,
      });
      if (isNullish(resolved.value)) {
        hasNull = true;
        continue;
      }

      const normalized =
        resolved.column.role === "reference" || resolved.column.role === "internal-id"
          ? coerceLocalInternalId(resolved.value)
          : normalizeValue(resolved.value, resolved.column);
      if (compareNormalizedValues(leftNormalized, normalized) === 0) {
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

  const leftNormalized = leftValue;
  const rightNormalized =
    right.column.role === "reference" || right.column.role === "internal-id"
      ? coerceLocalInternalId(rightValue)
      : normalizeValue(rightValue, right.column);
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
      throw new Error(`Unsupported operator "${op}".`);
  }
};

const orderRows = (
  rows: InMemoryLofiRow[],
  orderBy: [AnyColumn, "asc" | "desc"][] | undefined,
): InMemoryLofiRow[] => {
  if (!orderBy || orderBy.length === 0) {
    return rows;
  }

  return rows.slice().sort((left, right) => {
    for (const [column, direction] of orderBy) {
      const leftValue = left._lofi.norm[column.name];
      const rightValue = right._lofi.norm[column.name];
      const comparison = compareNormalizedValues(leftValue, rightValue);
      if (comparison !== 0) {
        return direction === "asc" ? comparison : -comparison;
      }
    }
    return 0;
  });
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

const getCursorValue = (value: unknown, column: AnyColumn): unknown => {
  if (
    typeof value === "object" &&
    value !== null &&
    "externalId" in value &&
    typeof (value as { externalId?: unknown }).externalId === "string"
  ) {
    const fragnoLike = value as { externalId: string; internalId?: string | number | bigint };
    if (column.role === "external-id") {
      return fragnoLike.externalId;
    }
    if ((column.role === "internal-id" || column.role === "reference") && fragnoLike.internalId) {
      return coerceLocalInternalId(
        typeof fragnoLike.internalId === "string"
          ? BigInt(fragnoLike.internalId)
          : fragnoLike.internalId,
      );
    }
  }

  if (value instanceof FragnoId) {
    if (column.role === "external-id") {
      return value.externalId;
    }
    if ((column.role === "internal-id" || column.role === "reference") && value.internalId) {
      return coerceLocalInternalId(value.internalId);
    }
  }

  if (value instanceof FragnoReference) {
    return coerceLocalInternalId(value.internalId);
  }

  return value;
};

const buildCursorValues = (
  cursor: Cursor | string | undefined,
  columns: AnyColumn[],
): readonly unknown[] | undefined => {
  if (!cursor) {
    return undefined;
  }

  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
  return columns.map((column) => {
    if (!(column.name in cursorObj.indexValues)) {
      throw new Error(`Cursor is missing index value for ${column.name}`);
    }
    const value = getCursorValue(cursorObj.indexValues[column.name], column);
    return column.role === "reference" || column.role === "internal-id"
      ? coerceLocalInternalId(value)
      : normalizeValue(value, column);
  });
};

const compareRowToCursor = (
  row: InMemoryLofiRow,
  columns: AnyColumn[],
  cursorValues: readonly unknown[],
): number => {
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i];
    const leftValue = row._lofi.norm[column.name];
    const rightValue = cursorValues[i];
    const comparison = compareNormalizedValues(leftValue, rightValue);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
};

const collectRows = (options: { context: QueryContext; tableName: string }): InMemoryLofiRow[] => {
  const { context, tableName } = options;
  return context.store.getTableRows(context.schemaName, tableName);
};

const findJoinMatches = async (options: {
  parentRow: InMemoryLofiRow;
  parentTable: AnyTable;
  join: CompiledJoin;
  rowsByTable: Map<string, InMemoryLofiRow[]>;
  context: QueryContext;
}): Promise<InMemoryLofiRow[]> => {
  const { parentRow, parentTable, join, rowsByTable, context } = options;
  if (join.options === false) {
    return [];
  }

  const targetTable = join.relation.table;
  const cacheKey = `${context.schemaName}::${targetTable.name}`;
  let targetRows = rowsByTable.get(cacheKey);
  if (!targetRows) {
    targetRows = collectRows({
      context,
      tableName: targetTable.name,
    });
    rowsByTable.set(cacheKey, targetRows);
  }

  const matches: InMemoryLofiRow[] = [];

  for (const row of targetRows) {
    let matchesJoin = true;

    for (const [left, right] of join.relation.on) {
      const leftColumn = parentTable.columns[left];
      if (!leftColumn) {
        throw new Error(`Column "${left}" not found on table "${parentTable.name}".`);
      }

      const rightColumn = targetTable.columns[right];
      if (!rightColumn) {
        throw new Error(`Column "${right}" not found on table "${targetTable.name}".`);
      }

      const actualRight = rightColumn.role === "external-id" ? "_internalId" : right;
      const actualRightColumn = targetTable.columns[actualRight];
      if (!actualRightColumn) {
        throw new Error(`Column "${actualRight}" not found on table "${targetTable.name}".`);
      }

      const leftValue = parentRow._lofi.norm[leftColumn.name];
      const rightValue = row._lofi.norm[actualRightColumn.name];
      if (isNullish(leftValue) || isNullish(rightValue)) {
        matchesJoin = false;
        break;
      }
      if (compareNormalizedValues(leftValue, rightValue) !== 0) {
        matchesJoin = false;
        break;
      }
    }

    if (!matchesJoin) {
      continue;
    }

    if (join.options.where) {
      const matchesWhere = await evaluateCondition(join.options.where, targetTable, row, context);
      if (!matchesWhere) {
        continue;
      }
    }

    matches.push(row);
  }

  if (join.options.orderBy && join.options.orderBy.length > 0) {
    return orderRows(matches, join.options.orderBy as [AnyColumn, "asc" | "desc"][]);
  }

  return matches;
};

const applyJoins = async (options: {
  baseOutput: RowSelection;
  parentRow: InMemoryLofiRow;
  parentTable: AnyTable;
  joins: CompiledJoin[];
  rowsByTable: Map<string, InMemoryLofiRow[]>;
  context: QueryContext;
  parentPath?: string;
}): Promise<RowSelection[]> => {
  const { baseOutput, parentRow, parentTable, joins, rowsByTable, context, parentPath } = options;

  if (!joins || joins.length === 0) {
    return [baseOutput];
  }

  let outputs: RowSelection[] = [baseOutput];

  for (const join of joins) {
    if (join.options === false) {
      continue;
    }

    const relationPath = parentPath ? `${parentPath}:${join.relation.name}` : join.relation.name;
    const nextOutputs: RowSelection[] = [];

    for (const currentOutput of outputs) {
      const matches = await findJoinMatches({
        parentRow,
        parentTable,
        join,
        rowsByTable,
        context,
      });

      if (matches.length === 0) {
        nextOutputs.push(currentOutput);
        continue;
      }

      for (const matchRow of matches) {
        const prefixed = prefixSelection(
          matchRow,
          join.relation.table,
          join.options.select as undefined | true | readonly string[],
          relationPath,
        );
        const merged = { ...currentOutput, ...prefixed };

        if (join.options.join && join.options.join.length > 0) {
          nextOutputs.push(
            ...(await applyJoins({
              baseOutput: merged,
              parentRow: matchRow,
              parentTable: join.relation.table,
              joins: join.options.join,
              rowsByTable,
              context,
              parentPath: relationPath,
            })),
          );
        } else {
          nextOutputs.push(merged);
        }
      }
    }

    outputs = nextOutputs;
  }

  return outputs;
};

const buildFindBuilder = <TTable extends AnyTable>(tableName: string, table: TTable) =>
  new FindBuilder<TTable>(tableName, table);

type OverlayFindOptions<TTable extends AnyTable = AnyTable> = {
  useIndex: string;
  select?: unknown;
  where?: ((builder: ConditionBuilder<TTable["columns"]>) => Condition | boolean) | Condition;
  orderByIndex?: {
    indexName: string;
    direction: "asc" | "desc";
  };
  after?: Cursor | string;
  before?: Cursor | string;
  pageSize?: number;
  joins?: CompiledJoin[];
};

type OverlayRetrievalOperation =
  | {
      type: "find";
      table: AnyTable;
      indexName: string;
      options: OverlayFindOptions;
      withCursor: boolean;
    }
  | {
      type: "count";
      table: AnyTable;
      indexName: string;
      options: Pick<OverlayFindOptions, "where">;
    };

const resolveFindCondition = <TTable extends AnyTable>(
  table: TTable,
  input: OverlayFindOptions<TTable>["where"],
): Condition | undefined | false => {
  if (!input) {
    return undefined;
  }
  if (typeof input === "function") {
    const built = buildCondition(table.columns, input);
    if (built === true) {
      return undefined;
    }
    return built;
  }
  return input;
};

const applyCursorFilters = (options: {
  rows: InMemoryLofiRow[];
  orderColumns: AnyColumn[];
  direction: "asc" | "desc";
  after?: Cursor | string;
  before?: Cursor | string;
}): InMemoryLofiRow[] => {
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

export const executeInMemoryRetrievalOperation = async (options: {
  operation: OverlayRetrievalOperation;
  context: QueryContext;
}): Promise<Record<string, unknown>[] | CursorResult<Record<string, unknown>> | number> => {
  const { operation, context } = options;

  const rows = collectRows({
    context,
    tableName: operation.table.name,
  });

  const condition =
    operation.options.where !== undefined
      ? resolveFindCondition(operation.table, operation.options.where)
      : undefined;

  if (condition === false) {
    if (operation.type === "count") {
      return 0;
    }
    return operation.withCursor ? { items: [], hasNextPage: false } : [];
  }

  if (operation.type === "count") {
    let count = 0;
    for (const row of rows) {
      if (condition && !(await evaluateCondition(condition, operation.table, row, context))) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  const filtered: InMemoryLofiRow[] = [];
  for (const row of rows) {
    if (condition && !(await evaluateCondition(condition, operation.table, row, context))) {
      continue;
    }
    filtered.push(row);
  }

  const orderIndexName = operation.options.orderByIndex?.indexName ?? operation.indexName;
  const direction = operation.options.orderByIndex?.direction ?? "asc";
  const orderColumns = buildOrderColumns(operation.table, orderIndexName);

  let ordered = orderRows(
    filtered,
    orderColumns.map((col) => [col, direction]),
  );
  ordered = applyCursorFilters({
    rows: ordered,
    orderColumns,
    direction,
    after: operation.options.after,
    before: operation.options.before,
  });

  const limit =
    operation.withCursor && operation.options.pageSize !== undefined
      ? operation.options.pageSize + 1
      : operation.options.pageSize;

  const results: RowSelection[] = [];
  const resultSources: InMemoryLofiRow[] = [];
  const rowsByTable = new Map<string, InMemoryLofiRow[]>();

  for (const row of ordered) {
    const select = operation.options.select as undefined | true | readonly string[];
    const baseOutput = selectRow(row, operation.table, select);

    if (operation.options.joins && operation.options.joins.length > 0) {
      const joined = await applyJoins({
        baseOutput,
        parentRow: row,
        parentTable: operation.table,
        joins: operation.options.joins,
        rowsByTable,
        context,
      });
      for (const joinedRow of joined) {
        results.push(joinedRow);
        resultSources.push(row);
        if (limit !== undefined && results.length >= limit) {
          break;
        }
      }
    } else {
      results.push(baseOutput);
      resultSources.push(row);
    }

    if (limit !== undefined && results.length >= limit) {
      break;
    }
  }

  const decoded = results.map((row) => decodeRow(row, operation.table));

  if (!operation.withCursor) {
    return decoded;
  }

  let cursor: Cursor | undefined;
  let hasNextPage = false;
  let items = decoded;

  if (
    operation.options.pageSize &&
    operation.options.pageSize > 0 &&
    decoded.length > operation.options.pageSize
  ) {
    hasNextPage = true;
    items = decoded.slice(0, operation.options.pageSize);

    const lastRow = items[items.length - 1];
    if (lastRow) {
      const cursorRecord: Record<string, unknown> = { ...lastRow };
      const sourceRow = resultSources[operation.options.pageSize - 1];
      for (const column of orderColumns) {
        if (cursorRecord[column.name] === undefined) {
          cursorRecord[column.name] = sourceRow
            ? buildOutputValueForColumn(sourceRow, column)
            : cursorRecord[column.name];
        }
      }

      cursor = createCursorFromRecord(cursorRecord, orderColumns, {
        indexName: orderIndexName,
        orderDirection: direction,
        pageSize: operation.options.pageSize,
      });
    }
  }

  return { items, cursor, hasNextPage };
};

export const createInMemoryQueryEngine = <T extends AnySchema>(options: {
  schema: T;
  store: InMemoryLofiStore;
  schemaName?: string;
}): LofiQueryInterface<T> => {
  const schemaName = options.schemaName ?? options.schema.name;
  const context: QueryContext = {
    endpointName: options.store.endpointName,
    schemaName,
    store: options.store,
    referenceTargets: options.store.referenceTargets,
  };

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

    const builder = buildFindBuilder(tableName, table);
    if (builderFn) {
      builderFn(builder);
    } else {
      builder.whereIndex("primary");
    }

    const built = builder.build();
    if (built.type === "count") {
      return executeInMemoryRetrievalOperation({
        operation: {
          type: "count",
          table,
          indexName: built.indexName,
          options: { where: built.options.where },
        },
        context,
      });
    }

    return executeInMemoryRetrievalOperation({
      operation: {
        type: "find",
        table,
        indexName: built.indexName,
        options: built.options,
        withCursor,
      },
      context,
    });
  };

  const queryEngine = {
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

  return queryEngine;
};
