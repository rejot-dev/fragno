import type { NamingResolver } from "../../naming/sql-naming";
import { ReferenceSubquery } from "../../query/value-encoding";
import type { AnyTable } from "../../schema/create";
import type { InMemoryNamespaceStore, InMemoryTableStore } from "./store";

const getTableStore = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
  resolver?: NamingResolver,
): InMemoryTableStore => {
  const tableName = resolver ? resolver.getTableName(table.name) : table.name;
  const store = namespaceStore.tables.get(tableName);
  if (!store) {
    throw new Error(`Missing in-memory table store for "${tableName}".`);
  }
  return store;
};

const resolveExternalIdToInternalId = (
  tableStore: InMemoryTableStore,
  table: AnyTable,
  externalId: string,
  shard: string | null,
  resolver?: NamingResolver,
): bigint | undefined => {
  const idColumnName = table.getIdColumn().name;
  const physicalIdColumnName = resolver
    ? resolver.getColumnName(table.name, idColumnName)
    : idColumnName;
  const physicalShardColumnName = resolver
    ? resolver.getColumnName(table.name, "_shard")
    : "_shard";
  for (const [internalId, row] of tableStore.rows) {
    if (
      row[physicalIdColumnName] === externalId &&
      (shard === null || row[physicalShardColumnName] === shard)
    ) {
      return internalId;
    }
  }
  return undefined;
};

export const resolveReferenceSubquery = (
  namespaceStore: InMemoryNamespaceStore,
  reference: ReferenceSubquery,
  resolver?: NamingResolver,
): bigint | null => {
  const tableStore = getTableStore(namespaceStore, reference.referencedTable, resolver);
  const resolved = resolveExternalIdToInternalId(
    tableStore,
    reference.referencedTable,
    reference.externalIdValue,
    reference.shard,
    resolver,
  );
  return resolved ?? null;
};

export const resolveReferenceSubqueries = (
  namespaceStore: InMemoryNamespaceStore,
  values: Record<string, unknown>,
  resolver?: NamingResolver,
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    resolved[key] =
      value instanceof ReferenceSubquery
        ? resolveReferenceSubquery(namespaceStore, value, resolver)
        : value;
  }

  return resolved;
};
