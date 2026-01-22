import type { AnyColumn, AnySchema, AnyTable } from "../../schema/create";
import { SortedArrayIndex } from "./sorted-array-index";
import { SQLocalDriverConfig } from "../generic-sql/driver-config";
import { createSQLSerializer } from "../../query/serialize/create-sql-serializer";
import { compareNormalizedValues } from "./value-comparison";

export type InMemoryRow = Record<string, unknown>;

export type InMemoryIndexDefinition = {
  name: string;
  columnNames: string[];
  unique: boolean;
};

export type InMemoryIndexStore = {
  definition: InMemoryIndexDefinition;
  index: SortedArrayIndex<bigint>;
};

export type InMemoryTableStore = {
  rows: Map<bigint, InMemoryRow>;
  nextInternalId: bigint;
  indexes: Map<string, InMemoryIndexStore>;
};

export type InMemoryNamespaceStore = {
  tables: Map<string, InMemoryTableStore>;
};

export type InMemoryStore = {
  namespaces: Map<string, InMemoryNamespaceStore>;
};

const sqliteSerializer = createSQLSerializer(new SQLocalDriverConfig());

export const normalizeIndexValue = (value: unknown, column: AnyColumn): unknown => {
  if (value === undefined) {
    return undefined;
  }
  return sqliteSerializer.serialize(value, column);
};

export const buildIndexKey = (
  table: AnyTable,
  index: InMemoryIndexDefinition,
  row: InMemoryRow,
): readonly unknown[] => {
  return index.columnNames.map((columnName) => {
    const column = table.columns[columnName];
    if (!column) {
      throw new Error(
        `Column "${columnName}" not found in table "${table.name}" for index "${index.name}".`,
      );
    }
    return normalizeIndexValue(row[columnName], column);
  });
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
    indexes.set(name, {
      definition: {
        name,
        columnNames: [...index.columnNames],
        unique: index.unique,
      },
      index: new SortedArrayIndex(compareNormalizedValues, { unique: index.unique }),
    });
  }

  return indexes;
};

const createTableStore = (table: AnyTable): InMemoryTableStore => ({
  rows: new Map(),
  nextInternalId: 1n,
  indexes: createTableIndexes(table),
});

export const createNamespaceStore = (schema: AnySchema): InMemoryNamespaceStore => {
  const tables = new Map<string, InMemoryTableStore>();
  for (const tableName of Object.keys(schema.tables)) {
    const table = schema.tables[tableName];
    tables.set(tableName, createTableStore(table));
  }

  return { tables };
};

export const createInMemoryStore = (): InMemoryStore => ({
  namespaces: new Map(),
});

export const ensureNamespaceStore = (
  store: InMemoryStore,
  namespace: string,
  schema: AnySchema,
): InMemoryNamespaceStore => {
  const existing = store.namespaces.get(namespace);
  if (existing) {
    return existing;
  }

  const created = createNamespaceStore(schema);
  store.namespaces.set(namespace, created);
  return created;
};
