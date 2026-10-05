import type { Condition } from "../query/condition-builder";
import { buildCondition } from "../query/condition-builder";
import type { CursorResult } from "../query/cursor";
import type { AnySelectClause } from "../query/mod";
import type { MutationOperation } from "../query/unit-of-work/mutation-recorder";
import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
} from "../query/unit-of-work/query-tree";
import type { RetrievalOperation } from "../query/unit-of-work/unit-of-work";
import type { AnySchema, AnyTable } from "../schema/create";
import { FragnoId } from "../schema/create";

export type ReadKey = {
  shard: string | null;
  schema: string;
  table: string;
  externalId: string;
};

export type ReadScope = {
  shard: string | null;
  schema: string;
  table: AnyTable;
  indexName: string;
  condition?: Condition;
};

function getConditionRowShard(condition: Condition | undefined): string | null {
  if (!condition) {
    return null;
  }
  if (condition.type === "compare") {
    return condition.a.name === "_shard" &&
      condition.operator === "=" &&
      typeof condition.b === "string"
      ? condition.b
      : null;
  }
  if (condition.type === "not") {
    return null;
  }

  for (const item of condition.items) {
    const shard = getConditionRowShard(item);
    if (shard !== null) {
      return shard;
    }
  }
  return null;
}

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

const collectKeyFromRecord = (
  record: unknown,
  table: AnyTable,
  schemaName: string,
  shard: string | null,
  output: ReadKey[],
): void => {
  if (!record || typeof record !== "object") {
    return;
  }
  const externalId = getExternalId((record as Record<string, unknown>)[table.getIdColumn().name]);
  if (externalId !== undefined) {
    output.push({ shard, schema: schemaName, table: table.name, externalId });
  }
};

const collectKeysFromQueryTreeRecord = (
  record: unknown,
  node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
  schemaName: string,
  output: ReadKey[],
): void => {
  if (!record || typeof record !== "object") {
    return;
  }

  const idKey = node.table.getIdColumn().name;
  const externalId = getExternalId((record as Record<string, unknown>)[idKey]);
  if (externalId !== undefined) {
    output.push({
      shard: getConditionRowShard(node.where),
      schema: schemaName,
      table: node.table.name,
      externalId,
    });
  }

  for (const child of node.children) {
    const childValue = (record as Record<string, unknown>)[child.alias];
    if (childValue === null || childValue === undefined) {
      continue;
    }

    if (Array.isArray(childValue)) {
      for (const item of childValue) {
        collectKeysFromQueryTreeRecord(item, child, schemaName, output);
      }
      continue;
    }

    collectKeysFromQueryTreeRecord(childValue, child, schemaName, output);
  }
};

const shouldStripId = (select: AnySelectClause | undefined, table: AnyTable): boolean => {
  if (!select || select === true) {
    return false;
  }

  const idKey = table.getIdColumn().name;
  return !select.includes(idKey);
};

const stripKeysFromQueryTreeRecord = (
  record: unknown,
  node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
  stripId: boolean,
): void => {
  if (!record || typeof record !== "object") {
    return;
  }

  if (stripId) {
    const idKey = node.table.getIdColumn().name;
    delete (record as Record<string, unknown>)[idKey];
  }

  for (const child of node.children) {
    const childValue = (record as Record<string, unknown>)[child.alias];
    if (childValue === null || childValue === undefined) {
      continue;
    }

    const stripChildId = shouldStripId(child.select, child.table);

    if (Array.isArray(childValue)) {
      for (const item of childValue) {
        stripKeysFromQueryTreeRecord(item, child, stripChildId);
      }
      continue;
    }

    stripKeysFromQueryTreeRecord(childValue, child, stripChildId);
  }
};

const stripKeyFromRecord = (record: unknown, table: AnyTable, stripId: boolean): void => {
  if (!record || typeof record !== "object" || !stripId) {
    return;
  }
  delete (record as Record<string, unknown>)[table.getIdColumn().name];
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
        shard: getConditionRowShard(condition === true ? undefined : condition),
        schema: schemaName,
        table: op.table,
        indexName: op.indexName,
        condition: condition === true ? undefined : condition,
      });
      continue;
    }

    if (op.type === "find") {
      const condition = op.options.queryTree
        ? op.options.queryTree.where
        : op.options.where
          ? buildCondition(op.table.columns, op.options.where)
          : undefined;

      if (condition === false) {
        continue;
      }

      scopes.push({
        shard: getConditionRowShard(condition === true ? undefined : condition),
        schema: schemaName,
        table: op.table,
        indexName: op.indexName,
        condition: condition === true ? undefined : condition,
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
      if (op.options.queryTree) {
        collectKeysFromQueryTreeRecord(record, op.options.queryTree, schemaName, keys);
      } else {
        const condition = op.options.where
          ? buildCondition(op.table.columns, op.options.where)
          : undefined;
        collectKeyFromRecord(
          record,
          op.table,
          schemaName,
          condition === false || condition === true ? null : getConditionRowShard(condition),
          keys,
        );
      }
    }
  }

  return keys;
};

export const collectWriteKeys = (
  operations: ReadonlyArray<MutationOperation<AnySchema>>,
): ReadKey[] => {
  const keys: ReadKey[] = [];

  for (const op of operations) {
    if (op.type === "check" || op.type === "check-absent") {
      continue;
    }

    const schemaName = op.namespace ?? "";

    if (op.type === "create") {
      keys.push({
        shard: op.shard,
        schema: schemaName,
        table: op.table,
        externalId: op.generatedExternalId,
      });
      continue;
    }

    if (op.type === "delete-many") {
      for (const id of op.ids) {
        const externalId = getExternalId(id);
        if (externalId !== undefined) {
          keys.push({
            shard: op.shard,
            schema: schemaName,
            table: op.table,
            externalId,
          });
        }
      }
      continue;
    }

    const externalId = getExternalId(op.id);
    if (externalId !== undefined) {
      keys.push({
        shard: op.shard,
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
        if (op.options.queryTree) {
          stripKeysFromQueryTreeRecord(record, op.options.queryTree, stripId);
        } else {
          stripKeyFromRecord(record, op.table, stripId);
        }
      }
      continue;
    }

    if (Array.isArray(result)) {
      for (const record of result) {
        if (op.options.queryTree) {
          stripKeysFromQueryTreeRecord(record, op.options.queryTree, stripId);
        } else {
          stripKeyFromRecord(record, op.table, stripId);
        }
      }
      continue;
    }

    if (op.options.queryTree) {
      stripKeysFromQueryTreeRecord(result, op.options.queryTree, stripId);
    } else {
      stripKeyFromRecord(result, op.table, stripId);
    }
  }
};
