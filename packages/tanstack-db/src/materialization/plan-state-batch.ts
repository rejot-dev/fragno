import type { AnyTable } from "@fragno-dev/db/schema";
import { decodeFragnoStateValue } from "@fragno-dev/db/state-protocol";

import type { StateEvent } from "@durable-streams/state";

import type { AnyFragnoStateSchema } from "../state/fragno-state-schema";

export type RegisteredStateCollection = {
  readonly name: string;
  readonly eventType: string;
  readonly primaryKey: string;
  readonly table: AnyTable;
  readonly tableKey: string;
};

export type StateRegistry = {
  readonly collections: ReadonlyMap<string, RegisteredStateCollection>;
  readonly collectionsByEventType: ReadonlyMap<string, RegisteredStateCollection>;
};

export type PlannedStateChange =
  | {
      readonly type: "put";
      readonly collection: RegisteredStateCollection;
      readonly key: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly type: "delete";
      readonly collection: RegisteredStateCollection;
      readonly key: string;
    };

export type MaterializationPlan = {
  readonly reset: boolean;
  readonly changes: readonly PlannedStateChange[];
  readonly txids: readonly string[];
};

export type ReadMaterializedRow = (
  collection: RegisteredStateCollection,
  key: string,
) => Record<string, unknown> | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createStateRegistry(
  state: AnyFragnoStateSchema,
  options: {
    tableKeyFor?: (definition: AnyFragnoStateSchema[string]) => string;
  } = {},
): StateRegistry {
  const collections = new Map<string, RegisteredStateCollection>();
  const collectionsByEventType = new Map<string, RegisteredStateCollection>();

  for (const [name, definition] of Object.entries(state)) {
    const registered: RegisteredStateCollection = {
      name,
      eventType: definition.type,
      primaryKey: definition.primaryKey,
      table: definition.fragno.table,
      tableKey: options.tableKeyFor?.(definition) ?? definition.type,
    };
    collections.set(name, registered);
    collectionsByEventType.set(definition.type, registered);
  }

  return { collections, collectionsByEventType };
}

const invalidEvent = (path: string, message: string): never => {
  throw new Error(`Invalid Durable Streams State Protocol event at ${path}: ${message}`);
};

const parseEvent = (
  value: unknown,
  index: number,
):
  | { kind: "control"; control: "snapshot-start" | "snapshot-end" | "reset" }
  | {
      kind: "change";
      type: string;
      key: string;
      operation: "insert" | "update" | "delete" | "upsert";
      value?: unknown;
      txid?: string;
    } => {
  const path = `items[${index}]`;
  if (!isRecord(value) || !isRecord(value["headers"])) {
    return invalidEvent(path, "expected an object with headers");
  }

  const headers = value["headers"];
  const control = headers["control"];
  if (control !== undefined) {
    if (control !== "snapshot-start" && control !== "snapshot-end" && control !== "reset") {
      return invalidEvent(`${path}.headers.control`, "expected a supported control event");
    }
    return { kind: "control", control };
  }

  const operation = headers["operation"];
  if (
    operation !== "insert" &&
    operation !== "update" &&
    operation !== "delete" &&
    operation !== "upsert"
  ) {
    return invalidEvent(`${path}.headers.operation`, "expected insert, update, delete, or upsert");
  }
  if (typeof value["type"] !== "string" || value["type"].length === 0) {
    return invalidEvent(`${path}.type`, "expected a non-empty string");
  }
  if (typeof value["key"] !== "string" || value["key"].length === 0) {
    return invalidEvent(`${path}.key`, "expected a non-empty string");
  }
  if (headers["txid"] !== undefined && typeof headers["txid"] !== "string") {
    return invalidEvent(`${path}.headers.txid`, "expected a string when present");
  }
  if (operation !== "delete" && value["value"] === undefined) {
    return invalidEvent(`${path}.value`, `required for ${operation}`);
  }

  return {
    kind: "change",
    type: value["type"],
    key: value["key"],
    operation,
    ...(value["value"] === undefined ? {} : { value: value["value"] }),
    ...(headers["txid"] === undefined ? {} : { txid: headers["txid"] }),
  };
};

const completeReplayableRow = (
  collection: RegisteredStateCollection,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const completed = { ...row };
  for (const column of Object.values(collection.table.columns)) {
    if (column.isHidden || column.role === "external-id" || completed[column.name] !== undefined) {
      continue;
    }

    if (column.default && "value" in column.default) {
      completed[column.name] = column.default.value;
    } else if (column.isNullable) {
      completed[column.name] = null;
    }
  }
  return completed;
};

const validateMaterializedRow = (
  collection: RegisteredStateCollection,
  key: string,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const suppliedPrimaryKey = row[collection.primaryKey];
  if (suppliedPrimaryKey !== undefined && suppliedPrimaryKey !== key) {
    throw new Error(
      `State event key ${key} conflicts with ${collection.table.name}.${collection.primaryKey}.`,
    );
  }

  let validated: Record<string, unknown>;
  try {
    validated = collection.table.validate(
      { ...row, [collection.primaryKey]: key },
      { unknownKeys: "strict" },
    ) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid streamed row for ${collection.table.name}.`, { cause: error });
  }

  for (const column of Object.values(collection.table.columns)) {
    if (column.isHidden) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(validated, column.name)) {
      throw new Error(
        `Invalid streamed row for ${collection.table.name}: ${column.name} must be materialized.`,
      );
    }

    const columnValue = validated[column.name];
    if (column.role === "external-id" && typeof columnValue !== "string") {
      throw new Error(
        `Invalid streamed row for ${collection.table.name}: ${column.name} must be a string.`,
      );
    }
    if (column.role === "reference" && columnValue !== null && typeof columnValue !== "string") {
      throw new Error(
        `Invalid streamed row for ${collection.table.name}: ${column.name} must be an external ID string.`,
      );
    }
  }

  return validated;
};

const virtualRowKey = (collection: RegisteredStateCollection, key: string): string =>
  JSON.stringify([collection.eventType, key]);

/** Build and validate the complete state transition before opening a TanStack transaction. */
export function planStateBatch(options: {
  registry: StateRegistry;
  items: readonly unknown[];
  readRow: ReadMaterializedRow;
  onEvent?: (event: StateEvent) => void;
}): MaterializationPlan {
  const { registry, items, readRow } = options;
  const changes: PlannedStateChange[] = [];
  const txids = new Set<string>();
  const virtualRows = new Map<string, Record<string, unknown> | null>();
  let reset = false;

  const currentRow = (collection: RegisteredStateCollection, key: string) => {
    const virtualKey = virtualRowKey(collection, key);
    if (virtualRows.has(virtualKey)) {
      return virtualRows.get(virtualKey) ?? undefined;
    }
    return reset ? undefined : readRow(collection, key);
  };

  for (const [index, rawEvent] of items.entries()) {
    const event = parseEvent(rawEvent as StateEvent, index);
    options.onEvent?.(rawEvent as StateEvent);
    if (event.kind === "control") {
      if (event.control === "reset") {
        reset = true;
        changes.length = 0;
        virtualRows.clear();
      }
      continue;
    }

    const collection = registry.collectionsByEventType.get(event.type);
    if (!collection) {
      continue;
    }
    if (event.txid) {
      txids.add(event.txid);
    }

    const virtualKey = virtualRowKey(collection, event.key);
    const existing = currentRow(collection, event.key);
    if (event.operation === "delete") {
      if (existing) {
        changes.push({ type: "delete", collection, key: event.key });
        virtualRows.set(virtualKey, null);
      }
      continue;
    }

    const decoded = decodeFragnoStateValue(event.value);
    if (decoded.mode === "patch" && !existing) {
      continue;
    }

    const nextRow = validateMaterializedRow(
      collection,
      event.key,
      decoded.mode === "patch"
        ? { ...existing, ...decoded.value }
        : completeReplayableRow(collection, decoded.value),
    );
    changes.push({ type: "put", collection, key: event.key, value: nextRow });
    virtualRows.set(virtualKey, nextRow);
  }

  return { reset, changes, txids: [...txids] };
}
