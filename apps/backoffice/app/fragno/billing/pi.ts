import type { PiOperationCompletedHookPayload } from "@fragno-dev/pi-harness/types";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { piSessionBillingOrganizationId } from "@/fragno/pi/pi-shared";

import type { BillingEventInput, BillingMeasurementInput } from "./contracts";

const toNanoUsd = (usd: number) => Math.round(usd * 1_000_000_000);

export class PiOperationBillingEventValidationError extends Error {
  constructor() {
    super("Pi operation billing events require at least one model call.");
    this.name = "PiOperationBillingEventValidationError";
  }
}

export class PiOperationBillingOwnerMissingError extends Error {
  constructor(readonly userId: string) {
    super(`PI_SESSION_BILLING_OWNER_MISSING:${userId}`);
    this.name = "PiOperationBillingOwnerMissingError";
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

export const resolvePiOperationBillingOrganizationId = (
  scope: BackofficeContextScope,
  metadata: Record<string, unknown> | null | undefined,
): string | null => {
  switch (scope.kind) {
    case "org":
    case "project":
      return scope.orgId;
    case "user": {
      const organizationId = piSessionBillingOrganizationId(metadata);
      if (!organizationId) {
        throw new PiOperationBillingOwnerMissingError(scope.userId);
      }
      return organizationId;
    }
    case "system":
      return piSessionBillingOrganizationId(metadata) ?? null;
  }

  throw new Error("Unsupported Backoffice context scope kind.");
};

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
      sessionMetadata: input.payload.metadata,
      stepName: input.payload.stepName,
      operationId: input.payload.operationId,
      operation: input.payload.operation,
      actor: input.payload.actor,
      modelCalls: input.payload.modelCalls,
    },
  };
};

export const recordPiOperationBilling = async (input: {
  scope: BackofficeContextScope;
  payload: PiOperationCompletedHookPayload;
  hookId: string;
  idempotencyKey: string;
  recordEvent: (organizationId: string, event: BillingEventInput) => Promise<void>;
}): Promise<{ recorded: boolean; billingOrganizationId: string | null }> => {
  let event: BillingEventInput;
  try {
    event = createPiOperationBillingEvent(input);
  } catch (error) {
    if (error instanceof PiOperationBillingEventValidationError) {
      return { recorded: false, billingOrganizationId: null };
    }
    throw error;
  }

  const billingOrganizationId = resolvePiOperationBillingOrganizationId(
    input.scope,
    input.payload.metadata,
  );
  if (!billingOrganizationId) {
    return { recorded: false, billingOrganizationId: null };
  }

  await input.recordEvent(billingOrganizationId, event);
  return { recorded: true, billingOrganizationId };
};
