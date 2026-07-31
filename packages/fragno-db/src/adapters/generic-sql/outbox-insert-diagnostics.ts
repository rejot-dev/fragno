import superjson from "superjson";

import { describeDiagnosticValue, truncateDiagnosticString } from "../../diagnostics/value-shape";
import type {
  OutboxMutation,
  OutboxPayload,
  OutboxPayloadSerialized,
  OutboxRefMap,
} from "../../outbox/outbox";

const OUTBOX_DIAGNOSTIC_MUTATION_LIMIT = 8;
const OUTBOX_DIAGNOSTIC_FIELD_LIMIT = 8;
const OUTBOX_DIAGNOSTIC_STRING_LIMIT = 160;
const OUTBOX_DIAGNOSTIC_VALUE_SHAPE_OPTIONS = {
  keyLimit: OUTBOX_DIAGNOSTIC_FIELD_LIMIT,
  stringLimit: OUTBOX_DIAGNOSTIC_STRING_LIMIT,
  discriminatorPaths: [
    ["kind"],
    ["type"],
    ["event", "type"],
    ["update", "type"],
    ["assistantMessageEvent", "type"],
  ],
} as const;

export type OutboxInsertDiagnosticContext = {
  id: string;
  versionstamp: string;
  uowId: string;
  payload: OutboxPayload;
  payloadSerialized: OutboxPayloadSerialized;
  refMap?: OutboxRefMap;
};

export type OutboxInsertDiagnostics = {
  id: string;
  versionstamp: string;
  uowId: string;
  mutationCount: number;
  payloadSerializedBytes: number;
  refMapSerializedBytes: number;
  estimatedRowValueBytes: number;
  mutationGroups: {
    schema: string;
    table: string;
    op: OutboxMutation["op"];
    count: number;
    estimatedSerializedBytes: number;
    largestMutationEstimatedBytes: number;
  }[];
  largestMutations: {
    index: number;
    schema: string;
    table: string;
    op: OutboxMutation["op"];
    externalId: string;
    estimatedSerializedBytes: number;
    largestFields: {
      name: string;
      estimatedSerializedBytes: number;
      valueShape: string;
    }[];
  }[];
};

export function buildOutboxInsertDiagnostics(
  options: OutboxInsertDiagnosticContext,
): OutboxInsertDiagnostics {
  const mutationDiagnostics = options.payload.mutations.map((mutation, index) => {
    const mutationValues =
      mutation.op === "create" ? mutation.values : mutation.op === "update" ? mutation.set : {};
    const largestFields = Object.entries(mutationValues)
      .map(([name, value]) => ({
        name,
        estimatedSerializedBytes: superjsonByteSize(value),
        valueShape: describeDiagnosticValue(value, OUTBOX_DIAGNOSTIC_VALUE_SHAPE_OPTIONS),
      }))
      .sort((left, right) => right.estimatedSerializedBytes - left.estimatedSerializedBytes)
      .slice(0, OUTBOX_DIAGNOSTIC_FIELD_LIMIT);

    return {
      index,
      schema: mutation.schema,
      table: mutation.table,
      op: mutation.op,
      externalId: truncateDiagnosticString(mutation.externalId, OUTBOX_DIAGNOSTIC_STRING_LIMIT),
      estimatedSerializedBytes: superjsonByteSize(mutation),
      largestFields,
    };
  });
  const mutationGroups = new Map<string, OutboxInsertDiagnostics["mutationGroups"][number]>();

  for (const mutation of mutationDiagnostics) {
    const key = `${mutation.schema}\u0000${mutation.table}\u0000${mutation.op}`;
    const existing = mutationGroups.get(key);
    if (existing) {
      existing.count += 1;
      existing.estimatedSerializedBytes += mutation.estimatedSerializedBytes;
      existing.largestMutationEstimatedBytes = Math.max(
        existing.largestMutationEstimatedBytes,
        mutation.estimatedSerializedBytes,
      );
      continue;
    }

    mutationGroups.set(key, {
      schema: mutation.schema,
      table: mutation.table,
      op: mutation.op,
      count: 1,
      estimatedSerializedBytes: mutation.estimatedSerializedBytes,
      largestMutationEstimatedBytes: mutation.estimatedSerializedBytes,
    });
  }

  const payloadSerializedBytes = jsonByteSize(options.payloadSerialized);
  const refMapSerializedBytes = options.refMap ? jsonByteSize(options.refMap) : 0;
  const estimatedRowValueBytes =
    utf8ByteSize(options.id) +
    utf8ByteSize(options.versionstamp) +
    utf8ByteSize(options.uowId) +
    payloadSerializedBytes +
    refMapSerializedBytes;

  return {
    id: truncateDiagnosticString(options.id, OUTBOX_DIAGNOSTIC_STRING_LIMIT),
    versionstamp: truncateDiagnosticString(options.versionstamp, OUTBOX_DIAGNOSTIC_STRING_LIMIT),
    uowId: truncateDiagnosticString(options.uowId, OUTBOX_DIAGNOSTIC_STRING_LIMIT),
    mutationCount: options.payload.mutations.length,
    payloadSerializedBytes,
    refMapSerializedBytes,
    estimatedRowValueBytes,
    mutationGroups: [...mutationGroups.values()].sort(
      (left, right) => right.estimatedSerializedBytes - left.estimatedSerializedBytes,
    ),
    largestMutations: mutationDiagnostics
      .sort((left, right) => right.estimatedSerializedBytes - left.estimatedSerializedBytes)
      .slice(0, OUTBOX_DIAGNOSTIC_MUTATION_LIMIT),
  };
}

const utf8ByteSize = (value: string): number => new TextEncoder().encode(value).byteLength;

const jsonByteSize = (value: unknown): number => utf8ByteSize(JSON.stringify(value));

const superjsonByteSize = (value: unknown): number => jsonByteSize(superjson.serialize(value));
