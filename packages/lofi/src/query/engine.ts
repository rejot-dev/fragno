import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { Column, FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import type { CursorResult } from "@fragno-dev/db/cursor";
import { Cursor, createCursorFromRecord, decodeCursor } from "@fragno-dev/db/cursor";
import { FindBuilder } from "@fragno-dev/db/unit-of-work";
import type { IDBPDatabase, IDBPIndex, IDBPObjectStore } from "idb";
import type { LofiQueryInterface } from "../types";
import type { ReferenceTarget } from "../indexeddb/types";
import { normalizeValue } from "./normalize";
import { buildCondition, type Condition } from "./conditions";

const ROWS_STORE = "lofi_rows";
const INDEX_SCHEMA_TABLE = "idx_schema_table";

type LofiRow = {
  key: [string, string, string, string];
  endpoint: string;
  schema: string;
  table: string;
  id: string;
  data: Record<string, unknown>;
  _lofi: {
    versionstamp: string;
    norm: Record<string, unknown>;
    internalId: number;
    version: number;
  };
};

type LofiDb = IDBPDatabase<unknown>;
type ReadStore<TxStores extends ArrayLike<string>, StoreName extends string> = IDBPObjectStore<
  unknown,
  TxStores,
  StoreName,
  "readonly"
>;
type ReadIndex<
  TxStores extends ArrayLike<string>,
  StoreName extends string,
  IndexName extends string,
> = IDBPIndex<unknown, TxStores, StoreName, IndexName, "readonly">;

type RowSelection = Record<string, unknown>;

type QueryContext = {
  endpointName: string;
  schemaName: string;
  getDb: () => Promise<LofiDb>;
  referenceTargets: Map<string, ReferenceTarget>;
};

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

const compareByteArrays = (left: Uint8Array, right: Uint8Array): number => {
  const minLength = Math.min(left.length, right.length);
  for (let i = 0; i < minLength; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  if (left.length === right.length) {
    return 0;
  }
  return left.length < right.length ? -1 : 1;
};

const bytesToHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

const compareNormalizedValues = (left: unknown, right: unknown): number => {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return -1;
  }
  if (right === undefined) {
    return 1;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  const leftBytes = toByteArray(left);
  const rightBytes = toByteArray(right);
  if (leftBytes && rightBytes) {
    return compareByteArrays(leftBytes, rightBytes);
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
};

const buildIndexName = (schemaName: string, tableName: string, indexName: string): string =>
  `idx__${schemaName}__${tableName}__${indexName}`;

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
      selection.add(columnName);
    }
  } else {
    for (const columnName of select) {
      selection.add(columnName);
    }
  }

  selection.add("_internalId");
  selection.add("_version");

  return selection;
};

const getColumnValue = (row: LofiRow, columnName: string, column: AnyColumn): unknown => {
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
  row: LofiRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
): RowSelection => {
  const selection = buildSelection(table, select);
  const selected: RowSelection = {};

  for (const columnName of selection) {
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
  row: LofiRow,
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

const buildOutputValueForColumn = (row: LofiRow, column: AnyColumn): unknown => {
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

const resolveReferenceExternalId = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  value: string;
  schemaName: string;
  table: AnyTable;
  columnName: string;
  endpointName: string;
  rowsStore: ReadStore<TxStores, StoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<number | null> => {
  const { value, schemaName, table, columnName, endpointName, rowsStore, referenceTargets } =
    options;
  const target = referenceTargets.get(`${schemaName}::${table.name}::${columnName}`);
  if (!target) {
    return null;
  }

  const key: LofiRow["key"] = [endpointName, target.schema, target.table, value];
  const referenced = (await rowsStore.get(key)) as LofiRow | undefined;
  if (!referenced) {
    return null;
  }
  return referenced._lofi.internalId;
};

const resolveReferenceValue = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  value: unknown;
  column: AnyColumn;
  table: AnyTable;
  schemaName: string;
  endpointName: string;
  rowsStore: ReadStore<TxStores, StoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<unknown> => {
  const { value, column, table, schemaName, endpointName, rowsStore, referenceTargets } = options;

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
      endpointName,
      rowsStore,
      referenceTargets,
    });
  }

  if (typeof value === "string") {
    return resolveReferenceExternalId({
      value,
      schemaName,
      table,
      columnName: column.name,
      endpointName,
      rowsStore,
      referenceTargets,
    });
  }

  return resolveFragnoIdValue(value, column);
};

const resolveComparisonValue = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  value: unknown;
  column: AnyColumn;
  table: AnyTable;
  row: LofiRow;
  schemaName: string;
  endpointName: string;
  rowsStore: ReadStore<TxStores, StoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<{ value: unknown; column: AnyColumn }> => {
  const { value, column, table, row, schemaName, endpointName, rowsStore, referenceTargets } =
    options;

  if (value instanceof Column) {
    return { value: row._lofi.norm[value.name], column: value };
  }

  if (isDbNow(value)) {
    return { value: new Date(), column };
  }

  if (column.role === "reference") {
    const resolved = await resolveReferenceValue({
      value,
      column,
      table,
      schemaName,
      endpointName,
      rowsStore,
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

const evaluateCondition = async <TxStores extends ArrayLike<string>, StoreName extends string>(
  condition: Condition | boolean,
  table: AnyTable,
  row: LofiRow,
  context: QueryContext,
  rowsStore: ReadStore<TxStores, StoreName>,
): Promise<boolean> => {
  if (typeof condition === "boolean") {
    return condition;
  }

  switch (condition.type) {
    case "and": {
      for (const item of condition.items) {
        if (!(await evaluateCondition(item, table, row, context, rowsStore))) {
          return false;
        }
      }
      return true;
    }
    case "or": {
      for (const item of condition.items) {
        if (await evaluateCondition(item, table, row, context, rowsStore)) {
          return true;
        }
      }
      return false;
    }
    case "not":
      return !(await evaluateCondition(condition.item, table, row, context, rowsStore));
    case "compare":
      break;
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const leftColumn = condition.a;
  const leftValue = row._lofi.norm[leftColumn.name];
  const right = await resolveComparisonValue({
    value: condition.b,
    column: leftColumn,
    table,
    row,
    schemaName: context.schemaName,
    endpointName: context.endpointName,
    rowsStore,
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
      const resolved = await resolveComparisonValue({
        value: item,
        column: leftColumn,
        table,
        row,
        schemaName: context.schemaName,
        endpointName: context.endpointName,
        rowsStore,
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
  rows: LofiRow[],
  orderBy: [AnyColumn, "asc" | "desc"][] | undefined,
): LofiRow[] => {
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
    const rawValue = getCursorValue(cursorObj.indexValues[column.name], column);
    if (rawValue === undefined) {
      return undefined;
    }

    if (column.role === "reference" || column.role === "internal-id") {
      return coerceLocalInternalId(rawValue);
    }

    return normalizeValue(rawValue, column);
  });
};

const compareRowToCursor = (
  row: LofiRow,
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

const collectRows = async <TxStores extends ArrayLike<string>, StoreName extends string>(options: {
  rowsStore: ReadStore<TxStores, StoreName>;
  endpointName: string;
  schemaName: string;
  tableName: string;
  indexName: string;
}): Promise<LofiRow[]> => {
  const { rowsStore, endpointName, schemaName, tableName, indexName } = options;
  const results: LofiRow[] = [];

  const indexKey =
    indexName === "_primary"
      ? INDEX_SCHEMA_TABLE
      : buildIndexName(schemaName, tableName, indexName);
  const source: ReadIndex<TxStores, StoreName, string> = rowsStore.indexNames.contains(indexKey)
    ? rowsStore.index(indexKey)
    : rowsStore.index(INDEX_SCHEMA_TABLE);

  const range =
    source.name === INDEX_SCHEMA_TABLE
      ? IDBKeyRange.only([endpointName, schemaName, tableName])
      : undefined;

  let cursor = await source.openCursor(range);
  while (cursor) {
    const row = cursor.value as LofiRow;
    if (row.endpoint === endpointName && row.schema === schemaName && row.table === tableName) {
      results.push(row);
    }
    cursor = await cursor.continue();
  }

  return results;
};

const findJoinMatches = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  parentRow: LofiRow;
  parentTable: AnyTable;
  join: CompiledJoin;
  rowsByTable: Map<string, LofiRow[]>;
  context: QueryContext;
  rowsStore: ReadStore<TxStores, StoreName>;
}): Promise<LofiRow[]> => {
  const { parentRow, parentTable, join, rowsByTable, context, rowsStore } = options;
  if (join.options === false) {
    return [];
  }

  const targetTable = join.relation.table;
  const cacheKey = `${context.schemaName}::${targetTable.name}`;
  let targetRows = rowsByTable.get(cacheKey);
  if (!targetRows) {
    targetRows = await collectRows({
      rowsStore,
      endpointName: context.endpointName,
      schemaName: context.schemaName,
      tableName: targetTable.name,
      indexName: "_primary",
    });
    rowsByTable.set(cacheKey, targetRows);
  }

  const matches: LofiRow[] = [];

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

      const comparison = compareNormalizedValues(leftValue, rightValue);
      if (comparison !== 0) {
        matchesJoin = false;
        break;
      }
    }

    if (!matchesJoin) {
      continue;
    }

    if (join.options.where) {
      const matchesWhere = await evaluateCondition(
        join.options.where,
        targetTable,
        row,
        context,
        rowsStore,
      );
      if (!matchesWhere) {
        continue;
      }
    }

    matches.push(row);
  }

  const ordered = orderRows(matches, join.options.orderBy);
  if (join.options.limit !== undefined) {
    return ordered.slice(0, Math.max(0, join.options.limit));
  }

  return ordered;
};

const applyJoins = async <TxStores extends ArrayLike<string>, StoreName extends string>(options: {
  baseOutput: RowSelection;
  parentRow: LofiRow;
  parentTable: AnyTable;
  joins: CompiledJoin[] | undefined;
  rowsByTable: Map<string, LofiRow[]>;
  context: QueryContext;
  rowsStore: ReadStore<TxStores, StoreName>;
  parentPath?: string;
}): Promise<RowSelection[]> => {
  const {
    baseOutput,
    parentRow,
    parentTable,
    joins,
    rowsByTable,
    context,
    rowsStore,
    parentPath = "",
  } = options;

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
        rowsStore,
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
              rowsStore,
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

const applyCursorFilters = (options: {
  rows: LofiRow[];
  orderColumns: AnyColumn[];
  direction: "asc" | "desc";
  after?: Cursor | string;
  before?: Cursor | string;
}): LofiRow[] => {
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

export const createIndexedDbQueryEngine = <T extends AnySchema>(options: {
  schema: T;
  endpointName: string;
  getDb: () => Promise<LofiDb>;
  referenceTargets: Map<string, ReferenceTarget>;
  schemaName?: string;
}): LofiQueryInterface<T> => {
  const schemaName = options.schemaName ?? options.schema.name;
  const context: QueryContext = {
    endpointName: options.endpointName,
    schemaName,
    getDb: options.getDb,
    referenceTargets: options.referenceTargets,
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
      const db = await options.getDb();
      const tx = db.transaction(ROWS_STORE, "readonly");
      const rowsStore = tx.objectStore(ROWS_STORE);

      const rows = await collectRows({
        rowsStore,
        endpointName: context.endpointName,
        schemaName: context.schemaName,
        tableName: table.name,
        indexName: built.indexName,
      });

      let count = 0;
      const conditionResult = built.options.where
        ? buildCondition(table.columns, built.options.where)
        : undefined;
      if (conditionResult === false) {
        await tx.done;
        return 0;
      }
      const condition = conditionResult === true ? undefined : conditionResult;

      for (const row of rows) {
        if (condition && !(await evaluateCondition(condition, table, row, context, rowsStore))) {
          continue;
        }
        count += 1;
      }

      await tx.done;
      return count;
    }

    const db = await options.getDb();
    const tx = db.transaction(ROWS_STORE, "readonly");
    const rowsStore = tx.objectStore(ROWS_STORE);

    const rows = await collectRows({
      rowsStore,
      endpointName: context.endpointName,
      schemaName: context.schemaName,
      tableName: table.name,
      indexName: built.indexName,
    });

    const conditionResult = built.options.where
      ? buildCondition(table.columns, built.options.where)
      : undefined;
    if (conditionResult === false) {
      await tx.done;
      return withCursor ? { items: [], hasNextPage: false } : [];
    }
    const condition = conditionResult === true ? undefined : conditionResult;

    const filtered: LofiRow[] = [];
    for (const row of rows) {
      if (condition && !(await evaluateCondition(condition, table, row, context, rowsStore))) {
        continue;
      }
      filtered.push(row);
    }

    const orderIndexName = built.options.orderByIndex?.indexName ?? built.indexName;
    const direction = built.options.orderByIndex?.direction ?? "asc";
    const orderColumns = buildOrderColumns(table, orderIndexName);

    let ordered = orderRows(
      filtered,
      orderColumns.map((col) => [col, direction]),
    );
    ordered = applyCursorFilters({
      rows: ordered,
      orderColumns,
      direction,
      after: built.options.after,
      before: built.options.before,
    });

    const limit =
      withCursor && built.options.pageSize !== undefined
        ? built.options.pageSize + 1
        : built.options.pageSize;

    const results: RowSelection[] = [];
    const resultSources: LofiRow[] = [];
    const rowsByTable = new Map<string, LofiRow[]>();

    for (const row of ordered) {
      const select = built.options.select as undefined | true | readonly string[];
      const baseOutput = selectRow(row, table, select);

      if (built.options.joins && built.options.joins.length > 0) {
        const joined = await applyJoins({
          baseOutput,
          parentRow: row,
          parentTable: table,
          joins: built.options.joins,
          rowsByTable,
          context,
          rowsStore,
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

    await tx.done;

    const decoded = results.map((row) => decodeRow(row, table));

    if (!withCursor) {
      return decoded;
    }

    let cursor: Cursor | undefined;
    let hasNextPage = false;
    let items = decoded;

    if (
      built.options.pageSize &&
      built.options.pageSize > 0 &&
      decoded.length > built.options.pageSize
    ) {
      hasNextPage = true;
      items = decoded.slice(0, built.options.pageSize);

      const lastRow = items[items.length - 1];
      if (lastRow) {
        const cursorRecord: Record<string, unknown> = { ...lastRow };
        const sourceRow = resultSources[built.options.pageSize - 1];
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
          pageSize: built.options.pageSize,
        });
      }
    }

    return { items, cursor, hasNextPage };
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
