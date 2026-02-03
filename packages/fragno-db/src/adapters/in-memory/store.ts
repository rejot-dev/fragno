import type { AnyColumn, AnySchema, AnyTable } from "../../schema/create";
import { SortedArrayIndex } from "./sorted-array-index";
import { SQLocalDriverConfig } from "../generic-sql/driver-config";
import { createSQLSerializer } from "../../query/serialize/create-sql-serializer";
import { compareNormalizedValues } from "./value-comparison";
import type { NamingResolver } from "../../naming/sql-naming";

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
  resolver?: NamingResolver,
): readonly unknown[] => {
  const columnMap = resolver ? resolver.getColumnNameMap(table) : undefined;
  return index.columnNames.map((columnName) => {
    const logicalName = columnMap?.[columnName] ?? columnName;
    const column = table.columns[logicalName];
    if (!column) {
      throw new Error(
        `Column "${columnName}" not found in table "${table.name}" for index "${index.name}".`,
      );
    }
    return normalizeIndexValue(row[columnName], column);
  });
};

const createTableIndexes = (
  table: AnyTable,
  resolver?: NamingResolver,
): Map<string, InMemoryIndexStore> => {
  const indexes = new Map<string, InMemoryIndexStore>();
  const primaryIndex = table.indexes["_primary"];
  const primaryColumnNames = primaryIndex
    ? primaryIndex.columnNames.map((columnName) =>
        resolver ? resolver.getColumnName(table.name, columnName) : columnName,
      )
    : [
        resolver
          ? resolver.getColumnName(table.name, table.getIdColumn().name)
          : table.getIdColumn().name,
      ];
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
        columnNames: index.columnNames.map((columnName) =>
          resolver ? resolver.getColumnName(table.name, columnName) : columnName,
        ),
        unique: index.unique,
      },
      index: new SortedArrayIndex(compareNormalizedValues, { unique: index.unique }),
    });
  }

  return indexes;
};

const createTableStore = (table: AnyTable, resolver?: NamingResolver): InMemoryTableStore => ({
  rows: new Map(),
  nextInternalId: 1n,
  indexes: createTableIndexes(table, resolver),
});

export const createNamespaceStore = (
  schema: AnySchema,
  resolver?: NamingResolver,
): InMemoryNamespaceStore => {
  const tables = new Map<string, InMemoryTableStore>();
  for (const tableName of Object.keys(schema.tables)) {
    const table = schema.tables[tableName];
    const storeKey = resolver ? resolver.getTableName(table.name) : table.name;
    tables.set(storeKey, createTableStore(table, resolver));
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
  resolver?: NamingResolver,
): InMemoryNamespaceStore => {
  const existing = store.namespaces.get(namespace);
  if (existing) {
    return existing;
  }

  const created = createNamespaceStore(schema, resolver);
  store.namespaces.set(namespace, created);
  return created;
};
