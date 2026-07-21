import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { AnySchema, AnyTable, FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import superjson, { type SuperJSONResult } from "superjson";

import type { OutboxEntry, OutboxMutation, OutboxPayload } from "@fragno-dev/db";

import type { ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";

export type FragnoCollectionTarget<
  TSchema extends AnySchema = AnySchema,
  TTableName extends keyof TSchema["tables"] & string = keyof TSchema["tables"] & string,
> = {
  schema: TSchema;
  table: TTableName;
  /** Defaults to the schema name. Use null for the empty physical namespace. */
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
      metadata: FragnoRowSyncMetadata;
    }
  | {
      type: "update";
      key: string;
      value: Partial<TRow>;
      metadata: FragnoRowSyncMetadata;
    }
  | {
      type: "delete";
      key: string;
      metadata: FragnoRowSyncMetadata;
    };

export type FragnoRowSyncMetadata = {
  versionstamp: string;
  uowId: string;
};

export function decodeFragnoOutboxPayload(payload: unknown): OutboxPayload {
  const decoded = superjson.deserialize(payload as SuperJSONResult) as unknown;

  if (!isRecord(decoded)) {
    throw new Error("Invalid Fragno outbox payload.");
  }
  if (decoded["version"] !== 1) {
    throw new Error(`Unsupported Fragno outbox payload version: ${String(decoded["version"])}.`);
  }
  if (!Array.isArray(decoded["mutations"])) {
    throw new Error("Invalid Fragno outbox mutations.");
  }

  for (const mutation of decoded["mutations"]) {
    const operation = isRecord(mutation) ? mutation["op"] : undefined;
    if (operation !== "create" && operation !== "update" && operation !== "delete") {
      throw new Error(`Unsupported Fragno outbox mutation operation: ${String(operation)}.`);
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
  const targetNamespace = resolveTargetNamespace(target);
  const table = target.schema.tables[target.table];
  const externalIdColumnName = table.getIdColumn().name;
  const metadata = {
    versionstamp: entry.versionstamp,
    uowId: entry.uowId,
  } satisfies FragnoRowSyncMetadata;

  const changes: FragnoCollectionChange<FragnoCollectionRow<TSchema["tables"][TTableName]>>[] = [];

  for (const mutation of payload.mutations) {
    if (resolveMutationNamespace(mutation) !== targetNamespace || mutation.table !== target.table) {
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
        } as FragnoCollectionRow<TSchema["tables"][TTableName]>,
        metadata,
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
        } as Partial<FragnoCollectionRow<TSchema["tables"][TTableName]>>,
        metadata,
      });
      continue;
    }

    changes.push({
      type: "delete",
      key: resolvedMutation.externalId,
      metadata,
    });
  }

  return changes;
}

/** Converts the protocol plan to TanStack messages at the sync boundary. */
export function toTanStackChangeMessage<TRow extends object>(
  change: FragnoCollectionChange<TRow>,
): ChangeMessageOrDeleteKeyMessage<TRow, string> {
  if (change.type === "delete") {
    return {
      type: "delete",
      key: change.key,
      metadata: change.metadata,
    };
  }

  return {
    type: change.type,
    value: change.value as TRow,
    metadata: change.metadata,
  };
}

export function resolveTargetNamespace(target: FragnoCollectionTarget): string {
  if (target.namespace === null) {
    return "";
  }

  return target.namespace ?? target.schema.name;
}

function resolveMutationNamespace(mutation: OutboxMutation): string {
  return mutation.namespace ?? mutation.schema;
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
