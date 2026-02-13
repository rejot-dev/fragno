import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import type { LofiMutation } from "../../types";
import type { ReferenceTarget } from "../../indexeddb/types";
import { normalizeValue } from "../../query/normalize";
import { compareNormalizedValues } from "./value-comparison";
import { SortedArrayIndex, type IndexKey } from "./sorted-array-index";
import { stripShardField } from "../../system-columns";

export type InMemoryLofiRow = {
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

type InMemoryIndexDefinition = {
  name: string;
  columnNames: string[];
  unique: boolean;
};

type InMemoryIndexStore = {
  definition: InMemoryIndexDefinition;
  index: SortedArrayIndex<number>;
};

type InMemoryTableStore = {
  rowsByExternalId: Map<string, InMemoryLofiRow>;
  rowsByInternalId: Map<number, InMemoryLofiRow>;
  nextInternalId: number;
  indexes: Map<string, InMemoryIndexStore>;
  tombstones: Set<string>;
};

type InMemorySchemaStore = {
  tables: Map<string, InMemoryTableStore>;
};

type InMemoryStoreOptions = {
  endpointName: string;
  schemas: AnySchema[];
};

const createReferenceTargets = (schemas: AnySchema[]): Map<string, ReferenceTarget> => {
  const referenceTargets = new Map<string, ReferenceTarget>();
  for (const schema of schemas) {
    for (const table of Object.values(schema.tables)) {
      for (const relation of Object.values(table.relations)) {
        for (const [fromColumn] of relation.on) {
          referenceTargets.set(`${schema.name}::${table.name}::${fromColumn}`, {
            schema: schema.name,
            table: relation.table.name,
          });
        }
      }
    }
  }
  return referenceTargets;
};

const createTableIndexes = (table: AnyTable): Map<string, InMemoryIndexStore> => {
  const indexes = new Map<string, InMemoryIndexStore>();
  const primaryIndex = table.indexes["_primary"];
  const primaryColumnNames = primaryIndex
    ? [...primaryIndex.columnNames]
    : [table.getIdColumn().name];
  const primaryDefinition: InMemoryIndexDefinition = {
    name: "_primary",
    columnNames: primaryColumnNames,
    unique: primaryIndex?.unique ?? true,
  };
  indexes.set("_primary", {
    definition: primaryDefinition,
    index: new SortedArrayIndex(compareNormalizedValues, { unique: primaryDefinition.unique }),
  });

  for (const [name, index] of Object.entries(table.indexes)) {
    if (name === "_primary") {
      continue;
    }
    const definition: InMemoryIndexDefinition = {
      name,
      columnNames: [...index.columnNames],
      unique: index.unique,
    };
    indexes.set(name, {
      definition,
      index: new SortedArrayIndex(compareNormalizedValues, { unique: index.unique }),
    });
  }

  return indexes;
};

const createTableStore = (table: AnyTable): InMemoryTableStore => ({
  rowsByExternalId: new Map(),
  rowsByInternalId: new Map(),
  nextInternalId: 1,
  indexes: createTableIndexes(table),
  tombstones: new Set(),
});

const createSchemaStore = (schema: AnySchema): InMemorySchemaStore => {
  const tables = new Map<string, InMemoryTableStore>();
  for (const table of Object.values(schema.tables)) {
    tables.set(table.name, createTableStore(table));
  }
  return { tables };
};

const buildIndexKey = (row: InMemoryLofiRow, index: InMemoryIndexDefinition): IndexKey =>
  index.columnNames.map((columnName) => row._lofi.norm[columnName]);

const insertRowIntoIndexes = (store: InMemoryTableStore, row: InMemoryLofiRow): void => {
  for (const indexStore of store.indexes.values()) {
    const key = buildIndexKey(row, indexStore.definition);
    indexStore.index.insert(key, row._lofi.internalId, { enforceUnique: true });
  }
};

const removeRowFromIndexes = (store: InMemoryTableStore, row: InMemoryLofiRow): void => {
  for (const indexStore of store.indexes.values()) {
    const key = buildIndexKey(row, indexStore.definition);
    indexStore.index.remove(key, row._lofi.internalId);
  }
};

const updateRowIndexes = (
  store: InMemoryTableStore,
  existing: InMemoryLofiRow,
  next: InMemoryLofiRow,
): void => {
  const updates = Array.from(store.indexes.values()).map((indexStore) => ({
    indexStore,
    oldKey: buildIndexKey(existing, indexStore.definition),
    newKey: buildIndexKey(next, indexStore.definition),
  }));

  const applied: typeof updates = [];

  try {
    for (const update of updates) {
      update.indexStore.index.update(update.oldKey, update.newKey, existing._lofi.internalId, {
        enforceUnique: true,
      });
      applied.push(update);
    }
  } catch (error) {
    for (const update of applied.slice().reverse()) {
      update.indexStore.index.update(update.newKey, update.oldKey, existing._lofi.internalId, {
        enforceUnique: false,
      });
    }
    throw error;
  }
};

const coerceInternalIdValue = (
  value: bigint | number,
  schema: AnySchema,
  table: AnyTable,
  columnName: string,
): number => {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(
      `Reference internalId is not a safe integer for ${schema.name}.${table.name}.${columnName}: ${value.toString()}`,
    );
  }
  return asNumber;
};

const resolveReferenceExternalId = (options: {
  schema: AnySchema;
  table: AnyTable;
  columnName: string;
  externalId: string;
  referenceTargets: Map<string, ReferenceTarget>;
  store: InMemoryLofiStore;
}): number | undefined => {
  const { schema, table, columnName, externalId, referenceTargets, store } = options;
  const target = referenceTargets.get(`${schema.name}::${table.name}::${columnName}`);
  if (!target) {
    return undefined;
  }
  const referenced = store.getRow(target.schema, target.table, externalId);
  if (!referenced) {
    return undefined;
  }
  return referenced._lofi.internalId;
};

const resolveColumnValue = (options: {
  schema: AnySchema;
  table: AnyTable;
  columnName: string;
  column: AnyColumn;
  data: Record<string, unknown>;
  rowId: string;
  internalId: number;
  version: number;
  store: InMemoryLofiStore;
  referenceTargets: Map<string, ReferenceTarget>;
}): unknown => {
  const {
    schema,
    table,
    columnName,
    column,
    data,
    rowId,
    internalId,
    version,
    store,
    referenceTargets,
  } = options;

  if (column.role === "external-id") {
    return rowId;
  }

  if (column.role === "internal-id") {
    return internalId;
  }

  if (column.role === "version") {
    return version;
  }

  if (column.role === "reference") {
    const rawValue = data[columnName];
    if (rawValue == null) {
      return rawValue;
    }

    if (rawValue instanceof FragnoReference) {
      return coerceInternalIdValue(rawValue.internalId, schema, table, columnName);
    }

    if (rawValue instanceof FragnoId) {
      if (rawValue.internalId !== undefined) {
        return coerceInternalIdValue(rawValue.internalId, schema, table, columnName);
      }
      return resolveReferenceExternalId({
        schema,
        table,
        columnName,
        externalId: rawValue.externalId,
        store,
        referenceTargets,
      });
    }

    if (typeof rawValue === "number") {
      throw new Error(
        `Expected reference value to be external ID string for ${schema.name}.${table.name}.${columnName}.`,
      );
    }

    if (typeof rawValue === "bigint") {
      return coerceInternalIdValue(rawValue, schema, table, columnName);
    }

    if (typeof rawValue !== "string") {
      throw new Error(
        `Expected reference value to be external ID string for ${schema.name}.${table.name}.${columnName}.`,
      );
    }

    return resolveReferenceExternalId({
      schema,
      table,
      columnName,
      externalId: rawValue,
      store,
      referenceTargets,
    });
  }

  const rawValue = data[columnName];
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue === null) {
    return null;
  }

  return normalizeValue(rawValue, column);
};

const buildNormalizedValues = (options: {
  schema: AnySchema;
  table: AnyTable;
  data: Record<string, unknown>;
  rowId: string;
  internalId: number;
  version: number;
  store: InMemoryLofiStore;
  referenceTargets: Map<string, ReferenceTarget>;
}): Record<string, unknown> => {
  const { schema, table, data, rowId, internalId, version, store, referenceTargets } = options;
  const norm: Record<string, unknown> = {};

  for (const [columnName, column] of Object.entries(table.columns)) {
    norm[columnName] = resolveColumnValue({
      schema,
      table,
      columnName,
      column,
      data,
      rowId,
      internalId,
      version,
      store,
      referenceTargets,
    });
  }

  return norm;
};

export class InMemoryLofiStore {
  readonly endpointName: string;
  readonly schemas: AnySchema[];
  readonly schemaMap: Map<string, AnySchema>;
  readonly tableMap: Map<string, Map<string, AnyTable>>;
  readonly referenceTargets: Map<string, ReferenceTarget>;
  #stores: Map<string, InMemorySchemaStore>;

  constructor(options: InMemoryStoreOptions) {
    if (!options.endpointName || options.endpointName.trim().length === 0) {
      throw new Error("InMemoryLofiStore requires a non-empty endpointName.");
    }

    const schemaMap = new Map<string, AnySchema>();
    const tableMap = new Map<string, Map<string, AnyTable>>();

    for (const schema of options.schemas) {
      if (!schema.name || schema.name.trim().length === 0) {
        throw new Error("InMemoryLofiStore schemas must have a non-empty name.");
      }
      if (schemaMap.has(schema.name)) {
        throw new Error(`InMemoryLofiStore schema name must be unique: ${schema.name}`);
      }
      schemaMap.set(schema.name, schema);
      const tables = new Map<string, AnyTable>();
      for (const [tableName, table] of Object.entries(schema.tables)) {
        tables.set(tableName, table);
      }
      tableMap.set(schema.name, tables);
    }

    this.endpointName = options.endpointName;
    this.schemas = [...schemaMap.values()];
    this.schemaMap = schemaMap;
    this.tableMap = tableMap;
    this.referenceTargets = createReferenceTargets(this.schemas);
    this.#stores = new Map();
    for (const schema of this.schemas) {
      this.#stores.set(schema.name, createSchemaStore(schema));
    }
  }

  clear(): void {
    this.#stores = new Map();
    for (const schema of this.schemas) {
      this.#stores.set(schema.name, createSchemaStore(schema));
    }
  }

  reset(): void {
    this.clear();
  }

  seedRows(rows: InMemoryLofiRow[]): void {
    for (const row of rows) {
      if (row.endpoint !== this.endpointName) {
        continue;
      }
      const tableStore = this.getTableStore(row.schema, row.table);
      this.upsertRow(tableStore, row as InMemoryLofiRow);
      tableStore.tombstones.delete(row.id);
    }
  }

  applyMutations(mutations: LofiMutation[]): void {
    for (const mutation of mutations) {
      this.applyMutation(mutation);
    }
  }

  applyMutation(mutation: LofiMutation): void {
    const schema = this.schemaMap.get(mutation.schema);
    if (!schema) {
      throw new Error(`Unknown mutation schema: ${mutation.schema}`);
    }
    const table = this.tableMap.get(mutation.schema)?.get(mutation.table);
    if (!table) {
      throw new Error(`Unknown mutation table: ${mutation.schema}.${mutation.table}`);
    }

    const tableStore = this.getTableStore(schema.name, table.name);
    const existing = tableStore.rowsByExternalId.get(mutation.externalId);

    if (mutation.op === "delete") {
      if (existing) {
        removeRowFromIndexes(tableStore, existing);
        tableStore.rowsByExternalId.delete(existing.id);
        tableStore.rowsByInternalId.delete(existing._lofi.internalId);
      }
      tableStore.tombstones.add(mutation.externalId);
      return;
    }

    const rawValues = mutation.op === "create" ? mutation.values : mutation.set;
    const values = stripShardField(rawValues) ?? rawValues;
    if (!existing && mutation.op === "update") {
      return;
    }

    tableStore.tombstones.delete(mutation.externalId);
    const merged = existing ? { ...existing.data, ...values } : { ...values };
    const data = stripShardField(merged) ?? merged;
    const internalId = existing ? existing._lofi.internalId : this.allocateInternalId(tableStore);
    const version = existing ? existing._lofi.version + (mutation.op === "update" ? 1 : 0) : 1;
    const norm = buildNormalizedValues({
      schema,
      table,
      data,
      rowId: mutation.externalId,
      internalId,
      version,
      store: this,
      referenceTargets: this.referenceTargets,
    });

    const row: InMemoryLofiRow = {
      key: [this.endpointName, schema.name, table.name, mutation.externalId],
      endpoint: this.endpointName,
      schema: schema.name,
      table: table.name,
      id: mutation.externalId,
      data,
      _lofi: {
        versionstamp: mutation.versionstamp,
        norm,
        internalId,
        version,
      },
    };

    if (existing) {
      updateRowIndexes(tableStore, existing, row);
      tableStore.rowsByExternalId.set(row.id, row);
      tableStore.rowsByInternalId.set(row._lofi.internalId, row);
      return;
    }

    this.upsertRow(tableStore, row);
  }

  getRow(schemaName: string, tableName: string, externalId: string): InMemoryLofiRow | undefined {
    return this.getTableStore(schemaName, tableName).rowsByExternalId.get(externalId);
  }

  hasTombstone(schemaName: string, tableName: string, externalId: string): boolean {
    return this.getTableStore(schemaName, tableName).tombstones.has(externalId);
  }

  getTombstones(schemaName: string, tableName: string): Set<string> {
    return new Set(this.getTableStore(schemaName, tableName).tombstones);
  }

  getTableRows(schemaName: string, tableName: string): InMemoryLofiRow[] {
    const tableStore = this.getTableStore(schemaName, tableName);
    return Array.from(tableStore.rowsByExternalId.values());
  }

  scanIndex(options: {
    schemaName: string;
    tableName: string;
    indexName: string;
    start?: IndexKey;
    startInclusive?: boolean;
    end?: IndexKey;
    endInclusive?: boolean;
    direction?: "asc" | "desc";
    limit?: number;
  }): InMemoryLofiRow[] {
    const {
      schemaName,
      tableName,
      indexName,
      start,
      startInclusive,
      end,
      endInclusive,
      direction,
      limit,
    } = options;
    const tableStore = this.getTableStore(schemaName, tableName);
    const indexStore = tableStore.indexes.get(indexName);
    if (!indexStore) {
      throw new Error(`Missing in-memory index "${indexName}" on ${schemaName}.${tableName}.`);
    }
    const entries = indexStore.index.scan({
      start,
      startInclusive,
      end,
      endInclusive,
      direction,
      limit,
    });

    const rows: InMemoryLofiRow[] = [];
    for (const entry of entries) {
      const row = tableStore.rowsByInternalId.get(entry.value);
      if (row) {
        rows.push(row);
      }
    }
    return rows;
  }

  private getTableStore(schemaName: string, tableName: string): InMemoryTableStore {
    const schemaStore = this.#stores.get(schemaName);
    if (!schemaStore) {
      throw new Error(`Unknown in-memory schema: ${schemaName}`);
    }
    const tableStore = schemaStore.tables.get(tableName);
    if (!tableStore) {
      throw new Error(`Unknown in-memory table: ${schemaName}.${tableName}`);
    }
    return tableStore;
  }

  private allocateInternalId(tableStore: InMemoryTableStore): number {
    const next = tableStore.nextInternalId;
    tableStore.nextInternalId += 1;
    if (!Number.isSafeInteger(next)) {
      throw new Error("InMemoryLofiStore internalId overflow.");
    }
    return next;
  }

  private upsertRow(tableStore: InMemoryTableStore, row: InMemoryLofiRow): void {
    const existing = tableStore.rowsByExternalId.get(row.id);
    if (existing) {
      removeRowFromIndexes(tableStore, existing);
      tableStore.rowsByExternalId.delete(existing.id);
      tableStore.rowsByInternalId.delete(existing._lofi.internalId);
    }

    insertRowIntoIndexes(tableStore, row);
    tableStore.rowsByExternalId.set(row.id, row);
    tableStore.rowsByInternalId.set(row._lofi.internalId, row);
    if (row._lofi.internalId >= tableStore.nextInternalId) {
      tableStore.nextInternalId = row._lofi.internalId + 1;
    }
  }
}
