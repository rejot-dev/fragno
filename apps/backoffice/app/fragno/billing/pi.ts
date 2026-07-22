import type { PiOperationCompletedHookPayload } from "@fragno-dev/pi-harness/types";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";

import type { BillingEventInput, BillingMeasurementInput } from "./contracts";

const toNanoUsd = (usd: number) => Math.round(usd * 1_000_000_000);

export class PiOperationBillingEventValidationError extends Error {
  constructor() {
    super("Pi operation billing events require at least one model call.");
    this.name = "PiOperationBillingEventValidationError";
  }
}

const piUsageMeasurements = (
  usage: PiOperationCompletedHookPayload["usage"],
): BillingMeasurementInput[] => [
  { meter: "ai.tokens.input", unit: "token", quantity: usage.input },
  { meter: "ai.tokens.output", unit: "token", quantity: usage.output },
  { meter: "ai.tokens.cache-read", unit: "token", quantity: usage.cacheRead },
  { meter: "ai.tokens.cache-write", unit: "token", quantity: usage.cacheWrite },
  { meter: "ai.tokens.total", unit: "token", quantity: usage.totalTokens },
  { meter: "ai.cost.input", unit: "nano-usd", quantity: toNanoUsd(usage.cost.input) },
  { meter: "ai.cost.output", unit: "nano-usd", quantity: toNanoUsd(usage.cost.output) },
  { meter: "ai.cost.cache-read", unit: "nano-usd", quantity: toNanoUsd(usage.cost.cacheRead) },
  { meter: "ai.cost.cache-write", unit: "nano-usd", quantity: toNanoUsd(usage.cost.cacheWrite) },
  { meter: "ai.cost.total", unit: "nano-usd", quantity: toNanoUsd(usage.cost.total) },
];

export const createPiOperationBillingEvent = (input: {
  scope: BackofficeContextScope;
  payload: PiOperationCompletedHookPayload;
  hookId: string;
  idempotencyKey: string;
}): BillingEventInput => {
  const occurredAt = input.payload.modelCalls.reduce<number | null>(
    (latest, call) => (latest === null ? call.timestamp : Math.max(latest, call.timestamp)),
    null,
  );
  if (occurredAt === null) {
    throw new PiOperationBillingEventValidationError();
  }

  return {
    id: `pi:${backofficeContextScopeSinglePathSegment(input.scope)}:${input.hookId}`,
    scope: input.scope,
    source: "pi-harness",
    eventType: "operation.completed",
    occurredAt: new Date(occurredAt).toISOString(),
    measurements: piUsageMeasurements(input.payload.usage),
    metadata: {
      idempotencyKey: input.idempotencyKey,
      workflowName: input.payload.workflowName,
      sessionId: input.payload.sessionId,
      agentName: input.payload.agentName,
      stepName: input.payload.stepName,
      operationId: input.payload.operationId,
      operation: input.payload.operation,
      actor: input.payload.actor,
      modelCalls: input.payload.modelCalls,
    },
  };
};
