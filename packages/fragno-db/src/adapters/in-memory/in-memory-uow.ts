import type { AnySchema, AnyTable } from "../../schema/create";
import { FragnoId, FragnoReference } from "../../schema/create";
import { SQLocalDriverConfig } from "../generic-sql/driver-config";
import type {
  CompiledMutation,
  MutationOperation,
  MutationResult,
  RetrievalOperation,
  UOWCompiler,
  UOWDecoder,
  UOWExecutor,
} from "../../query/unit-of-work/unit-of-work";
import { buildCondition } from "../../query/condition-builder";
import {
  encodeValues,
  encodeValuesWithDbDefaults,
  ReferenceSubquery,
} from "../../query/value-encoding";
import { isDbNow } from "../../query/db-now";
import { createSQLSerializer } from "../../query/serialize/create-sql-serializer";
import type { CompiledJoin } from "../../query/orm/orm";
import {
  createCursorFromRecord,
  decodeCursor,
  type Cursor,
  type CursorResult,
} from "../../query/cursor";
import type {
  InMemoryNamespaceStore,
  InMemoryRow,
  InMemoryStore,
  InMemoryTableStore,
} from "./store";
import { buildIndexKey, ensureNamespaceStore, normalizeIndexValue } from "./store";
import { evaluateCondition } from "./condition-evaluator";
import { resolveReferenceSubqueries } from "./reference-resolution";
import type { ResolvedInMemoryAdapterOptions } from "./options";
import { compareNormalizedValues } from "./value-comparison";

type InMemoryCompiledQuery = RetrievalOperation<AnySchema> | MutationOperation<AnySchema>;
type InMemoryRawResult = InMemoryRow[] | { count: number }[];
type CursorInput = string | Cursor | undefined;

const cursorSerializer = createSQLSerializer(new SQLocalDriverConfig());

class VersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionConflictError";
  }
}

const getNamespaceStore = (
  store: InMemoryStore,
  op: RetrievalOperation<AnySchema> | MutationOperation<AnySchema>,
): InMemoryNamespaceStore => {
  const namespace = op.namespace ?? "";
  return ensureNamespaceStore(store, namespace, op.schema);
};

const getTableStore = (
  namespaceStore: InMemoryNamespaceStore,
  tableName: string,
): InMemoryTableStore => {
  const tableStore = namespaceStore.tables.get(tableName);
  if (!tableStore) {
    throw new Error(`Missing in-memory table store for "${tableName}".`);
  }
  return tableStore;
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

const selectRow = (
  row: InMemoryRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
): InMemoryRow => {
  const selection = buildSelection(table, select);
  const selected: InMemoryRow = {};
  for (const columnName of selection) {
    if (Object.prototype.hasOwnProperty.call(row, columnName)) {
      selected[columnName] = row[columnName];
    }
  }
  return selected;
};

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const prefixSelection = (
  row: InMemoryRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
  prefix: string,
): InMemoryRow => {
  const selected = selectRow(row, table, select);
  const prefixed: InMemoryRow = {};

  for (const key in selected) {
    prefixed[`${prefix}:${key}`] = selected[key];
  }

  return prefixed;
};

const orderRows = (
  rows: InMemoryRow[],
  orderBy: [AnyTable["columns"][string], "asc" | "desc"][] | undefined,
): InMemoryRow[] => {
  if (!orderBy || orderBy.length === 0) {
    return rows;
  }

  return rows.slice().sort((left, right) => {
    for (const [column, direction] of orderBy) {
      const leftValue = normalizeIndexValue(left[column.name], column);
      const rightValue = normalizeIndexValue(right[column.name], column);
      const comparison = compareNormalizedValues(leftValue, rightValue);
      if (comparison !== 0) {
        return direction === "asc" ? comparison : -comparison;
      }
    }
    return 0;
  });
};

const assertOrderByIndexOnly = (
  table: AnyTable,
  orderBy: [AnyTable["columns"][string], "asc" | "desc"][] | undefined,
): void => {
  if (!orderBy || orderBy.length === 0) {
    return;
  }

  const direction = orderBy[0][1];
  if (!orderBy.every(([, dir]) => dir === direction)) {
    throw new Error(
      `In-memory adapter only supports orderByIndex; mixed orderBy directions found on table "${table.ormName}".`,
    );
  }

  const orderColumnNames = orderBy.map(([column]) => column.ormName);
  const idColumnName = table.getIdColumn().ormName;
  if (orderColumnNames.length === 1 && orderColumnNames[0] === idColumnName) {
    return;
  }

  for (const index of Object.values(table.indexes)) {
    const indexColumnNames = index.columnNames as readonly string[];
    if (indexColumnNames.length !== orderColumnNames.length) {
      continue;
    }
    let matches = true;
    for (let i = 0; i < indexColumnNames.length; i += 1) {
      if (indexColumnNames[i] !== orderColumnNames[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return;
    }
  }

  throw new Error(
    `In-memory adapter only supports orderByIndex; received orderBy on table "${table.ormName}".`,
  );
};

const findJoinMatches = (
  parentRow: InMemoryRow,
  parentTable: AnyTable,
  join: CompiledJoin,
  namespaceStore: InMemoryNamespaceStore,
  now: () => Date,
): InMemoryRow[] => {
  const { relation, options } = join;
  if (options === false) {
    return [];
  }

  const targetTable = relation.table;
  const targetStore = getTableStore(namespaceStore, targetTable.ormName);
  const matches: InMemoryRow[] = [];

  assertOrderByIndexOnly(targetTable, options.orderBy);

  for (const row of targetStore.rows.values()) {
    let matchesJoin = true;

    for (const [left, right] of relation.on) {
      const leftColumn = parentTable.columns[left];
      if (!leftColumn) {
        throw new Error(`Column "${left}" not found on table "${parentTable.ormName}".`);
      }

      const rightColumn = targetTable.columns[right];
      if (!rightColumn) {
        throw new Error(`Column "${right}" not found on table "${targetTable.ormName}".`);
      }

      const actualRight = rightColumn.role === "external-id" ? "_internalId" : right;
      const actualRightColumn = targetTable.columns[actualRight];
      if (!actualRightColumn) {
        throw new Error(`Column "${actualRight}" not found on table "${targetTable.ormName}".`);
      }

      const leftValue = parentRow[left];
      const rightValue = row[actualRight];
      if (isNullish(leftValue) || isNullish(rightValue)) {
        matchesJoin = false;
        break;
      }

      const leftNormalized = normalizeIndexValue(leftValue, leftColumn);
      const rightNormalized = normalizeIndexValue(rightValue, actualRightColumn);
      if (compareNormalizedValues(leftNormalized, rightNormalized) !== 0) {
        matchesJoin = false;
        break;
      }
    }

    if (!matchesJoin) {
      continue;
    }

    if (options.where && !evaluateCondition(options.where, targetTable, row, namespaceStore, now)) {
      continue;
    }

    matches.push(row);
  }

  const ordered = orderRows(matches, options.orderBy);
  if (options.limit !== undefined) {
    return ordered.slice(0, Math.max(0, options.limit));
  }

  return ordered;
};

const applyJoins = (
  baseOutput: InMemoryRow,
  parentRow: InMemoryRow,
  parentTable: AnyTable,
  joins: CompiledJoin[] | undefined,
  namespaceStore: InMemoryNamespaceStore,
  now: () => Date,
  parentPath = "",
): InMemoryRow[] => {
  if (!joins || joins.length === 0) {
    return [baseOutput];
  }

  let outputs: InMemoryRow[] = [baseOutput];

  for (const join of joins) {
    if (join.options === false) {
      continue;
    }

    const relationPath = parentPath ? `${parentPath}:${join.relation.name}` : join.relation.name;
    const nextOutputs: InMemoryRow[] = [];

    for (const currentOutput of outputs) {
      const matches = findJoinMatches(parentRow, parentTable, join, namespaceStore, now);

      if (matches.length === 0) {
        nextOutputs.push(currentOutput);
        continue;
      }

      for (const matchRow of matches) {
        const prefixed = prefixSelection(
          matchRow,
          join.relation.table,
          join.options.select,
          relationPath,
        );
        const merged = { ...currentOutput, ...prefixed };

        if (join.options.join && join.options.join.length > 0) {
          nextOutputs.push(
            ...applyJoins(
              merged,
              matchRow,
              join.relation.table,
              join.options.join,
              namespaceStore,
              now,
              relationPath,
            ),
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

const getExternalId = (id: FragnoId | string): string =>
  typeof id === "string" ? id : id.externalId;

const getVersionToCheck = (id: FragnoId | string, checkVersion: boolean): number | undefined => {
  if (!checkVersion) {
    return undefined;
  }

  if (typeof id === "string") {
    throw new Error(
      "Cannot use checkVersion with a string ID. Version checking requires a FragnoId.",
    );
  }

  return id.version;
};

const resolveReferenceSubqueriesOrThrow = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
  encodedValues: Record<string, unknown>,
): Record<string, unknown> => {
  const resolved = resolveReferenceSubqueries(namespaceStore, encodedValues);
  for (const [key, value] of Object.entries(encodedValues)) {
    if (!(value instanceof ReferenceSubquery)) {
      continue;
    }

    if (resolved[key] === null || resolved[key] === undefined) {
      throw new Error(
        `Foreign key constraint violation on table "${table.ormName}" for column "${key}".`,
      );
    }
  }
  return resolved;
};

const getReferencedColumn = (
  table: AnyTable,
  columnName: string,
): { name: string; column: AnyTable["columns"][string] } => {
  const column = table.columns[columnName];
  if (!column) {
    throw new Error(`Column "${columnName}" not found on table "${table.ormName}".`);
  }

  const actualName = column.role === "external-id" ? "_internalId" : columnName;
  const actualColumn = table.columns[actualName];
  if (!actualColumn) {
    throw new Error(`Column "${actualName}" not found on table "${table.ormName}".`);
  }

  return { name: actualName, column: actualColumn };
};

const enforceOutgoingForeignKeys = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
  row: InMemoryRow,
  columnsToCheck?: Set<string>,
): void => {
  for (const relation of Object.values(table.relations)) {
    if (relation.type !== "one") {
      continue;
    }

    const localColumnNames = relation.on.map(([local]) => local);
    if (columnsToCheck && !localColumnNames.some((name) => columnsToCheck.has(name))) {
      continue;
    }

    const localValues = localColumnNames.map((name) => row[name]);
    if (localValues.some((value) => value === null || value === undefined)) {
      continue;
    }

    const referencedTable = relation.table;
    const referencedStore = getTableStore(namespaceStore, referencedTable.ormName);
    let foundMatch = false;

    for (const targetRow of referencedStore.rows.values()) {
      let matches = true;
      for (const [localName, foreignName] of relation.on) {
        if (!table.columns[localName]) {
          throw new Error(`Column "${localName}" not found on table "${table.ormName}".`);
        }

        const { name: actualForeignName, column: foreignColumn } = getReferencedColumn(
          referencedTable,
          foreignName,
        );
        const localValue = row[localName];
        const targetValue = targetRow[actualForeignName];

        const normalizedLocal = normalizeIndexValue(localValue, foreignColumn);
        const normalizedTarget = normalizeIndexValue(targetValue, foreignColumn);

        if (compareNormalizedValues(normalizedLocal, normalizedTarget) !== 0) {
          matches = false;
          break;
        }
      }

      if (matches) {
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch) {
      throw new Error(
        `Foreign key constraint violation on table "${table.ormName}" for relation "${relation.name}".`,
      );
    }
  }
};

const enforceNoIncomingForeignKeys = (
  namespaceStore: InMemoryNamespaceStore,
  schema: AnySchema,
  table: AnyTable,
  row: InMemoryRow,
): void => {
  for (const sourceTable of Object.values(schema.tables)) {
    for (const relation of Object.values(sourceTable.relations)) {
      if (relation.type !== "one") {
        continue;
      }

      if (relation.table.ormName !== table.ormName) {
        continue;
      }

      const sourceStore = getTableStore(namespaceStore, sourceTable.ormName);
      const targetColumnInfo = relation.on.map(([, foreignName]) =>
        getReferencedColumn(table, foreignName),
      );
      const targetValues = targetColumnInfo.map(({ name }) => row[name]);
      if (targetValues.some((value) => value === null || value === undefined)) {
        continue;
      }

      for (const sourceRow of sourceStore.rows.values()) {
        let matches = true;
        for (let i = 0; i < relation.on.length; i += 1) {
          const [localName] = relation.on[i]!;
          const { column } = targetColumnInfo[i]!;
          const localValue = sourceRow[localName];
          if (localValue === null || localValue === undefined) {
            matches = false;
            break;
          }

          const normalizedLocal = normalizeIndexValue(localValue, column);
          const normalizedTarget = normalizeIndexValue(targetValues[i], column);
          if (compareNormalizedValues(normalizedLocal, normalizedTarget) !== 0) {
            matches = false;
            break;
          }
        }

        if (matches) {
          throw new Error(
            `Foreign key constraint violation on table "${table.ormName}" for relation "${relation.name}".`,
          );
        }
      }
    }
  }
};

const findRowByExternalId = (
  tableStore: InMemoryTableStore,
  table: AnyTable,
  externalId: string,
): { internalId: bigint; row: InMemoryRow } | undefined => {
  const idColumn = table.getIdColumn();
  for (const [internalId, row] of tableStore.rows) {
    if (row[idColumn.name] === externalId) {
      return { internalId, row };
    }
  }
  return undefined;
};

const resolveCursorValue = (value: unknown, column: AnyTable["columns"][string]): unknown => {
  if (value && typeof value === "object") {
    const maybeExternalId = (value as { externalId?: unknown }).externalId;
    const maybeInternalId = (value as { internalId?: unknown }).internalId;

    if (typeof maybeExternalId === "string") {
      if (column.role === "external-id") {
        return maybeExternalId;
      }
      if ((column.role === "internal-id" || column.role === "reference") && maybeInternalId) {
        return typeof maybeInternalId === "string" ? BigInt(maybeInternalId) : maybeInternalId;
      }
    }
  }

  return value;
};

const buildCursorKey = (
  cursor: CursorInput,
  table: AnyTable,
  columnNames: readonly string[],
): readonly unknown[] | undefined => {
  if (!cursor) {
    return undefined;
  }

  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;

  return columnNames.map((columnName) => {
    const column = table.columns[columnName];
    if (!column) {
      throw new Error(`Column "${columnName}" not found on table "${table.ormName}".`);
    }

    const rawValue = resolveCursorValue(cursorObj.indexValues[column.ormName], column);
    if (rawValue === undefined) {
      return undefined;
    }

    const deserialized = cursorSerializer.deserialize(rawValue, column);
    return normalizeIndexValue(deserialized, column);
  });
};

const findRows = (
  op: Extract<RetrievalOperation<AnySchema>, { type: "find" }>,
  namespaceStore: InMemoryNamespaceStore,
  tableStore: InMemoryTableStore,
  now: () => Date,
): InMemoryRow[] => {
  const table = op.table;
  const orderByIndex = op.options.orderByIndex;
  const orderIndexName = orderByIndex?.indexName ?? op.indexName;
  const orderIndex = tableStore.indexes.get(orderIndexName);
  if (!orderIndex) {
    throw new Error(`Missing in-memory index "${orderIndexName}" on table "${table.ormName}".`);
  }
  const direction = orderByIndex?.direction ?? "asc";
  const afterKey = buildCursorKey(op.options.after, table, orderIndex.definition.columnNames);
  const beforeKey = buildCursorKey(op.options.before, table, orderIndex.definition.columnNames);
  const limit =
    op.withCursor && op.options.pageSize !== undefined
      ? op.options.pageSize + 1
      : op.options.pageSize;

  const scanOptions = {
    direction,
    limit,
    start: undefined as readonly unknown[] | undefined,
    startInclusive: true,
    end: undefined as readonly unknown[] | undefined,
    endInclusive: true,
  };

  if (afterKey) {
    if (direction === "asc") {
      scanOptions.start = afterKey;
      scanOptions.startInclusive = false;
    } else {
      scanOptions.end = afterKey;
      scanOptions.endInclusive = false;
    }
  }

  if (beforeKey) {
    if (direction === "asc") {
      scanOptions.end = beforeKey;
      scanOptions.endInclusive = false;
    } else {
      scanOptions.start = beforeKey;
      scanOptions.startInclusive = false;
    }
  }

  const entries = orderIndex.index.scan(scanOptions);

  const whereResult = op.options.where
    ? buildCondition(table.columns, op.options.where)
    : undefined;

  if (whereResult === false) {
    return [];
  }

  const condition = whereResult === true ? undefined : whereResult;
  const results: InMemoryRow[] = [];

  for (const entry of entries) {
    const row = tableStore.rows.get(entry.value);
    if (!row) {
      continue;
    }
    if (condition && !evaluateCondition(condition, table, row, namespaceStore, now)) {
      continue;
    }

    const baseOutput = selectRow(
      row,
      table,
      op.options.select as readonly string[] | true | undefined,
    );

    if (op.options.joins && op.options.joins.length > 0) {
      const joined = applyJoins(baseOutput, row, table, op.options.joins, namespaceStore, now);
      for (const joinedRow of joined) {
        results.push(joinedRow);
        if (limit !== undefined && results.length >= limit) {
          break;
        }
      }
    } else {
      results.push(baseOutput);
    }

    if (limit !== undefined && results.length >= limit) {
      break;
    }
  }

  return results;
};

const countRows = (
  op: Extract<RetrievalOperation<AnySchema>, { type: "count" }>,
  namespaceStore: InMemoryNamespaceStore,
  tableStore: InMemoryTableStore,
  now: () => Date,
): number => {
  const table = op.table;
  const whereResult = op.options.where
    ? buildCondition(table.columns, op.options.where)
    : undefined;

  if (whereResult === false) {
    return 0;
  }

  const condition = whereResult === true ? undefined : whereResult;
  let count = 0;

  for (const row of tableStore.rows.values()) {
    if (condition && !evaluateCondition(condition, table, row, namespaceStore, now)) {
      continue;
    }
    count += 1;
  }

  return count;
};

const resolveDbNowValue = (value: unknown, options: ResolvedInMemoryAdapterOptions): unknown =>
  isDbNow(value) ? options.clock.now() : value;

const createRow = (
  op: Extract<MutationOperation<AnySchema>, { type: "create" }>,
  namespaceStore: InMemoryNamespaceStore,
  tableStore: InMemoryTableStore,
  options: ResolvedInMemoryAdapterOptions,
): bigint => {
  const table = op.schema.tables[op.table];
  if (!table) {
    throw new Error(`Invalid table name ${op.table}.`);
  }

  const encoded = encodeValuesWithDbDefaults(op.values, table, {
    now: options.clock.now,
    createId: options.idGenerator,
  });
  const resolvedValues = options.enforceConstraints
    ? resolveReferenceSubqueriesOrThrow(namespaceStore, table, encoded)
    : resolveReferenceSubqueries(namespaceStore, encoded);

  const row: InMemoryRow = {};
  for (const columnName of Object.keys(table.columns)) {
    const column = table.columns[columnName];
    if (!column || column.role === "internal-id") {
      continue;
    }

    const value = resolvedValues[column.name];
    if (value === undefined) {
      if (column.isNullable) {
        row[column.name] = null;
        continue;
      }

      if (column.role === "version") {
        row[column.name] = 0;
        continue;
      }

      throw new Error(`Missing required value for column "${column.ormName}".`);
    }

    row[column.name] = resolveDbNowValue(value, options);
  }

  const internalId = options.internalIdGeneratorProvided
    ? options.internalIdGenerator()
    : tableStore.nextInternalId;
  if (!options.internalIdGeneratorProvided) {
    tableStore.nextInternalId += 1n;
  }

  row["_internalId"] = internalId;
  row["_version"] = row["_version"] ?? 0;

  if (options.enforceConstraints) {
    enforceOutgoingForeignKeys(namespaceStore, table, row);
  }

  tableStore.rows.set(internalId, row);

  for (const indexStore of tableStore.indexes.values()) {
    const key = buildIndexKey(table, indexStore.definition, row);
    indexStore.index.insert(key, internalId, { enforceUnique: options.enforceConstraints });
  }

  return internalId;
};

const updateRow = (
  op: Extract<MutationOperation<AnySchema>, { type: "update" }>,
  namespaceStore: InMemoryNamespaceStore,
  tableStore: InMemoryTableStore,
  options: ResolvedInMemoryAdapterOptions,
): (() => void) | null => {
  const table = op.schema.tables[op.table];
  if (!table) {
    throw new Error(`Invalid table name ${op.table}.`);
  }

  const externalId = getExternalId(op.id);
  const versionToCheck = getVersionToCheck(op.id, op.checkVersion);
  const existing = findRowByExternalId(tableStore, table, externalId);
  if (!existing) {
    if (versionToCheck !== undefined) {
      throw new VersionConflictError(`Version conflict: row "${externalId}" not found.`);
    }
    return null;
  }

  const currentVersion = Number(existing.row["_version"] ?? 0);
  if (versionToCheck !== undefined && currentVersion !== versionToCheck) {
    throw new VersionConflictError(`Version conflict: row "${externalId}" has changed.`);
  }

  const encoded = encodeValues(op.set as Record<string, unknown>, table, false);
  const resolvedValues = options.enforceConstraints
    ? resolveReferenceSubqueriesOrThrow(namespaceStore, table, encoded)
    : resolveReferenceSubqueries(namespaceStore, encoded);

  const resolvedUpdateValues: InMemoryRow = {};
  for (const [columnName, value] of Object.entries(resolvedValues)) {
    resolvedUpdateValues[columnName] = resolveDbNowValue(value, options);
  }

  const updatedRow: InMemoryRow = { ...existing.row, ...resolvedUpdateValues };
  updatedRow["_version"] = currentVersion + 1;

  if (options.enforceConstraints) {
    enforceOutgoingForeignKeys(
      namespaceStore,
      table,
      updatedRow,
      new Set(Object.keys(resolvedValues)),
    );
  }

  const indexUpdates = Array.from(tableStore.indexes.values()).map((indexStore) => ({
    indexStore,
    oldKey: buildIndexKey(table, indexStore.definition, existing.row),
    newKey: buildIndexKey(table, indexStore.definition, updatedRow),
  }));

  const applied: typeof indexUpdates = [];
  try {
    for (const update of indexUpdates) {
      update.indexStore.index.update(update.oldKey, update.newKey, existing.internalId, {
        enforceUnique: options.enforceConstraints,
      });
      applied.push(update);
    }
  } catch (error) {
    for (const update of applied.reverse()) {
      update.indexStore.index.update(update.newKey, update.oldKey, existing.internalId, {
        enforceUnique: options.enforceConstraints,
      });
    }
    throw error;
  }

  tableStore.rows.set(existing.internalId, updatedRow);

  return () => {
    for (const update of indexUpdates.slice().reverse()) {
      update.indexStore.index.update(update.newKey, update.oldKey, existing.internalId, {
        enforceUnique: options.enforceConstraints,
      });
    }
    tableStore.rows.set(existing.internalId, existing.row);
  };
};

const deleteRow = (
  op: Extract<MutationOperation<AnySchema>, { type: "delete" }>,
  namespaceStore: InMemoryNamespaceStore,
  tableStore: InMemoryTableStore,
  table: AnyTable,
  options: ResolvedInMemoryAdapterOptions,
): (() => void) | null => {
  const externalId = getExternalId(op.id);
  const versionToCheck = getVersionToCheck(op.id, op.checkVersion);
  const existing = findRowByExternalId(tableStore, table, externalId);
  if (!existing) {
    if (versionToCheck !== undefined) {
      throw new VersionConflictError(`Version conflict: row "${externalId}" not found.`);
    }
    return null;
  }

  const currentVersion = Number(existing.row["_version"] ?? 0);
  if (versionToCheck !== undefined && currentVersion !== versionToCheck) {
    throw new VersionConflictError(`Version conflict: row "${externalId}" has changed.`);
  }

  if (options.enforceConstraints) {
    enforceNoIncomingForeignKeys(namespaceStore, op.schema, table, existing.row);
  }

  const indexEntries = Array.from(tableStore.indexes.values()).map((indexStore) => ({
    indexStore,
    key: buildIndexKey(table, indexStore.definition, existing.row),
  }));

  const removedEntries: typeof indexEntries = [];
  for (const entry of indexEntries) {
    const removed = entry.indexStore.index.remove(entry.key, existing.internalId);
    if (!removed) {
      for (const removedEntry of removedEntries) {
        removedEntry.indexStore.index.insert(removedEntry.key, existing.internalId, {
          enforceUnique: options.enforceConstraints,
        });
      }
      throw new Error("Failed to remove index entry during delete.");
    }
    removedEntries.push(entry);
  }

  tableStore.rows.delete(existing.internalId);

  return () => {
    tableStore.rows.set(existing.internalId, existing.row);
    for (const entry of indexEntries) {
      entry.indexStore.index.insert(entry.key, existing.internalId, {
        enforceUnique: options.enforceConstraints,
      });
    }
  };
};

const checkRow = (
  op: Extract<MutationOperation<AnySchema>, { type: "check" }>,
  tableStore: InMemoryTableStore,
  table: AnyTable,
): void => {
  const existing = findRowByExternalId(tableStore, table, op.id.externalId);
  if (!existing) {
    throw new VersionConflictError(`Version conflict: row "${op.id.externalId}" not found.`);
  }

  const currentVersion = Number(existing.row["_version"] ?? 0);
  if (currentVersion !== op.id.version) {
    throw new VersionConflictError(`Version conflict: row "${op.id.externalId}" has changed.`);
  }
};

export const createInMemoryUowCompiler = (): UOWCompiler<InMemoryCompiledQuery> => ({
  compileRetrievalOperation(op: RetrievalOperation<AnySchema>): InMemoryCompiledQuery | null {
    return op;
  },
  compileMutationOperation(
    op: MutationOperation<AnySchema>,
  ): CompiledMutation<InMemoryCompiledQuery> | null {
    return {
      query: op,
      operation: op,
      op: op.type,
      expectedAffectedRows: null,
      expectedReturnedRows: null,
    };
  },
});

export const createInMemoryUowExecutor = (
  store: InMemoryStore,
  options: ResolvedInMemoryAdapterOptions,
): UOWExecutor<InMemoryCompiledQuery, InMemoryRawResult> => ({
  async executeRetrievalPhase(
    retrievalBatch: InMemoryCompiledQuery[],
  ): Promise<InMemoryRawResult[]> {
    const results: InMemoryRawResult[] = [];

    for (const compiled of retrievalBatch) {
      if (compiled.type === "count" || compiled.type === "find") {
        const namespaceStore = getNamespaceStore(store, compiled);
        const tableStore = getTableStore(namespaceStore, compiled.table.ormName);

        if (compiled.type === "find") {
          results.push(findRows(compiled, namespaceStore, tableStore, options.clock.now));
        } else {
          results.push([
            { count: countRows(compiled, namespaceStore, tableStore, options.clock.now) },
          ]);
        }
        continue;
      }

      throw new Error(`Unsupported in-memory retrieval operation: ${compiled.type}`);
    }

    return results;
  },

  async executeMutationPhase(
    mutationBatch: CompiledMutation<InMemoryCompiledQuery>[],
  ): Promise<MutationResult> {
    const createdInternalIds: (bigint | null)[] = [];
    const rollbackActions: Array<() => void> = [];

    try {
      for (const compiled of mutationBatch) {
        const operation = compiled.query;

        if (operation.type === "create") {
          const namespaceStore = getNamespaceStore(store, operation);
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, operation.table);
          const previousInternalId = tableStore.nextInternalId;
          const internalId = createRow(operation, namespaceStore, tableStore, options);
          createdInternalIds.push(internalId);
          rollbackActions.push(() => {
            const row = tableStore.rows.get(internalId);
            if (row) {
              for (const indexStore of tableStore.indexes.values()) {
                const key = buildIndexKey(table, indexStore.definition, row);
                indexStore.index.remove(key, internalId);
              }
              tableStore.rows.delete(internalId);
            }
            tableStore.nextInternalId = previousInternalId;
          });
          continue;
        }

        if (operation.type === "update") {
          const namespaceStore = getNamespaceStore(store, operation);
          const tableStore = getTableStore(namespaceStore, operation.table);
          const rollback = updateRow(operation, namespaceStore, tableStore, options);
          if (rollback) {
            rollbackActions.push(rollback);
          }
          continue;
        }

        if (operation.type === "delete") {
          const namespaceStore = getNamespaceStore(store, operation);
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, operation.table);
          const rollback = deleteRow(operation, namespaceStore, tableStore, table, options);
          if (rollback) {
            rollbackActions.push(rollback);
          }
          continue;
        }

        if (operation.type === "check") {
          const namespaceStore = getNamespaceStore(store, operation);
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, operation.table);
          checkRow(operation, tableStore, table);
          continue;
        }

        throw new Error(`Unsupported in-memory mutation "${operation.type}".`);
      }
    } catch (error) {
      for (const rollback of rollbackActions.reverse()) {
        rollback();
      }
      if (error instanceof VersionConflictError) {
        return { success: false };
      }
      throw error;
    }

    return { success: true, createdInternalIds };
  },
});

export class InMemoryUowDecoder implements UOWDecoder<InMemoryRawResult> {
  decode(rawResults: InMemoryRawResult[], operations: RetrievalOperation<AnySchema>[]): unknown[] {
    if (rawResults.length !== operations.length) {
      throw new Error("rawResults and ops must have the same length");
    }

    return rawResults.map((result, index) => {
      const op = operations[index];
      if (!op) {
        throw new Error("op must be defined");
      }

      if (op.type === "count") {
        return this.decodeCount(result);
      }

      const rows = result as InMemoryRow[];
      const decodedRows = rows.map((row) => this.decodeRow(row, op.table));

      if (op.withCursor) {
        return this.decodeCursorResult(decodedRows, op.table, op);
      }

      return decodedRows;
    });
  }

  private decodeCount(result: InMemoryRawResult): number {
    if (typeof result === "number") {
      return result;
    }

    const rows = result as { count: number }[];
    const first = rows[0];
    if (!first) {
      return 0;
    }
    const count = Number(first.count);
    if (Number.isNaN(count)) {
      throw new Error(`Unexpected result for count, received: ${first.count}`);
    }
    return count;
  }

  private decodeRow(row: InMemoryRow, table: AnyTable): Record<string, unknown> {
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
      output[relationName] = this.decodeRow(relationData[relationName], relation.table);
    }

    for (const key in columnValues) {
      const column = table.columns[key];
      if (!column) {
        continue;
      }
      if (column.isHidden) {
        continue;
      }

      if (column.role === "external-id" && columnValues["_internalId"] !== undefined) {
        output[key] = new FragnoId({
          externalId: columnValues[key] as string,
          internalId: columnValues["_internalId"] as bigint,
          version: columnValues["_version"] as number,
        });
        continue;
      }

      if (column.role === "reference") {
        const value = columnValues[key];
        output[key] =
          value === null || value === undefined
            ? null
            : FragnoReference.fromInternal(value as bigint);
        continue;
      }

      output[key] = columnValues[key];
    }

    return output;
  }

  private decodeCursorResult(
    decodedRows: Record<string, unknown>[],
    table: AnyTable,
    operation: Extract<RetrievalOperation<AnySchema>, { type: "find" }>,
  ): CursorResult<unknown> {
    let cursor: Cursor | undefined;
    let hasNextPage = false;
    let items = decodedRows;

    if (
      operation.options.pageSize &&
      operation.options.pageSize > 0 &&
      decodedRows.length > operation.options.pageSize
    ) {
      hasNextPage = true;
      items = decodedRows.slice(0, operation.options.pageSize);

      if (operation.options.orderByIndex) {
        const lastItem = items[items.length - 1];
        const indexName = operation.options.orderByIndex.indexName;

        let indexColumns;
        if (indexName === "_primary") {
          indexColumns = [table.getIdColumn()];
        } else {
          const index = table.indexes[indexName];
          if (index) {
            indexColumns = index.columns;
          }
        }

        if (indexColumns && lastItem) {
          cursor = createCursorFromRecord(lastItem, indexColumns, {
            indexName: operation.options.orderByIndex.indexName,
            orderDirection: operation.options.orderByIndex.direction,
            pageSize: operation.options.pageSize,
          });
        }
      }
    }

    return {
      items,
      cursor,
      hasNextPage,
    };
  }
}
