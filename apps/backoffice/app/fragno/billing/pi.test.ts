import { assert, describe, expect, test } from "vitest";

import {
  createPiDurableBillingEvent,
  hasPiBillingUsage,
  piBillingCountersFromUsage,
  subtractPiBillingCounters,
  type PiBillingUsageInput,
} from "./pi";

const usage: PiBillingUsageInput = {
  input: 100,
  output: 25,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens: 185,
  cost: {
    input: 0.0003,
    output: 0.000375,
    cacheRead: 0.000015,
    cacheWrite: 0.0000375,
    total: 0.0007275,
  },
};

describe("durable Pi billing counters", () => {
  test("normalizes cumulative usage before calculating an integer delta", () => {
    const through = piBillingCountersFromUsage([
      usage,
      {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 25,
        cost: {
          input: 0.000_000_000_6,
          output: 0.000_000_000_4,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.000_000_001,
        },
      },
    ]);
    const delivered = piBillingCountersFromUsage([usage]);
    const delta = subtractPiBillingCounters(through, delivered);

    expect(delta).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 25,
      inputNanoUsd: 1,
      outputNanoUsd: 0,
      cacheReadNanoUsd: 0,
      cacheWriteNanoUsd: 0,
      totalNanoUsd: 1,
    });
    assert(hasPiBillingUsage(delta));
    expect(() => subtractPiBillingCounters(delivered, through)).toThrow(
      "PI_BILLING_COUNTER_REGRESSION:inputTokens:120:100",
    );
  });

  test("constructs the durable event from the exact persisted delta", () => {
    const through = piBillingCountersFromUsage([usage]);
    const event = createPiDurableBillingEvent({
      eventId: "pi-durable:event-1",
      scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
      sessionId: "session-1",
      taskId: 42,
      occurredAt: "2026-10-03T12:00:00.000Z",
      through,
      delta: through,
    });

    expect(event).toMatchObject({
      id: "pi-durable:event-1",
      source: "pi-durable",
      eventType: "usage.committed",
      metadata: { sessionId: "session-1", taskId: 42, through },
    });
    expect(
      Object.fromEntries(event.measurements.map(({ meter, quantity }) => [meter, quantity])),
    ).toMatchObject({
      "ai.tokens.total": 185,
      "ai.cost.total": 727_500,
    });
  });
});
