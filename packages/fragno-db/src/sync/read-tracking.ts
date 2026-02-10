import type { AnySchema, AnyTable } from "../schema/create";
import { FragnoId } from "../schema/create";
import type { Condition } from "../query/condition-builder";
import { buildCondition } from "../query/condition-builder";
import type { CompiledJoin } from "../query/orm/orm";
import type { MutationOperation, RetrievalOperation } from "../query/unit-of-work/unit-of-work";
import type { CursorResult } from "../query/cursor";
import type { AnySelectClause } from "../query/simple-query-interface";

export type ReadKey = {
  schema: string;
  table: string;
  externalId: string;
};

export type ReadScope = {
  schema: string;
  table: AnyTable;
  indexName: string;
  condition?: Condition;
  joins?: CompiledJoin[];
};

const isCursorResult = (value: unknown): value is CursorResult<unknown> => {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Array.isArray((value as CursorResult<unknown>).items);
};

const getExternalId = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof FragnoId) {
    return value.externalId;
  }

  if (value && typeof value === "object") {
    const candidate = (value as { externalId?: unknown }).externalId;
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
};

const collectKeysFromRecord = (
  record: unknown,
  table: AnyTable,
  joins: CompiledJoin[] | undefined,
  schemaName: string,
  output: ReadKey[],
): void => {
  if (!record || typeof record !== "object") {
    return;
  }

  const idKey = table.getIdColumn().name;
  const externalId = getExternalId((record as Record<string, unknown>)[idKey]);
  if (externalId !== undefined) {
    output.push({ schema: schemaName, table: table.name, externalId });
  }

  if (!joins || joins.length === 0) {
    return;
  }

  for (const join of joins) {
    const { relation, options } = join;
    if (options === false) {
      continue;
    }

    const relationValue = (record as Record<string, unknown>)[relation.name];
    if (relationValue === null || relationValue === undefined) {
      continue;
    }

    if (Array.isArray(relationValue)) {
      for (const item of relationValue) {
        collectKeysFromRecord(item, relation.table, options.join, schemaName, output);
      }
      continue;
    }

    collectKeysFromRecord(relationValue, relation.table, options.join, schemaName, output);
  }
};

const shouldStripId = (select: AnySelectClause | undefined, table: AnyTable): boolean => {
  if (!select || select === true) {
    return false;
  }

  const idKey = table.getIdColumn().name;
  return !select.includes(idKey);
};

const stripKeysFromRecord = (
  record: unknown,
  table: AnyTable,
  joins: CompiledJoin[] | undefined,
  stripId: boolean,
): void => {
  if (!record || typeof record !== "object") {
    return;
  }

  if (stripId) {
    const idKey = table.getIdColumn().name;
    delete (record as Record<string, unknown>)[idKey];
  }

  if (!joins || joins.length === 0) {
    return;
  }

  for (const join of joins) {
    const { relation, options } = join;
    if (options === false) {
      continue;
    }

    const relationValue = (record as Record<string, unknown>)[relation.name];
    if (relationValue === null || relationValue === undefined) {
      continue;
    }

    const stripRelationId = shouldStripId(options.select, relation.table);

    if (Array.isArray(relationValue)) {
      for (const item of relationValue) {
        stripKeysFromRecord(item, relation.table, options.join, stripRelationId);
      }
      continue;
    }

    stripKeysFromRecord(relationValue, relation.table, options.join, stripRelationId);
  }
};

export const collectReadScopes = (
  operations: ReadonlyArray<RetrievalOperation<AnySchema>>,
): ReadScope[] => {
  const scopes: ReadScope[] = [];

  for (const op of operations) {
    const schemaName = op.namespace ?? "";

    if (op.type === "count") {
      const condition = op.options.where
        ? buildCondition(op.table.columns, op.options.where)
        : undefined;

      if (condition === false) {
        continue;
      }

      scopes.push({
        schema: schemaName,
        table: op.table,
        indexName: op.indexName,
        condition: condition === true ? undefined : condition,
      });
      continue;
    }

    if (op.type === "find") {
      const condition = op.options.where
        ? buildCondition(op.table.columns, op.options.where)
        : undefined;

      if (condition === false) {
        continue;
      }

      scopes.push({
        schema: schemaName,
        table: op.table,
        indexName: op.indexName,
        condition: condition === true ? undefined : condition,
        joins: op.options.joins,
      });
    }
  }

  return scopes;
};

export const collectReadKeys = (
  operations: ReadonlyArray<RetrievalOperation<AnySchema>>,
  results: unknown[],
): ReadKey[] => {
  const keys: ReadKey[] = [];

  for (const [index, op] of operations.entries()) {
    if (op.type !== "find") {
      continue;
    }

    const schemaName = op.namespace ?? "";
    const result = results[index];

    let records: unknown[] = [];
    if (op.withCursor && isCursorResult(result)) {
      records = result.items;
    } else if (Array.isArray(result)) {
      records = result;
    } else if (result !== null && result !== undefined) {
      records = [result];
    }

    for (const record of records) {
      collectKeysFromRecord(record, op.table, op.options.joins, schemaName, keys);
    }
  }

  return keys;
};

export const collectWriteKeys = (
  operations: ReadonlyArray<MutationOperation<AnySchema>>,
): ReadKey[] => {
  const keys: ReadKey[] = [];

  for (const op of operations) {
    if (op.type === "check") {
      continue;
    }

    const schemaName = op.namespace ?? "";

    if (op.type === "create") {
      keys.push({
        schema: schemaName,
        table: op.table,
        externalId: op.generatedExternalId,
      });
      continue;
    }

    const externalId = getExternalId(op.id);
    if (externalId !== undefined) {
      keys.push({
        schema: schemaName,
        table: op.table,
        externalId,
      });
    }
  }

  return keys;
};

export const stripReadTrackingResults = (
  operations: ReadonlyArray<RetrievalOperation<AnySchema>>,
  results: unknown[],
): void => {
  for (const [index, op] of operations.entries()) {
    if (op.type !== "find" || !op.readTracking) {
      continue;
    }

    const result = results[index];
    const stripId = shouldStripId(op.options.select, op.table);

    if (op.withCursor && isCursorResult(result)) {
      for (const record of result.items) {
        stripKeysFromRecord(record, op.table, op.options.joins, stripId);
      }
      continue;
    }

    if (Array.isArray(result)) {
      for (const record of result) {
        stripKeysFromRecord(record, op.table, op.options.joins, stripId);
      }
      continue;
    }

    stripKeysFromRecord(result, op.table, op.options.joins, stripId);
  }
};
