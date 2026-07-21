import superjson, { type SuperJSONResult } from "superjson";

import type { ChangeEvent, StateEvent } from "@durable-streams/state";

import type { OutboxEntry, OutboxMutation, OutboxStreamEntry } from "./outbox";
import { parseOutboxStreamEntry } from "./outbox";

export const FRAGNO_STATE_VALUE_VERSION = 1 as const;

export type FragnoStateValueMode = "row" | "patch";

/**
 * JSON-compatible value envelope used by Fragno State Protocol events.
 *
 * State Protocol values are JSON, while Fragno rows may contain Dates, bigints, binary values, and
 * nested JSON containing those values. SuperJSON keeps that runtime representation independent of
 * the transport without adding non-standard State Protocol headers.
 */
export type FragnoStateValue = {
  $fragno: {
    version: typeof FRAGNO_STATE_VALUE_VERSION;
    mode: FragnoStateValueMode;
    value: SuperJSONResult;
  };
};

export type FragnoStateChangeEvent = ChangeEvent<FragnoStateValue>;
export type FragnoStateEvent = StateEvent<FragnoStateValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertNoUnresolvedDatabaseExpressions = (
  mutation: Exclude<OutboxMutation, { op: "delete" }>,
  values: Record<string, unknown>,
): void => {
  for (const [columnName, value] of Object.entries(values)) {
    if (isRecord(value) && value["tag"] === "db-now") {
      throw new Error(
        `Outbox mutation ${mutation.schemaName ?? mutation.schema}.${mutation.table}.${columnName} contains unresolved DbNow while projecting State Protocol.`,
      );
    }
  }
};

const resolveReferencePlaceholders = (
  values: Record<string, unknown>,
  refMap: Record<string, string>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values).map(([columnName, value]) => {
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 1 ||
        typeof value["__fragno_ref"] !== "string"
      ) {
        return [columnName, value];
      }

      const referenceKey = value["__fragno_ref"];
      const externalId = refMap[referenceKey];
      if (!externalId) {
        throw new Error(`Outbox ref ${referenceKey} not found while projecting State Protocol.`);
      }
      return [columnName, externalId];
    }),
  );

const streamEntryFromStoredEntry = (entry: OutboxEntry): OutboxStreamEntry =>
  parseOutboxStreamEntry({
    id: {
      externalId: entry.id.externalId,
      ...(entry.id.internalId === undefined ? {} : { internalId: String(entry.id.internalId) }),
    },
    versionstamp: entry.versionstamp,
    uowId: entry.uowId,
    payload: entry.payload,
    ...(entry.refMap === undefined ? {} : { refMap: entry.refMap }),
    createdAt: entry.createdAt.toISOString(),
  });

/** Stable, collision-free State Protocol event type for one physical Fragno table. */
export function createFragnoStateEventType(options: {
  schemaName: string;
  namespace: string | null;
  tableName: string;
}): string {
  return `fragno:${JSON.stringify([options.schemaName, options.namespace, options.tableName])}`;
}

export function encodeFragnoStateValue(
  mode: FragnoStateValueMode,
  value: Record<string, unknown>,
): FragnoStateValue {
  return {
    $fragno: {
      version: FRAGNO_STATE_VALUE_VERSION,
      mode,
      value: superjson.serialize(value),
    },
  };
}

export function decodeFragnoStateValue(value: unknown): {
  mode: FragnoStateValueMode;
  value: Record<string, unknown>;
} {
  if (!isRecord(value) || !isRecord(value["$fragno"])) {
    throw new Error("Fragno State Protocol value must contain a $fragno envelope.");
  }

  const envelope = value["$fragno"];
  if (
    envelope["version"] !== FRAGNO_STATE_VALUE_VERSION ||
    (envelope["mode"] !== "row" && envelope["mode"] !== "patch") ||
    !isRecord(envelope["value"]) ||
    !("json" in envelope["value"])
  ) {
    throw new Error("Fragno State Protocol value envelope is invalid.");
  }

  let decoded: unknown;
  try {
    decoded = superjson.deserialize(envelope["value"] as unknown as SuperJSONResult);
  } catch (error) {
    throw new Error("Fragno State Protocol value could not be decoded.", { cause: error });
  }

  if (!isRecord(decoded)) {
    throw new Error("Fragno State Protocol value must decode to a row object.");
  }

  return { mode: envelope["mode"], value: decoded };
}

const mutationEventType = (mutation: OutboxMutation): string =>
  createFragnoStateEventType({
    schemaName: mutation.schemaName ?? mutation.schema,
    namespace: mutation.namespace ?? null,
    tableName: mutation.table,
  });

export function projectOutboxStreamEntryToStateEvents(
  streamEntry: OutboxStreamEntry,
): FragnoStateChangeEvent[] {
  const sharedHeaders = {
    txid: streamEntry.uowId,
    timestamp: streamEntry.createdAt.toISOString(),
  };

  return streamEntry.payload.mutations.map((mutation): FragnoStateChangeEvent => {
    const shared = {
      type: mutationEventType(mutation),
      key: mutation.externalId,
    };

    if (mutation.op === "delete") {
      return {
        ...shared,
        headers: { ...sharedHeaders, operation: "delete" },
      };
    }

    const rawValues = mutation.op === "create" ? mutation.values : mutation.set;
    assertNoUnresolvedDatabaseExpressions(mutation, rawValues);
    const encodedValues = resolveReferencePlaceholders(rawValues, streamEntry.refMap ?? {});

    return {
      ...shared,
      value: encodeFragnoStateValue(mutation.op === "create" ? "row" : "patch", encodedValues),
      headers: {
        ...sharedHeaders,
        operation: mutation.op === "create" ? "insert" : "update",
      },
    };
  });
}

export function projectOutboxEntryToStateEvents(entry: OutboxEntry): FragnoStateChangeEvent[] {
  return projectOutboxStreamEntryToStateEvents(streamEntryFromStoredEntry(entry));
}

export function projectOutboxEntriesToStateEvents(
  entries: readonly OutboxEntry[],
): FragnoStateChangeEvent[] {
  return entries.flatMap(projectOutboxEntryToStateEvents);
}
