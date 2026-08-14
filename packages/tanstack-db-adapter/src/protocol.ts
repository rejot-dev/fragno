import { resolveDatabaseNamespace } from "@fragno-dev/db/database-namespace";
import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { AnySchema, AnyTable, FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import superjson, { type SuperJSONResult } from "superjson";

import type {
  OutboxEntry,
  OutboxMatchScalar,
  OutboxMutation,
  OutboxOperation,
  OutboxPayload,
} from "@fragno-dev/db";

import type { ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";

export type FragnoCollectionTarget<
  TSchema extends AnySchema = AnySchema,
  TTableName extends keyof TSchema["tables"] & string = keyof TSchema["tables"] & string,
> = {
  schema: TSchema;
  table: TTableName;
  /** Defaults to the schema's sanitized database namespace. Use null for no namespace. */
  namespace?: string | null;
};

type MaterializedColumnValue<TValue> = TValue extends FragnoId | FragnoReference ? string : TValue;

type VisibleTableValues<TTable extends AnyTable> = TableToColumnValues<TTable>;

export type FragnoCollectionRow<TTable extends AnyTable> = {
  [TColumnName in keyof VisibleTableValues<TTable> as [
    VisibleTableValues<TTable>[TColumnName],
  ] extends [null]
    ? never
    : TColumnName]: MaterializedColumnValue<VisibleTableValues<TTable>[TColumnName]>;
};

export type FragnoOutboxEntry = Pick<OutboxEntry, "versionstamp" | "uowId" | "payload" | "refMap">;

export type FragnoCollectionChange<TRow extends object> =
  | {
      type: "insert";
      key: string;
      value: TRow;
    }
  | {
      type: "update";
      key: string;
      value: Partial<TRow>;
    }
  | {
      type: "delete";
      key: string;
      origin: "delete" | "truncate";
    };

export function decodeFragnoOutboxPayload(payload: unknown): OutboxPayload {
  const decoded = superjson.deserialize(payload as SuperJSONResult) as unknown;

  if (!isRecord(decoded)) {
    throw new Error("Invalid Fragno outbox payload.");
  }
  if (decoded["version"] !== 2) {
    throw new Error(`Unsupported Fragno outbox payload version: ${String(decoded["version"])}.`);
  }
  if (!Array.isArray(decoded["operations"])) {
    throw new Error("Invalid Fragno outbox operations.");
  }

  for (const mutation of decoded["operations"]) {
    if (!isRecord(mutation)) {
      throw new Error("Invalid Fragno outbox mutation.");
    }

    const operation = mutation["op"];
    if (
      operation !== "create" &&
      operation !== "update" &&
      operation !== "delete" &&
      operation !== "truncate"
    ) {
      throw new Error(`Unsupported Fragno outbox mutation operation: ${String(operation)}.`);
    }
    if (operation === "truncate") {
      const match = mutation["match"];
      if (!isRecord(match)) {
        throw new Error("Fragno outbox truncate match must be an object.");
      }
      if (!Object.values(match).every(isOutboxMatchScalar)) {
        throw new Error("Fragno outbox truncate match values must be scalars.");
      }
      const externalIds = mutation["externalIds"];
      if (
        !Array.isArray(externalIds) ||
        externalIds.length === 0 ||
        !externalIds.every((externalId) => typeof externalId === "string" && externalId.length > 0)
      ) {
        throw new Error("Fragno outbox truncate external IDs must be non-empty strings.");
      }
    }
  }

  return decoded as OutboxPayload;
}

export function projectFragnoOutboxEntry<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
>(
  entry: FragnoOutboxEntry,
  target: FragnoCollectionTarget<TSchema, TTableName>,
): FragnoCollectionChange<FragnoCollectionRow<TSchema["tables"][TTableName]>>[] {
  const payload = decodeFragnoOutboxPayload(entry.payload);
  const targetNamespace = resolveDatabaseNamespace(target.schema.name, target.namespace) ?? "";
  const operations = payload.operations.filter((operation) => {
    const operationTarget = fragnoOutboxOperationTarget(operation);
    return operationTarget.namespace === targetNamespace && operationTarget.table === target.table;
  });
  return projectFragnoOutboxOperations(entry, operations, target);
}

export function projectFragnoOutboxOperations<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
>(
  entry: FragnoOutboxEntry,
  operations: readonly OutboxOperation[],
  target: FragnoCollectionTarget<TSchema, TTableName>,
): FragnoCollectionChange<FragnoCollectionRow<TSchema["tables"][TTableName]>>[] {
  type Row = FragnoCollectionRow<TSchema["tables"][TTableName]>;

  const table = target.schema.tables[target.table];
  const externalIdColumnName = table.getIdColumn().name;
  const changes: FragnoCollectionChange<Row>[] = [];

  for (const mutation of operations) {
    if (mutation.op === "truncate") {
      for (const externalId of mutation.externalIds) {
        changes.push({
          type: "delete",
          key: externalId,
          origin: "truncate",
        });
      }
      continue;
    }

    const resolvedMutation = resolveMutationRefs(mutation, table, entry.refMap ?? {});
    if (resolvedMutation.op === "create") {
      changes.push({
        type: "insert",
        key: resolvedMutation.externalId,
        value: {
          ...resolvedMutation.values,
          [externalIdColumnName]: resolvedMutation.externalId,
        } as Row,
      });
      continue;
    }

    if (resolvedMutation.op === "update") {
      changes.push({
        type: "update",
        key: resolvedMutation.externalId,
        value: {
          ...resolvedMutation.set,
          [externalIdColumnName]: resolvedMutation.externalId,
        } as Partial<Row>,
      });
      continue;
    }

    changes.push({
      type: "delete",
      key: resolvedMutation.externalId,
      origin: "delete",
    });
  }

  return changes;
}

export function fragnoOutboxOperationTarget(operation: OutboxOperation): {
  namespace: string;
  table: string;
} {
  return {
    namespace: operation.namespace ?? operation.schema,
    table: operation.table,
  };
}

/** Converts the protocol plan to TanStack messages at the sync boundary. */
export function toTanStackChangeMessage<TRow extends object>(
  change: FragnoCollectionChange<TRow>,
): ChangeMessageOrDeleteKeyMessage<TRow, string> {
  if (change.type === "delete") {
    return {
      type: "delete",
      key: change.key,
    };
  }

  return {
    type: change.type,
    value: change.value as TRow,
  };
}

function isOutboxMatchScalar(value: unknown): value is OutboxMatchScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  );
}

function resolveMutationRefs(
  mutation: OutboxMutation,
  table: AnyTable,
  refMap: Record<string, string>,
): OutboxMutation {
  if (mutation.op === "create") {
    return { ...mutation, values: resolveRecordRefs(mutation.values, table, refMap) };
  }

  if (mutation.op === "update") {
    return { ...mutation, set: resolveRecordRefs(mutation.set, table, refMap) };
  }

  return mutation;
}

function resolveRecordRefs(
  values: Record<string, unknown>,
  table: AnyTable,
  refMap: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (table.columns[key]?.role !== "reference" || !isReferencePlaceholder(value)) {
        return [key, value];
      }

      const resolved = refMap[value.__fragno_ref];
      if (resolved === undefined) {
        throw new Error(`Fragno outbox reference ${value.__fragno_ref} was not resolved.`);
      }

      return [key, resolved];
    }),
  );
}

function isReferencePlaceholder(value: unknown): value is { __fragno_ref: string } {
  return (
    isRecord(value) && Object.keys(value).length === 1 && typeof value["__fragno_ref"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
