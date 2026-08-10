import superjson from "superjson";

import { describeDiagnosticValue, truncateDiagnosticString } from "../../diagnostics/value-shape";
import type {
  OutboxOperation,
  OutboxPayload,
  OutboxPayloadSerialized,
  OutboxRefMap,
} from "../../outbox/outbox";

const OUTBOX_DIAGNOSTIC_OPERATION_LIMIT = 8;
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
  operationCount: number;
  payloadSerializedBytes: number;
  refMapSerializedBytes: number;
  estimatedRowValueBytes: number;
  operationGroups: {
    schema: string;
    table: string;
    op: OutboxOperation["op"];
    count: number;
    estimatedSerializedBytes: number;
    largestOperationEstimatedBytes: number;
  }[];
  largestOperations: {
    index: number;
    schema: string;
    table: string;
    op: OutboxOperation["op"];
    externalId?: string;
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
  const operationDiagnostics = options.payload.operations.map((operation, index) => {
    const operationValues =
      operation.op === "create"
        ? operation.values
        : operation.op === "update"
          ? operation.set
          : operation.op === "truncate"
            ? operation.match
            : {};
    const largestFields = Object.entries(operationValues)
      .map(([name, value]) => ({
        name,
        estimatedSerializedBytes: superjsonByteSize(value),
        valueShape: describeDiagnosticValue(value, OUTBOX_DIAGNOSTIC_VALUE_SHAPE_OPTIONS),
      }))
      .sort((left, right) => right.estimatedSerializedBytes - left.estimatedSerializedBytes)
      .slice(0, OUTBOX_DIAGNOSTIC_FIELD_LIMIT);

    return {
      index,
      schema: operation.schema,
      table: operation.table,
      op: operation.op,
      ...(operation.op !== "truncate"
        ? {
            externalId: truncateDiagnosticString(
              operation.externalId,
              OUTBOX_DIAGNOSTIC_STRING_LIMIT,
            ),
          }
        : {}),
      estimatedSerializedBytes: superjsonByteSize(operation),
      largestFields,
    };
  });
  const operationGroups = new Map<string, OutboxInsertDiagnostics["operationGroups"][number]>();

  for (const operation of operationDiagnostics) {
    const key = `${operation.schema}\u0000${operation.table}\u0000${operation.op}`;
    const existing = operationGroups.get(key);
    if (existing) {
      existing.count += 1;
      existing.estimatedSerializedBytes += operation.estimatedSerializedBytes;
      existing.largestOperationEstimatedBytes = Math.max(
        existing.largestOperationEstimatedBytes,
        operation.estimatedSerializedBytes,
      );
      continue;
    }

    operationGroups.set(key, {
      schema: operation.schema,
      table: operation.table,
      op: operation.op,
      count: 1,
      estimatedSerializedBytes: operation.estimatedSerializedBytes,
      largestOperationEstimatedBytes: operation.estimatedSerializedBytes,
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
    operationCount: options.payload.operations.length,
    payloadSerializedBytes,
    refMapSerializedBytes,
    estimatedRowValueBytes,
    operationGroups: [...operationGroups.values()].sort(
      (left, right) => right.estimatedSerializedBytes - left.estimatedSerializedBytes,
    ),
    largestOperations: operationDiagnostics
      .sort((left, right) => right.estimatedSerializedBytes - left.estimatedSerializedBytes)
      .slice(0, OUTBOX_DIAGNOSTIC_OPERATION_LIMIT),
  };
}

const utf8ByteSize = (value: string): number => new TextEncoder().encode(value).byteLength;

const jsonByteSize = (value: unknown): number => utf8ByteSize(JSON.stringify(value));

const superjsonByteSize = (value: unknown): number => jsonByteSize(superjson.serialize(value));
