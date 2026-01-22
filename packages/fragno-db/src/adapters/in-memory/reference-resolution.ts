import type { AnyTable } from "../../schema/create";
import { ReferenceSubquery } from "../../query/value-encoding";
import type { InMemoryNamespaceStore, InMemoryTableStore } from "./store";

const getTableStore = (
  namespaceStore: InMemoryNamespaceStore,
  table: AnyTable,
): InMemoryTableStore => {
  const store = namespaceStore.tables.get(table.ormName) ?? namespaceStore.tables.get(table.name);
  if (!store) {
    throw new Error(`Missing in-memory table store for "${table.ormName}".`);
  }
  return store;
};

const resolveExternalIdToInternalId = (
  tableStore: InMemoryTableStore,
  table: AnyTable,
  externalId: string,
): bigint | undefined => {
  const idColumnName = table.getIdColumn().name;
  for (const [internalId, row] of tableStore.rows) {
    if (row[idColumnName] === externalId) {
      return internalId;
    }
  }
  return undefined;
};

export const resolveReferenceSubquery = (
  namespaceStore: InMemoryNamespaceStore,
  reference: ReferenceSubquery,
): bigint | null => {
  const tableStore = getTableStore(namespaceStore, reference.referencedTable);
  const resolved = resolveExternalIdToInternalId(
    tableStore,
    reference.referencedTable,
    reference.externalIdValue,
  );
  return resolved ?? null;
};

export const resolveReferenceSubqueries = (
  namespaceStore: InMemoryNamespaceStore,
  values: Record<string, unknown>,
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    resolved[key] =
      value instanceof ReferenceSubquery ? resolveReferenceSubquery(namespaceStore, value) : value;
  }

  return resolved;
};
