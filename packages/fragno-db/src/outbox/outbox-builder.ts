import type { MutationOperation } from "../query/unit-of-work/unit-of-work";
import type { AnySchema, AnyTable } from "../schema/create";
import { FragnoId, FragnoReference } from "../schema/create";
import { internalSchema } from "../fragments/internal-fragment.schema";
import type { OutboxRefLookup, OutboxPayload, OutboxMutation } from "./outbox";
import { encodeVersionstamp, versionstampToHex } from "./outbox";

const INTERNAL_TABLE_NAMES = new Set(Object.keys(internalSchema.tables));

type OutboxMutationDraft = OutboxMutation extends infer T
  ? T extends OutboxMutation
    ? Omit<T, "versionstamp"> & { versionstamp?: string }
    : never
  : never;

export type OutboxPlan = {
  drafts: OutboxMutationDraft[];
  lookups: OutboxRefLookup[];
};

export function buildOutboxPlan(operations: MutationOperation<AnySchema>[]): OutboxPlan {
  const drafts: OutboxMutationDraft[] = [];
  const lookups: OutboxRefLookup[] = [];

  for (const op of operations) {
    if (op.type === "check") {
      continue;
    }

    if (isInternalMutation(op)) {
      continue;
    }

    const table = getTable(op.schema, op.table);
    const schemaName = op.namespace ?? "";
    const namespace = op.namespace ? op.namespace : undefined;
    const mutationIndex = drafts.length;

    if (op.type === "create") {
      drafts.push({
        op: "create",
        schema: schemaName,
        namespace,
        table: op.table,
        externalId: op.generatedExternalId,
        values: encodeOutboxValues({
          table,
          values: op.values,
          mutationIndex,
          namespace,
          lookups,
        }),
      });
      continue;
    }

    if (op.type === "update") {
      drafts.push({
        op: "update",
        schema: schemaName,
        namespace,
        table: op.table,
        externalId: getExternalId(op.id),
        set: encodeOutboxValues({
          table,
          values: op.set,
          mutationIndex,
          namespace,
          lookups,
        }),
        checkVersion: op.checkVersion && op.id instanceof FragnoId ? op.id.version : undefined,
      });
      continue;
    }

    if (op.type === "delete") {
      drafts.push({
        op: "delete",
        schema: schemaName,
        namespace,
        table: op.table,
        externalId: getExternalId(op.id),
        checkVersion: op.checkVersion && op.id instanceof FragnoId ? op.id.version : undefined,
      });
    }
  }

  return { drafts, lookups };
}

export function finalizeOutboxPayload(plan: OutboxPlan, transactionVersion: bigint): OutboxPayload {
  const mutations: OutboxMutation[] = plan.drafts.map((draft, index) => {
    const versionstamp = versionstampToHex(encodeVersionstamp(transactionVersion, index));
    return { ...draft, versionstamp } as OutboxMutation;
  });

  return {
    version: 1,
    mutations,
  };
}

function encodeOutboxValues(options: {
  table: AnyTable;
  values: Record<string, unknown>;
  mutationIndex: number;
  namespace?: string;
  lookups: OutboxRefLookup[];
}): Record<string, unknown> {
  const { table, values, mutationIndex, namespace, lookups } = options;
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }

    const column = table.columns[key];

    if (column?.role === "reference") {
      const resolved = resolveReferenceValue({
        value,
        mutationIndex,
        columnName: key,
        table,
        namespace,
        lookups,
      });
      output[key] = resolved;
      continue;
    }

    if (value instanceof FragnoId) {
      output[key] = value.externalId;
      continue;
    }

    output[key] = value;
  }

  return output;
}

function resolveReferenceValue(options: {
  value: unknown;
  mutationIndex: number;
  columnName: string;
  table: AnyTable;
  namespace?: string;
  lookups: OutboxRefLookup[];
}): unknown {
  const { value, mutationIndex, columnName, table, namespace, lookups } = options;

  if (value === null) {
    return null;
  }

  if (value instanceof FragnoId) {
    return value.externalId;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value instanceof FragnoReference) {
    return createReferencePlaceholder({
      internalId: value.internalId,
      mutationIndex,
      columnName,
      table,
      namespace,
      lookups,
    });
  }

  if (typeof value === "bigint" || typeof value === "number") {
    return createReferencePlaceholder({
      internalId: value,
      mutationIndex,
      columnName,
      table,
      namespace,
      lookups,
    });
  }

  return value;
}

function createReferencePlaceholder(options: {
  internalId: bigint | number;
  mutationIndex: number;
  columnName: string;
  table: AnyTable;
  namespace?: string;
  lookups: OutboxRefLookup[];
}): { __fragno_ref: string } {
  const { internalId, mutationIndex, columnName, table, namespace, lookups } = options;
  const key = `${mutationIndex}.${columnName}`;
  const referencedTable = resolveReferencedTable(table, columnName);

  lookups.push({
    key,
    internalId,
    table: referencedTable,
    namespace,
  });

  return { __fragno_ref: key };
}

function resolveReferencedTable(table: AnyTable, columnName: string): AnyTable {
  for (const relation of Object.values(table.relations)) {
    if (relation.on.some(([localColumn]) => localColumn === columnName)) {
      return relation.table;
    }
  }

  throw new Error(`Reference column ${columnName} not found in table ${table.name}`);
}

function getExternalId(id: FragnoId | string): string {
  return typeof id === "string" ? id : id.externalId;
}

function isInternalMutation(op: MutationOperation<AnySchema>): boolean {
  if (op.schema === internalSchema) {
    return true;
  }

  return op.namespace === "" && INTERNAL_TABLE_NAMES.has(op.table);
}

function getTable(schema: AnySchema, tableName: string): AnyTable {
  const table = schema.tables[tableName];
  if (!table) {
    throw new Error(`Invalid table name ${tableName}.`);
  }
  return table;
}
