import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import type { BillingEventInput, BillingMeasurementInput } from "./contracts";

export type PiBillingUsageInput = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type PiBillingCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputNanoUsd: number;
  outputNanoUsd: number;
  cacheReadNanoUsd: number;
  cacheWriteNanoUsd: number;
  totalNanoUsd: number;
};

const PI_BILLING_COUNTER_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "inputNanoUsd",
  "outputNanoUsd",
  "cacheReadNanoUsd",
  "cacheWriteNanoUsd",
  "totalNanoUsd",
] as const satisfies readonly (keyof PiBillingCounters)[];

function toNanoUsd(usd: number) {
  return Math.round(usd * 1_000_000_000);
}

/** Converts cumulative Pi usage into integer token and nano-USD billing counters. */
export function piBillingCountersFromUsage(
  usages: Iterable<PiBillingUsageInput>,
): PiBillingCounters {
  const counters: PiBillingCounters = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    inputNanoUsd: 0,
    outputNanoUsd: 0,
    cacheReadNanoUsd: 0,
    cacheWriteNanoUsd: 0,
    totalNanoUsd: 0,
  };

  for (const usage of usages) {
    counters.inputTokens += usage.input;
    counters.outputTokens += usage.output;
    counters.cacheReadTokens += usage.cacheRead;
    counters.cacheWriteTokens += usage.cacheWrite;
    counters.totalTokens += usage.totalTokens;
    counters.inputNanoUsd += toNanoUsd(usage.cost.input);
    counters.outputNanoUsd += toNanoUsd(usage.cost.output);
    counters.cacheReadNanoUsd += toNanoUsd(usage.cost.cacheRead);
    counters.cacheWriteNanoUsd += toNanoUsd(usage.cost.cacheWrite);
    counters.totalNanoUsd += toNanoUsd(usage.cost.total);
  }

  return counters;
}

/** Returns the undelivered part of cumulative Pi usage and rejects a regressed watermark. */
export function subtractPiBillingCounters(
  through: PiBillingCounters,
  delivered: PiBillingCounters,
): PiBillingCounters {
  const delta = { ...through };
  for (const key of PI_BILLING_COUNTER_KEYS) {
    const quantity = through[key] - delivered[key];
    if (quantity < 0) {
      throw new Error(`PI_BILLING_COUNTER_REGRESSION:${key}:${delivered[key]}:${through[key]}`);
    }
    delta[key] = quantity;
  }
  return delta;
}

/** True when at least one token or nano-USD counter has not been delivered. */
export function hasPiBillingUsage(counters: PiBillingCounters): boolean {
  return PI_BILLING_COUNTER_KEYS.some((key) => counters[key] > 0);
}

/** Maps integer Pi billing counters into the canonical AI billing meters. */
export function createPiBillingMeasurements(
  counters: PiBillingCounters,
): BillingMeasurementInput[] {
  return [
    { meter: "ai.tokens.input", unit: "token", quantity: counters.inputTokens },
    { meter: "ai.tokens.output", unit: "token", quantity: counters.outputTokens },
    { meter: "ai.tokens.cache-read", unit: "token", quantity: counters.cacheReadTokens },
    { meter: "ai.tokens.cache-write", unit: "token", quantity: counters.cacheWriteTokens },
    { meter: "ai.tokens.total", unit: "token", quantity: counters.totalTokens },
    { meter: "ai.cost.input", unit: "nano-usd", quantity: counters.inputNanoUsd },
    { meter: "ai.cost.output", unit: "nano-usd", quantity: counters.outputNanoUsd },
    { meter: "ai.cost.cache-read", unit: "nano-usd", quantity: counters.cacheReadNanoUsd },
    { meter: "ai.cost.cache-write", unit: "nano-usd", quantity: counters.cacheWriteNanoUsd },
    { meter: "ai.cost.total", unit: "nano-usd", quantity: counters.totalNanoUsd },
  ];
}

/** Constructs one idempotent event for a durable Pi usage-watermark delta. */
export function createPiDurableBillingEvent(input: {
  eventId: string;
  scope: BackofficeContextScope;
  sessionId: string;
  taskId: number;
  occurredAt: string;
  through: PiBillingCounters;
  delta: PiBillingCounters;
}): BillingEventInput {
  return {
    id: input.eventId,
    scope: input.scope,
    source: "pi-durable",
    eventType: "usage.committed",
    occurredAt: input.occurredAt,
    measurements: createPiBillingMeasurements(input.delta),
    metadata: {
      sessionId: input.sessionId,
      taskId: input.taskId,
      through: input.through,
    },
  };
}
