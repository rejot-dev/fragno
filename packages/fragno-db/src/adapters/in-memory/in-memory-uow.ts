import type { AnySchema, AnyTable } from "../../schema/create";
import { FragnoId, FragnoReference } from "../../schema/create";
import superjson from "superjson";
import { SQLocalDriverConfig } from "../generic-sql/driver-config";
import {
  SETTINGS_NAMESPACE,
  SETTINGS_TABLE_NAME,
  internalSchema,
} from "../../fragments/internal-fragment";
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
import {
  type OutboxRefLookup,
  type OutboxRefMap,
  encodeVersionstamp,
  parseOutboxVersionValue,
} from "../../outbox/outbox";
import { buildOutboxPlan, finalizeOutboxPayload } from "../../outbox/outbox-builder";
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
import type { NamingResolver } from "../../naming/sql-naming";

type InMemoryCompiledQuery = RetrievalOperation<AnySchema> | MutationOperation<AnySchema>;
type InMemoryRawResult = InMemoryRow[] | { count: number }[];
type CursorInput = string | Cursor | undefined;
type ResolverFactory = (schema: AnySchema, namespace: string | null) => NamingResolver;
type SchemaNamespaceEntry = { schema: AnySchema; namespace: string | null };

const OUTBOX_VERSION_KEY = `${SETTINGS_NAMESPACE}.outbox_version`;

const getResolver = (
  schema: AnySchema,
  namespace: string | null | undefined,
  resolverFactory?: ResolverFactory,
) => (resolverFactory ? resolverFactory(schema, namespace ?? null) : undefined);

const getPhysicalTableName = (table: AnyTable, resolver?: NamingResolver) =>
  resolver ? resolver.getTableName(table.name) : table.name;

const getPhysicalColumnName = (table: AnyTable, columnName: string, resolver?: NamingResolver) =>
  resolver ? resolver.getColumnName(table.name, columnName) : columnName;

const cursorSerializer = createSQLSerializer(new SQLocalDriverConfig());

class VersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionConflictError";
  }
}

const getNamespaceStore = (
  store: InMemoryStore,
  schema: AnySchema,
  namespace: string | null | undefined,
  resolver?: NamingResolver,
): InMemoryNamespaceStore => {
  const namespaceKey = namespace ?? schema.name;
  return ensureNamespaceStore(store, namespaceKey, schema, resolver);
};

const getTableStore = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
  resolver?: NamingResolver,
): InMemoryTableStore => {
  const physicalTableName = getPhysicalTableName(table, resolver);
  const tableStore = namespaceStore.tables.get(physicalTableName);
  if (!tableStore) {
    throw new Error(`Missing in-memory table store for "${physicalTableName}".`);
  }
  return tableStore;
};

const buildSelection = (
  table: AnyTable,
  select: undefined | true | readonly string[],
  _resolver?: NamingResolver,
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
  resolver?: NamingResolver,
): InMemoryRow => {
  const selection = buildSelection(table, select, resolver);
  const selected: InMemoryRow = {};
  for (const columnName of selection) {
    const physicalColumnName = getPhysicalColumnName(table, columnName, resolver);
    if (Object.prototype.hasOwnProperty.call(row, physicalColumnName)) {
      selected[columnName] = row[physicalColumnName];
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
  resolver?: NamingResolver,
): InMemoryRow => {
  const selected = selectRow(row, table, select, resolver);
  const prefixed: InMemoryRow = {};

  for (const key in selected) {
    prefixed[`${prefix}:${key}`] = selected[key];
  }

  return prefixed;
};

const orderRows = (
  rows: InMemoryRow[],
  orderBy: [AnyTable["columns"][string], "asc" | "desc"][] | undefined,
  resolver?: NamingResolver,
): InMemoryRow[] => {
  if (!orderBy || orderBy.length === 0) {
    return rows;
  }

  return rows.slice().sort((left, right) => {
    for (const [column, direction] of orderBy) {
      const columnName = resolver
        ? resolver.getColumnName(column.tableName, column.name)
        : column.name;
      const leftValue = normalizeIndexValue(left[columnName], column);
      const rightValue = normalizeIndexValue(right[columnName], column);
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
  resolver?: NamingResolver,
): void => {
  if (!orderBy || orderBy.length === 0) {
    return;
  }

  const direction = orderBy[0][1];
  if (!orderBy.every(([, dir]) => dir === direction)) {
    throw new Error(
      `In-memory adapter only supports orderByIndex; mixed orderBy directions found on table "${table.name}".`,
    );
  }

  const orderColumnNames = orderBy.map(([column]) =>
    resolver ? resolver.getColumnName(table.name, column.name) : column.name,
  );
  const idColumnName = resolver
    ? resolver.getColumnName(table.name, table.getIdColumn().name)
    : table.getIdColumn().name;
  if (orderColumnNames.length === 1 && orderColumnNames[0] === idColumnName) {
    return;
  }

  for (const index of Object.values(table.indexes)) {
    const indexColumnNames = (index.columnNames as readonly string[]).map((columnName) =>
      resolver ? resolver.getColumnName(table.name, columnName) : columnName,
    );
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
    `In-memory adapter only supports orderByIndex; received orderBy on table "${table.name}".`,
  );
};

const findJoinMatches = (
  parentRow: InMemoryRow,
  parentTable: AnyTable,
  join: CompiledJoin,
  namespaceStore: InMemoryNamespaceStore,
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): InMemoryRow[] => {
  const { relation, options } = join;
  if (options === false) {
    return [];
  }

  const targetTable = relation.table;
  const targetStore = getTableStore(namespaceStore, targetTable, resolver);
  const matches: InMemoryRow[] = [];

  assertOrderByIndexOnly(targetTable, options.orderBy, resolver);

  for (const row of targetStore.rows.values()) {
    let matchesJoin = true;

    for (const [left, right] of relation.on) {
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

      const leftValue = parentRow[getPhysicalColumnName(parentTable, left, resolver)];
      const rightValue = row[getPhysicalColumnName(targetTable, actualRight, resolver)];
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

    if (
      options.where &&
      !evaluateCondition(options.where, targetTable, row, namespaceStore, resolver, now)
    ) {
      continue;
    }

    matches.push(row);
  }

  const ordered = orderRows(matches, options.orderBy, resolver);
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
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
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
      const matches = findJoinMatches(parentRow, parentTable, join, namespaceStore, resolver, now);

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
          resolver,
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
              resolver,
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
  resolver?: NamingResolver,
): Record<string, unknown> => {
  const resolved = resolveReferenceSubqueries(namespaceStore, encodedValues, resolver);
  for (const [key, value] of Object.entries(encodedValues)) {
    if (!(value instanceof ReferenceSubquery)) {
      continue;
    }

    if (resolved[key] === null || resolved[key] === undefined) {
      throw new Error(
        `Foreign key constraint violation on table "${table.name}" for column "${key}".`,
      );
    }
  }
  return resolved;
};

const getReferencedColumn = (
  table: AnyTable,
  columnName: string,
  resolver?: NamingResolver,
): { name: string; column: AnyTable["columns"][string] } => {
  const column = table.columns[columnName];
  if (!column) {
    throw new Error(`Column "${columnName}" not found on table "${table.name}".`);
  }

  const actualName = column.role === "external-id" ? "_internalId" : columnName;
  const actualColumn = table.columns[actualName];
  if (!actualColumn) {
    throw new Error(`Column "${actualName}" not found on table "${table.name}".`);
  }

  return {
    name: getPhysicalColumnName(table, actualName, resolver),
    column: actualColumn,
  };
};

const enforceOutgoingForeignKeys = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
  row: InMemoryRow,
  columnsToCheck?: Set<string>,
  resolver?: NamingResolver,
): void => {
  for (const relation of Object.values(table.relations)) {
    if (relation.type !== "one") {
      continue;
    }

    const localColumnNames = relation.on.map(([local]) => local);
    if (columnsToCheck && !localColumnNames.some((name) => columnsToCheck.has(name))) {
      continue;
    }

    const localValues = localColumnNames.map(
      (name) => row[getPhysicalColumnName(table, name, resolver)],
    );
    if (localValues.some((value) => value === null || value === undefined)) {
      continue;
    }

    const referencedTable = relation.table;
    const referencedStore = getTableStore(namespaceStore, referencedTable, resolver);
    let foundMatch = false;

    for (const targetRow of referencedStore.rows.values()) {
      let matches = true;
      for (const [localName, foreignName] of relation.on) {
        if (!table.columns[localName]) {
          throw new Error(`Column "${localName}" not found on table "${table.name}".`);
        }

        const { name: actualForeignName, column: foreignColumn } = getReferencedColumn(
          referencedTable,
          foreignName,
          resolver,
        );
        const localValue = row[getPhysicalColumnName(table, localName, resolver)];
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
        `Foreign key constraint violation on table "${table.name}" for relation "${relation.name}".`,
      );
    }
  }
};

const enforceNoIncomingForeignKeys = (
  namespaceStore: InMemoryNamespaceStore,
  schema: AnySchema,
  table: AnyTable,
  row: InMemoryRow,
  resolver?: NamingResolver,
): void => {
  for (const sourceTable of Object.values(schema.tables)) {
    for (const relation of Object.values(sourceTable.relations)) {
      if (relation.type !== "one") {
        continue;
      }

      if (relation.table.name !== table.name) {
        continue;
      }

      const sourceStore = getTableStore(namespaceStore, sourceTable, resolver);
      const targetColumnInfo = relation.on.map(([, foreignName]) =>
        getReferencedColumn(table, foreignName, resolver),
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
          const localValue = sourceRow[getPhysicalColumnName(sourceTable, localName, resolver)];
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
            `Foreign key constraint violation on table "${table.name}" for relation "${relation.name}".`,
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
  resolver?: NamingResolver,
): { internalId: bigint; row: InMemoryRow } | undefined => {
  const idColumn = table.getIdColumn();
  const idColumnName = getPhysicalColumnName(table, idColumn.name, resolver);
  for (const [internalId, row] of tableStore.rows) {
    if (row[idColumnName] === externalId) {
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
  resolver?: NamingResolver,
): readonly unknown[] | undefined => {
  if (!cursor) {
    return undefined;
  }

  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;

  const columnMap = resolver ? resolver.getColumnNameMap(table) : undefined;

  return columnNames.map((columnName) => {
    const logicalName = columnMap?.[columnName] ?? columnName;
    const column = table.columns[logicalName];
    if (!column) {
      throw new Error(`Column "${logicalName}" not found on table "${table.name}".`);
    }

    const rawValue = resolveCursorValue(cursorObj.indexValues[column.name], column);
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
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
): InMemoryRow[] => {
  const table = op.table;
  const orderByIndex = op.options.orderByIndex;
  const orderIndexName = orderByIndex?.indexName ?? op.indexName;
  const orderIndex = tableStore.indexes.get(orderIndexName);
  if (!orderIndex) {
    throw new Error(`Missing in-memory index "${orderIndexName}" on table "${table.name}".`);
  }
  const direction = orderByIndex?.direction ?? "asc";
  const afterKey = buildCursorKey(
    op.options.after,
    table,
    orderIndex.definition.columnNames,
    resolver,
  );
  const beforeKey = buildCursorKey(
    op.options.before,
    table,
    orderIndex.definition.columnNames,
    resolver,
  );
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
    if (condition && !evaluateCondition(condition, table, row, namespaceStore, resolver, now)) {
      continue;
    }

    const baseOutput = selectRow(
      row,
      table,
      op.options.select as readonly string[] | true | undefined,
      resolver,
    );

    if (op.options.joins && op.options.joins.length > 0) {
      const joined = applyJoins(
        baseOutput,
        row,
        table,
        op.options.joins,
        namespaceStore,
        resolver,
        now,
      );
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
  resolver?: NamingResolver,
  now: () => Date = () => new Date(),
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
    if (condition && !evaluateCondition(condition, table, row, namespaceStore, resolver, now)) {
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
  resolver?: NamingResolver,
): bigint => {
  const table = op.schema.tables[op.table];
  if (!table) {
    throw new Error(`Invalid table name ${op.table}.`);
  }

  const encoded = encodeValuesWithDbDefaults(
    op.values,
    table,
    {
      now: options.clock.now,
      createId: options.idGenerator,
    },
    resolver,
  );
  const resolvedValues = options.enforceConstraints
    ? resolveReferenceSubqueriesOrThrow(namespaceStore, table, encoded, resolver)
    : resolveReferenceSubqueries(namespaceStore, encoded, resolver);

  const row: InMemoryRow = {};
  for (const columnName of Object.keys(table.columns)) {
    const column = table.columns[columnName];
    if (!column || column.role === "internal-id") {
      continue;
    }

    const physicalColumnName = getPhysicalColumnName(table, column.name, resolver);
    const value = resolvedValues[physicalColumnName];
    if (value === undefined) {
      if (column.isNullable) {
        row[physicalColumnName] = null;
        continue;
      }

      if (column.role === "version") {
        row[physicalColumnName] = 0;
        continue;
      }

      throw new Error(`Missing required value for column "${column.name}".`);
    }

    row[physicalColumnName] = resolveDbNowValue(value, options);
  }

  const internalId = options.internalIdGeneratorProvided
    ? options.internalIdGenerator()
    : tableStore.nextInternalId;
  if (!options.internalIdGeneratorProvided) {
    tableStore.nextInternalId += 1n;
  }

  const internalIdColumnName = getPhysicalColumnName(table, "_internalId", resolver);
  const versionColumnName = getPhysicalColumnName(table, "_version", resolver);
  row[internalIdColumnName] = internalId;
  row[versionColumnName] = row[versionColumnName] ?? 0;

  if (options.enforceConstraints) {
    enforceOutgoingForeignKeys(namespaceStore, table, row, undefined, resolver);
  }

  tableStore.rows.set(internalId, row);

  for (const indexStore of tableStore.indexes.values()) {
    const key = buildIndexKey(table, indexStore.definition, row, resolver);
    indexStore.index.insert(key, internalId, { enforceUnique: options.enforceConstraints });
  }

  return internalId;
};

const updateRow = (
  op: Extract<MutationOperation<AnySchema>, { type: "update" }>,
  namespaceStore: InMemoryNamespaceStore,
  tableStore: InMemoryTableStore,
  options: ResolvedInMemoryAdapterOptions,
  resolver?: NamingResolver,
): (() => void) | null => {
  const table = op.schema.tables[op.table];
  if (!table) {
    throw new Error(`Invalid table name ${op.table}.`);
  }

  const externalId = getExternalId(op.id);
  const versionToCheck = getVersionToCheck(op.id, op.checkVersion);
  const existing = findRowByExternalId(tableStore, table, externalId, resolver);
  if (!existing) {
    if (versionToCheck !== undefined) {
      throw new VersionConflictError(`Version conflict: row "${externalId}" not found.`);
    }
    return null;
  }

  const versionColumnName = getPhysicalColumnName(table, "_version", resolver);
  const currentVersion = Number(existing.row[versionColumnName] ?? 0);
  if (versionToCheck !== undefined && currentVersion !== versionToCheck) {
    throw new VersionConflictError(`Version conflict: row "${externalId}" has changed.`);
  }

  const encoded = encodeValues(op.set as Record<string, unknown>, table, false, {}, resolver);
  const resolvedValues = options.enforceConstraints
    ? resolveReferenceSubqueriesOrThrow(namespaceStore, table, encoded, resolver)
    : resolveReferenceSubqueries(namespaceStore, encoded, resolver);

  const resolvedUpdateValues: InMemoryRow = {};
  for (const [columnName, value] of Object.entries(resolvedValues)) {
    resolvedUpdateValues[columnName] = resolveDbNowValue(value, options);
  }

  const updatedRow: InMemoryRow = { ...existing.row, ...resolvedUpdateValues };
  updatedRow[versionColumnName] = currentVersion + 1;

  if (options.enforceConstraints) {
    enforceOutgoingForeignKeys(
      namespaceStore,
      table,
      updatedRow,
      new Set(Object.keys(resolvedValues)),
      resolver,
    );
  }

  const indexUpdates = Array.from(tableStore.indexes.values()).map((indexStore) => ({
    indexStore,
    oldKey: buildIndexKey(table, indexStore.definition, existing.row, resolver),
    newKey: buildIndexKey(table, indexStore.definition, updatedRow, resolver),
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
  resolver?: NamingResolver,
): (() => void) | null => {
  const externalId = getExternalId(op.id);
  const versionToCheck = getVersionToCheck(op.id, op.checkVersion);
  const existing = findRowByExternalId(tableStore, table, externalId, resolver);
  if (!existing) {
    if (versionToCheck !== undefined) {
      throw new VersionConflictError(`Version conflict: row "${externalId}" not found.`);
    }
    return null;
  }

  const versionColumnName = getPhysicalColumnName(table, "_version", resolver);
  const currentVersion = Number(existing.row[versionColumnName] ?? 0);
  if (versionToCheck !== undefined && currentVersion !== versionToCheck) {
    throw new VersionConflictError(`Version conflict: row "${externalId}" has changed.`);
  }

  if (options.enforceConstraints) {
    enforceNoIncomingForeignKeys(namespaceStore, op.schema, table, existing.row, resolver);
  }

  const indexEntries = Array.from(tableStore.indexes.values()).map((indexStore) => ({
    indexStore,
    key: buildIndexKey(table, indexStore.definition, existing.row, resolver),
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
  resolver?: NamingResolver,
): void => {
  const existing = findRowByExternalId(tableStore, table, op.id.externalId, resolver);
  if (!existing) {
    throw new VersionConflictError(`Version conflict: row "${op.id.externalId}" not found.`);
  }

  const versionColumnName = getPhysicalColumnName(table, "_version", resolver);
  const currentVersion = Number(existing.row[versionColumnName] ?? 0);
  if (currentVersion !== op.id.version) {
    throw new VersionConflictError(`Version conflict: row "${op.id.externalId}" has changed.`);
  }
};

const resolveSchemaForLookup = (
  table: AnyTable,
  namespace: string | undefined,
  schemaByNamespace?: Map<string, SchemaNamespaceEntry>,
): SchemaNamespaceEntry | null => {
  if (!schemaByNamespace) {
    return null;
  }

  if (namespace !== undefined) {
    const entry = schemaByNamespace.get(namespace);
    if (entry && entry.schema.tables[table.name] === table) {
      return entry;
    }
    return null;
  }

  for (const entry of schemaByNamespace.values()) {
    if (entry.schema.tables[table.name] === table) {
      return entry;
    }
  }

  return null;
};

const reserveOutboxVersion = (
  store: InMemoryStore,
  options: ResolvedInMemoryAdapterOptions,
  resolverFactory?: ResolverFactory,
): { version: bigint; rollback: () => void } => {
  const resolver = getResolver(internalSchema, null, resolverFactory);
  const namespaceStore = getNamespaceStore(store, internalSchema, null, resolver);
  const settingsTable = internalSchema.tables[SETTINGS_TABLE_NAME];
  if (!settingsTable) {
    throw new Error("Missing internal settings table definition.");
  }
  const tableStore = getTableStore(namespaceStore, settingsTable, resolver);
  const keyColumnName = getPhysicalColumnName(settingsTable, "key", resolver);
  const valueColumnName = getPhysicalColumnName(settingsTable, "value", resolver);
  const idColumnName = getPhysicalColumnName(
    settingsTable,
    settingsTable.getIdColumn().name,
    resolver,
  );

  for (const row of tableStore.rows.values()) {
    if (row[keyColumnName] !== OUTBOX_VERSION_KEY) {
      continue;
    }

    const rawValue = row[valueColumnName];
    const current = parseOutboxVersionValue(rawValue);
    const next = current + 1n;
    const externalId = row[idColumnName];
    if (typeof externalId !== "string") {
      throw new Error("Outbox version row is missing external id.");
    }

    const updateOp: Extract<MutationOperation<AnySchema>, { type: "update" }> = {
      type: "update",
      schema: internalSchema,
      namespace: null,
      table: settingsTable.name,
      id: externalId,
      checkVersion: false,
      set: { value: next.toString() },
    };
    const rollback = updateRow(updateOp, namespaceStore, tableStore, options, resolver);
    return { version: next, rollback: rollback ?? (() => {}) };
  }

  const createOp: Extract<MutationOperation<AnySchema>, { type: "create" }> = {
    type: "create",
    schema: internalSchema,
    namespace: null,
    table: settingsTable.name,
    values: { key: OUTBOX_VERSION_KEY, value: "0" },
    generatedExternalId: options.idGenerator(),
  };
  const previousInternalId = tableStore.nextInternalId;
  const internalId = createRow(createOp, namespaceStore, tableStore, options, resolver);
  const rollback = () => {
    const existingRow = tableStore.rows.get(internalId);
    if (existingRow) {
      for (const indexStore of tableStore.indexes.values()) {
        const key = buildIndexKey(settingsTable, indexStore.definition, existingRow, resolver);
        indexStore.index.remove(key, internalId);
      }
      tableStore.rows.delete(internalId);
    }
    tableStore.nextInternalId = previousInternalId;
  };

  return { version: 0n, rollback };
};

const resolveOutboxRefMap = (
  store: InMemoryStore,
  lookups: OutboxRefLookup[],
  resolverFactory: ResolverFactory | undefined,
  schemaByNamespace?: Map<string, SchemaNamespaceEntry>,
): OutboxRefMap | undefined => {
  if (lookups.length === 0) {
    return undefined;
  }

  const refMap: OutboxRefMap = {};

  for (const lookup of lookups) {
    const schemaEntry = resolveSchemaForLookup(lookup.table, lookup.namespace, schemaByNamespace);
    if (!schemaEntry) {
      throw new Error(`Failed to resolve schema for outbox lookup on ${lookup.table.name}.`);
    }

    const resolver = getResolver(schemaEntry.schema, schemaEntry.namespace, resolverFactory);
    const namespaceStore = getNamespaceStore(
      store,
      schemaEntry.schema,
      schemaEntry.namespace,
      resolver,
    );
    const tableStore = getTableStore(namespaceStore, lookup.table, resolver);
    const internalId =
      typeof lookup.internalId === "number" ? BigInt(lookup.internalId) : lookup.internalId;
    const row = tableStore.rows.get(internalId);

    if (!row) {
      const tableName = resolver ? resolver.getTableName(lookup.table.name) : lookup.table.name;
      const internalColumn = resolver
        ? resolver.getColumnName(lookup.table.name, lookup.table.getInternalIdColumn().name)
        : lookup.table.getInternalIdColumn().name;
      throw new Error(
        `Failed to resolve outbox reference for ${tableName}.${internalColumn}=${String(lookup.internalId)}`,
      );
    }

    const externalColumnName = getPhysicalColumnName(
      lookup.table,
      lookup.table.getIdColumn().name,
      resolver,
    );
    const externalId = row[externalColumnName];
    if (typeof externalId !== "string") {
      throw new Error("Outbox reference row is missing external id.");
    }

    refMap[lookup.key] = externalId;
  }

  return Object.keys(refMap).length > 0 ? refMap : undefined;
};

const insertOutboxRow = (
  store: InMemoryStore,
  options: ResolvedInMemoryAdapterOptions,
  resolverFactory: ResolverFactory | undefined,
  payload: {
    versionstamp: Uint8Array;
    uowId: string;
    payload: { json: unknown; meta?: Record<string, unknown> };
    refMap?: OutboxRefMap;
  },
): (() => void) => {
  const resolver = getResolver(internalSchema, null, resolverFactory);
  const namespaceStore = getNamespaceStore(store, internalSchema, null, resolver);
  const outboxTable = internalSchema.tables.fragno_db_outbox;
  if (!outboxTable) {
    throw new Error("Missing internal outbox table definition.");
  }
  const tableStore = getTableStore(namespaceStore, outboxTable, resolver);
  const createOp: Extract<MutationOperation<AnySchema>, { type: "create" }> = {
    type: "create",
    schema: internalSchema,
    namespace: null,
    table: outboxTable.name,
    values: {
      versionstamp: payload.versionstamp,
      uowId: payload.uowId,
      payload: payload.payload,
      ...(payload.refMap ? { refMap: payload.refMap } : {}),
    },
    generatedExternalId: options.idGenerator(),
  };
  const previousInternalId = tableStore.nextInternalId;
  const internalId = createRow(createOp, namespaceStore, tableStore, options, resolver);

  return () => {
    const existingRow = tableStore.rows.get(internalId);
    if (existingRow) {
      for (const indexStore of tableStore.indexes.values()) {
        const key = buildIndexKey(outboxTable, indexStore.definition, existingRow, resolver);
        indexStore.index.remove(key, internalId);
      }
      tableStore.rows.delete(internalId);
    }
    tableStore.nextInternalId = previousInternalId;
  };
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
  resolverFactory?: ResolverFactory,
  schemaByNamespace?: Map<string, SchemaNamespaceEntry>,
): UOWExecutor<InMemoryCompiledQuery, InMemoryRawResult> => ({
  async executeRetrievalPhase(
    retrievalBatch: InMemoryCompiledQuery[],
  ): Promise<InMemoryRawResult[]> {
    const results: InMemoryRawResult[] = [];

    for (const compiled of retrievalBatch) {
      if (compiled.type === "count" || compiled.type === "find") {
        const resolver = getResolver(compiled.schema, compiled.namespace, resolverFactory);
        const namespaceStore = getNamespaceStore(
          store,
          compiled.schema,
          compiled.namespace,
          resolver,
        );
        const tableStore = getTableStore(namespaceStore, compiled.table, resolver);

        if (compiled.type === "find") {
          results.push(findRows(compiled, namespaceStore, tableStore, resolver, options.clock.now));
        } else {
          results.push([
            { count: countRows(compiled, namespaceStore, tableStore, resolver, options.clock.now) },
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
    const outboxEnabled = options.outbox?.enabled ?? false;
    const shouldInclude = options.outbox?.shouldInclude;
    const outboxOperations = outboxEnabled
      ? mutationBatch.flatMap((mutation) => {
          const operation = mutation.operation;
          if (!operation) {
            return [];
          }
          if (shouldInclude && !shouldInclude(operation)) {
            return [];
          }
          return [operation];
        })
      : [];
    const outboxPlan = outboxOperations.length > 0 ? buildOutboxPlan(outboxOperations) : null;
    const shouldWriteOutbox = outboxEnabled && outboxPlan !== null && outboxPlan.drafts.length > 0;
    let outboxVersion: bigint | null = null;

    try {
      if (shouldWriteOutbox) {
        const reservation = reserveOutboxVersion(store, options, resolverFactory);
        outboxVersion = reservation.version;
        rollbackActions.push(reservation.rollback);
      }

      for (const compiled of mutationBatch) {
        const operation = compiled.query;

        if (operation.type === "create") {
          const resolver = getResolver(operation.schema, operation.namespace, resolverFactory);
          const namespaceStore = getNamespaceStore(
            store,
            operation.schema,
            operation.namespace,
            resolver,
          );
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, table, resolver);
          const previousInternalId = tableStore.nextInternalId;
          const internalId = createRow(operation, namespaceStore, tableStore, options, resolver);
          createdInternalIds.push(internalId);
          rollbackActions.push(() => {
            const row = tableStore.rows.get(internalId);
            if (row) {
              for (const indexStore of tableStore.indexes.values()) {
                const key = buildIndexKey(table, indexStore.definition, row, resolver);
                indexStore.index.remove(key, internalId);
              }
              tableStore.rows.delete(internalId);
            }
            tableStore.nextInternalId = previousInternalId;
          });
          continue;
        }

        if (operation.type === "update") {
          const resolver = getResolver(operation.schema, operation.namespace, resolverFactory);
          const namespaceStore = getNamespaceStore(
            store,
            operation.schema,
            operation.namespace,
            resolver,
          );
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, table, resolver);
          const rollback = updateRow(operation, namespaceStore, tableStore, options, resolver);
          if (rollback) {
            rollbackActions.push(rollback);
          }
          continue;
        }

        if (operation.type === "delete") {
          const resolver = getResolver(operation.schema, operation.namespace, resolverFactory);
          const namespaceStore = getNamespaceStore(
            store,
            operation.schema,
            operation.namespace,
            resolver,
          );
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, table, resolver);
          const rollback = deleteRow(
            operation,
            namespaceStore,
            tableStore,
            table,
            options,
            resolver,
          );
          if (rollback) {
            rollbackActions.push(rollback);
          }
          continue;
        }

        if (operation.type === "check") {
          const resolver = getResolver(operation.schema, operation.namespace, resolverFactory);
          const namespaceStore = getNamespaceStore(
            store,
            operation.schema,
            operation.namespace,
            resolver,
          );
          const table = operation.schema.tables[operation.table];
          if (!table) {
            throw new Error(`Invalid table name ${operation.table}.`);
          }
          const tableStore = getTableStore(namespaceStore, table, resolver);
          checkRow(operation, tableStore, table, resolver);
          continue;
        }

        throw new Error(`Unsupported in-memory mutation "${operation.type}".`);
      }

      if (shouldWriteOutbox && outboxPlan && outboxVersion !== null) {
        const uowId = mutationBatch[0]?.uowId;
        if (!uowId) {
          throw new Error("Outbox mutation batch is missing uowId.");
        }

        const refMap = resolveOutboxRefMap(
          store,
          outboxPlan.lookups,
          resolverFactory,
          schemaByNamespace,
        );
        const payload = finalizeOutboxPayload(outboxPlan, outboxVersion);
        const payloadSerialized = superjson.serialize(payload);
        const versionstamp = encodeVersionstamp(outboxVersion, 0);
        const rollback = insertOutboxRow(store, options, resolverFactory, {
          versionstamp,
          uowId,
          payload: payloadSerialized,
          refMap,
        });
        rollbackActions.push(rollback);
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
  readonly #resolverFactory?: ResolverFactory;

  constructor(resolverFactory?: ResolverFactory) {
    this.#resolverFactory = resolverFactory;
  }

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

      const resolver = getResolver(op.schema, op.namespace, this.#resolverFactory);
      const rows = result as InMemoryRow[];
      const decodedRows = rows.map((row) => this.decodeRow(row, op.table, resolver));

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

  private decodeRow(
    row: InMemoryRow,
    table: AnyTable,
    resolver?: NamingResolver,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    const columnValues: Record<string, unknown> = {};
    const relationData: Record<string, Record<string, unknown>> = {};
    const columnMap = resolver ? resolver.getColumnNameMap(table) : undefined;

    for (const key in row) {
      const colonIndex = key.indexOf(":");
      if (colonIndex === -1) {
        const logicalName = columnMap?.[key] ?? key;
        if (table.columns[logicalName]) {
          columnValues[logicalName] = row[key];
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
      output[relationName] = this.decodeRow(relationData[relationName], relation.table, resolver);
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
