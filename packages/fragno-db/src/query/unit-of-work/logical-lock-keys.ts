import { FragnoId } from "../../schema/create";
import type { AnySchema, AnyTable } from "../../schema/create";
import { isDbNow } from "../db-now";
import type { MutationOperation } from "./mutation-recorder";

/** Logical record name for locking; absent rows lock by unique key. */
export type LogicalLockKey = string;

function scopeFor(op: MutationOperation<AnySchema>): string {
  return op.namespace ?? op.schema.name;
}

function externalIdOf(id: FragnoId | string): string {
  return typeof id === "string" ? id : id.externalId;
}

function isDeferredValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (isDbNow(value)) {
    return true;
  }
  if (typeof value === "object") {
    const name = value.constructor?.name;
    if (name === "ReferenceSubquery" || name === "DbInterval" || name === "DbNow") {
      return true;
    }
  }
  return false;
}

function canonicalizeValue(value: unknown): string | undefined {
  if (value instanceof FragnoId) {
    return JSON.stringify(value.externalId);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (value instanceof Date) {
    return `date:${value.toISOString()}`;
  }
  if (value !== null && typeof value === "object") {
    if (
      "externalId" in value &&
      typeof (value as { externalId: unknown }).externalId === "string"
    ) {
      return JSON.stringify((value as { externalId: string }).externalId);
    }
    try {
      return `json:${JSON.stringify(value)}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function canonicalizeIndexValues(values: Record<string, unknown>): string | undefined {
  const names = Object.keys(values).sort();
  const parts: string[] = [];
  for (const name of names) {
    const value = values[name];
    if (isDeferredValue(value)) {
      return undefined;
    }
    const canonical = canonicalizeValue(value);
    if (canonical === undefined) {
      return undefined;
    }
    parts.push(`${JSON.stringify(name)}:${canonical}`);
  }
  return `{${parts.join(",")}}`;
}

function primaryKey(scope: string, table: string, externalId: string): LogicalLockKey {
  return JSON.stringify(["p", scope, table, externalId]);
}

function uniqueKey(
  scope: string,
  table: string,
  indexName: string,
  values: Record<string, unknown>,
): LogicalLockKey | undefined {
  const canonical = canonicalizeIndexValues(values);
  if (canonical === undefined) {
    return undefined;
  }
  return JSON.stringify(["u", scope, table, indexName, canonical]);
}

function tableFor(op: MutationOperation<AnySchema>): AnyTable | undefined {
  return op.schema.tables[op.table];
}

function uniqueIndexesOf(table: AnyTable): Array<{ name: string; columnNames: readonly string[] }> {
  return Object.entries(table.indexes)
    .filter(([, index]) => index.unique)
    .map(([name, index]) => ({ name, columnNames: index.columnNames }));
}

function lockKeysForCreate(
  op: MutationOperation<AnySchema> & { type: "create" },
): LogicalLockKey[] {
  const scope = scopeFor(op);
  const tableName = op.table;
  const keys: LogicalLockKey[] = [primaryKey(scope, tableName, op.generatedExternalId)];
  const table = tableFor(op);
  if (!table) {
    return keys;
  }
  const idColumnName = table.getIdColumn().name;
  const effectiveValues: Record<string, unknown> = {
    ...(op.values as Record<string, unknown>),
    [idColumnName]: op.generatedExternalId,
  };
  for (const index of uniqueIndexesOf(table)) {
    const indexValues: Record<string, unknown> = {};
    let complete = true;
    for (const columnName of index.columnNames) {
      const value = effectiveValues[columnName];
      if (value === null || value === undefined) {
        complete = false;
        break;
      }
      indexValues[columnName] = value;
    }
    if (!complete) {
      continue;
    }
    const key = uniqueKey(scope, tableName, index.name, indexValues);
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

function lockKeysForUpdate(
  op: MutationOperation<AnySchema> & { type: "update" },
): LogicalLockKey[] {
  const scope = scopeFor(op);
  const keys: LogicalLockKey[] = [primaryKey(scope, op.table, externalIdOf(op.id))];
  const table = tableFor(op);
  const set = op.set as Record<string, unknown> | undefined;
  if (!table || !set) {
    return keys;
  }
  for (const index of uniqueIndexesOf(table)) {
    const indexValues: Record<string, unknown> = {};
    let complete = true;
    for (const columnName of index.columnNames) {
      const value = set[columnName];
      if (value === null || value === undefined) {
        complete = false;
        break;
      }
      indexValues[columnName] = value;
    }
    if (!complete) {
      continue;
    }
    const key = uniqueKey(scope, op.table, index.name, indexValues);
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

function lockKeysForOperation(op: MutationOperation<AnySchema>): LogicalLockKey[] {
  switch (op.type) {
    case "create":
      return lockKeysForCreate(op);
    case "update":
      return lockKeysForUpdate(op);
    case "delete":
      return [primaryKey(scopeFor(op), op.table, externalIdOf(op.id))];
    case "delete-many":
      return op.ids.map((id) => primaryKey(scopeFor(op), op.table, externalIdOf(id)));
    case "check":
      return [primaryKey(scopeFor(op), op.table, op.id.externalId)];
    case "check-absent": {
      const scope = scopeFor(op);
      if (op.indexName === "primary" || op.indexName === "_primary") {
        const id = op.values["id"];
        if (typeof id === "string") {
          return [primaryKey(scope, op.table, id)];
        }
        if (id instanceof FragnoId) {
          return [primaryKey(scope, op.table, id.externalId)];
        }
        return [];
      }
      const key = uniqueKey(scope, op.table, op.indexName, op.values);
      return key === undefined ? [] : [key];
    }
    default: {
      const exhaustive: never = op;
      throw new Error(
        `Unknown mutation operation type: ${(exhaustive as MutationOperation<AnySchema>).type}`,
      );
    }
  }
}

/** Sorted, deduplicated lock keys; acquire in order to avoid deadlocks. */
export function deriveLogicalLockKeys(
  operations: readonly MutationOperation<AnySchema>[],
): LogicalLockKey[] {
  const keys = new Set<LogicalLockKey>();
  for (const op of operations) {
    for (const key of lockKeysForOperation(op)) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}
