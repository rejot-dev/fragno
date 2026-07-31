import type { BufferedFlushContext } from "@fragno-dev/db/buffered-pump";
import {
  describeDiagnosticValue,
  truncateDiagnosticString,
} from "@fragno-dev/db/diagnostics/value-shape";

const STEP_EMISSION_DIAGNOSTIC_ITEM_LIMIT = 8;
const STEP_EMISSION_DIAGNOSTIC_INSPECTION_LIMIT = 64;
const STEP_EMISSION_DIAGNOSTIC_STRING_LIMIT = 160;
const STEP_EMISSION_DIAGNOSTIC_VALUE_SHAPE_OPTIONS = {
  keyLimit: STEP_EMISSION_DIAGNOSTIC_ITEM_LIMIT,
  stringLimit: STEP_EMISSION_DIAGNOSTIC_STRING_LIMIT,
  discriminatorPaths: [["kind"], ["type"], ["event", "type"], ["update", "type"]],
} as const;

export const buildFailedStepEmissionFlushDiagnostics = <
  TOutEmission,
  TScopeMeta extends { epoch: string },
>(options: {
  workflowName: string;
  instanceId: string;
  context?: BufferedFlushContext<TOutEmission, TScopeMeta>;
}) => {
  const scopes = options.context ? [...options.context.scopes] : [];
  const outgoingCount = options.context
    ? [...options.context.batch.outgoingByScope.values()].reduce(
        (total, outgoing) => total + outgoing.length,
        0,
      )
    : 0;
  const scopedOutgoingCount = scopes.reduce(
    (total, [scopeKey]) =>
      total + (options.context?.batch.outgoingByScope.get(scopeKey)?.length ?? 0),
    0,
  );
  const sampledOrdinals = evenlySpacedIndexes(
    scopedOutgoingCount,
    STEP_EMISSION_DIAGNOSTIC_INSPECTION_LIMIT,
  );
  let sampledOrdinalCursor = 0;
  let outgoingOffset = 0;
  let inspectedOutgoingCount = 0;

  const scopeDiagnostics = scopes.map(([scopeKey, scope]) => {
    const outgoing = options.context?.batch.outgoingByScope.get(scopeKey) ?? [];
    const scopeEndOffset = outgoingOffset + outgoing.length;
    const sampledIndexes: number[] = [];

    while (
      sampledOrdinalCursor < sampledOrdinals.length &&
      sampledOrdinals[sampledOrdinalCursor] < scopeEndOffset
    ) {
      sampledIndexes.push(sampledOrdinals[sampledOrdinalCursor] - outgoingOffset);
      sampledOrdinalCursor += 1;
    }
    outgoingOffset = scopeEndOffset;

    const inspectedOutgoing = sampledIndexes
      .map((index) => {
        const payload = outgoing[index];
        return {
          index,
          serializedBytes: serializedByteSize(payload),
          valueShape: describeDiagnosticValue(
            payload,
            STEP_EMISSION_DIAGNOSTIC_VALUE_SHAPE_OPTIONS,
          ),
        };
      })
      .sort((left, right) => (right.serializedBytes ?? -1) - (left.serializedBytes ?? -1));
    inspectedOutgoingCount += inspectedOutgoing.length;

    return {
      stepKey: truncateDiagnosticString(scopeKey, STEP_EMISSION_DIAGNOSTIC_STRING_LIMIT),
      epoch: truncateDiagnosticString(scope.meta.epoch, STEP_EMISSION_DIAGNOSTIC_STRING_LIMIT),
      closed: scope.closed,
      outgoingCount: outgoing.length,
      inspectedOutgoingCount: inspectedOutgoing.length,
      inspectionTruncated: inspectedOutgoing.length < outgoing.length,
      inspectedOutgoingSerializedBytes: inspectedOutgoing.reduce(
        (total, item) => total + (item.serializedBytes ?? 0),
        0,
      ),
      unmeasurableInspectedOutgoingCount: inspectedOutgoing.filter(
        (item) => item.serializedBytes === null,
      ).length,
      largestInspectedOutgoingItems: inspectedOutgoing.slice(
        0,
        STEP_EMISSION_DIAGNOSTIC_ITEM_LIMIT,
      ),
    };
  });

  return {
    workflowName: truncateDiagnosticString(
      options.workflowName,
      STEP_EMISSION_DIAGNOSTIC_STRING_LIMIT,
    ),
    instanceId: truncateDiagnosticString(options.instanceId, STEP_EMISSION_DIAGNOSTIC_STRING_LIMIT),
    scopeCount: options.context?.scopes.size ?? 0,
    outgoingCount,
    inspectedOutgoingCount,
    inspectionTruncated: inspectedOutgoingCount < outgoingCount,
    scopes: scopeDiagnostics,
  };
};

function evenlySpacedIndexes(itemCount: number, inspectionLimit: number): number[] {
  const inspectedItemCount = Math.min(itemCount, inspectionLimit);
  if (inspectedItemCount === 0) {
    return [];
  }
  if (inspectedItemCount === 1) {
    return [0];
  }

  return Array.from({ length: inspectedItemCount }, (_, index) =>
    Math.floor((index * (itemCount - 1)) / (inspectedItemCount - 1)),
  );
}

function serializedByteSize(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
    );
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}
