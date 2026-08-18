import { afterAll, describe, expect, test, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { billingPeriodSchema, type BillingEventInput } from "./contracts";
import { billingFragmentDefinition } from "./definition";

const scope = { kind: "org" as const, orgId: "org-1" };

const usageEvent = (overrides: Partial<BillingEventInput> = {}): BillingEventInput => ({
  id: "pi:org-1:hook-1",
  scope,
  source: "pi-harness",
  eventType: "operation.completed",
  occurredAt: "2026-07-16T12:00:00.000Z",
  measurements: [
    { meter: "ai.tokens.input", unit: "token", quantity: 100 },
    { meter: "ai.cost.total", unit: "nano-usd", quantity: 25_000 },
  ],
  metadata: { sessionId: "session-1" },
  ...overrides,
});

describe("billing period validation", () => {
  test.each(["2026-01", "2026-12"])("accepts %s", (period) => {
    expect(billingPeriodSchema.parse(period)).toBe(period);
  });

  test.each(["2026-00", "2026-13", "2026-1", "not-a-period"])("rejects %s", (period) => {
    assert(!billingPeriodSchema.safeParse(period).success);
  });
});

describe("billing fragment", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("billing", instantiate(billingFragmentDefinition).withConfig({}).withRoutes([]))
    .build();

  const billing = fragments.billing;
  const callServices = billing.fragment.callServices.bind(billing.fragment);

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("stores idempotent events and updates scope-period trackers", async () => {
    const first = await callServices(() => billing.services.recordEvent(usageEvent()));
    const duplicate = await callServices(() => billing.services.recordEvent(usageEvent()));

    expect(first).toEqual({ accepted: true, eventId: "pi:org-1:hook-1" });
    expect(duplicate).toEqual({ accepted: false, eventId: "pi:org-1:hook-1" });

    await callServices(() =>
      billing.services.recordEvent(
        usageEvent({
          id: "pi:org-1:hook-2",
          occurredAt: "2026-07-16T13:00:00.000Z",
          measurements: [
            { meter: "ai.tokens.input", unit: "token", quantity: 40 },
            { meter: "ai.cost.total", unit: "nano-usd", quantity: 5_000 },
          ],
        }),
      ),
    );

    const page = await callServices(() =>
      billing.services.getTrackers({
        scope,
        period: "2026-07",
        pageSize: 10,
        summaryMeter: "ai.cost.total",
      }),
    );

    expect(page.trackers).toEqual([
      expect.objectContaining({
        meter: "ai.cost.total",
        unit: "nano-usd",
        quantity: "30000",
        eventCount: "2",
        firstOccurredAt: "2026-07-16T12:00:00.000Z",
        lastOccurredAt: "2026-07-16T13:00:00.000Z",
      }),
      expect.objectContaining({
        meter: "ai.tokens.input",
        unit: "token",
        quantity: "140",
        eventCount: "2",
        firstOccurredAt: "2026-07-16T12:00:00.000Z",
        lastOccurredAt: "2026-07-16T13:00:00.000Z",
      }),
    ]);
    expect(page).toMatchObject({
      hasNextPage: false,
      summaryTracker: expect.objectContaining({ meter: "ai.cost.total", quantity: "30000" }),
    });
  });

  test("separates trackers by scope and UTC month", async () => {
    await callServices(() =>
      billing.services.recordEvent(
        usageEvent({
          id: "pi:org-2:hook-1",
          scope: { kind: "org", orgId: "org-2" },
          occurredAt: "2026-08-01T00:00:00.000Z",
        }),
      ),
    );

    expect(
      await callServices(() =>
        billing.services.getTrackers({
          scope: { kind: "org", orgId: "org-2" },
          period: "2026-07",
        }),
      ),
    ).toMatchObject({ trackers: [], hasNextPage: false });

    const august = await callServices(() =>
      billing.services.getTrackers({
        scope: { kind: "org", orgId: "org-2" },
        period: "2026-08",
      }),
    );
    expect(august.trackers.map((tracker) => tracker.quantity)).toEqual(["25000", "100"]);
  });

  test("builds an organization statement across scoped trackers without writing rollups", async () => {
    const statementOrgScope = { kind: "org" as const, orgId: "org-statement" };
    const statementEvents: BillingEventInput[] = [
      usageEvent({
        id: "statement-org-event",
        scope: statementOrgScope,
        occurredAt: "2026-09-01T10:00:00.000Z",
        measurements: [
          { meter: "ai.tokens.total", unit: "token", quantity: 10 },
          { meter: "ai.cost.total", unit: "nano-usd", quantity: 100 },
        ],
      }),
      usageEvent({
        id: "statement-project-event",
        scope: { kind: "project", orgId: "org-statement", projectId: "project-1" },
        occurredAt: "2026-09-01T11:00:00.000Z",
        measurements: [
          { meter: "ai.tokens.total", unit: "token", quantity: 20 },
          { meter: "ai.cost.total", unit: "nano-usd", quantity: 200 },
        ],
      }),
      usageEvent({
        id: "statement-user-event",
        scope: { kind: "user", userId: "user-1" },
        occurredAt: "2026-09-01T12:00:00.000Z",
        measurements: [
          { meter: "ai.tokens.total", unit: "token", quantity: 30 },
          { meter: "ai.cost.total", unit: "nano-usd", quantity: 300 },
        ],
      }),
    ];

    for (const statementEvent of statementEvents) {
      await callServices(() => billing.services.recordEvent(statementEvent));
    }

    await expect(
      callServices(() => billing.services.getStatement({ period: "2026-09" })),
    ).resolves.toMatchObject({
      period: "2026-09",
      trackers: [
        {
          meter: "ai.cost.total",
          unit: "nano-usd",
          quantity: "600",
          eventCount: "3",
          firstOccurredAt: "2026-09-01T10:00:00.000Z",
          lastOccurredAt: "2026-09-01T12:00:00.000Z",
          updatedAt: expect.any(String),
        },
        {
          meter: "ai.tokens.total",
          unit: "token",
          quantity: "60",
          eventCount: "3",
          firstOccurredAt: "2026-09-01T10:00:00.000Z",
          lastOccurredAt: "2026-09-01T12:00:00.000Z",
          updatedAt: expect.any(String),
        },
      ],
    });

    await expect(
      callServices(() =>
        billing.services.getTrackers({ scope: statementOrgScope, period: "2026-09" }),
      ),
    ).resolves.toMatchObject({
      trackers: [
        expect.objectContaining({ meter: "ai.cost.total", quantity: "100", eventCount: "1" }),
        expect.objectContaining({ meter: "ai.tokens.total", quantity: "10", eventCount: "1" }),
      ],
    });
  });

  test("paginates trackers in ascending meter order", async () => {
    const paginationScope = { kind: "org" as const, orgId: "org-pagination" };
    await callServices(() =>
      billing.services.recordEvent(
        usageEvent({
          id: "pagination-event",
          scope: paginationScope,
          measurements: [
            { meter: "zeta", unit: "unit", quantity: 1 },
            { meter: "alpha", unit: "unit", quantity: 2 },
            { meter: "delta", unit: "unit", quantity: 3 },
            { meter: "beta", unit: "unit", quantity: 4 },
            { meter: "gamma", unit: "unit", quantity: 5 },
          ],
        }),
      ),
    );

    const first = await callServices(() =>
      billing.services.getTrackers({
        scope: paginationScope,
        period: "2026-07",
        pageSize: 2,
        summaryMeter: "gamma",
      }),
    );
    expect(first.trackers.map(({ meter }) => meter)).toEqual(["alpha", "beta"]);
    expect(first).toMatchObject({
      hasNextPage: true,
      nextCursor: expect.any(String),
      summaryTracker: expect.objectContaining({ meter: "gamma", quantity: "5" }),
    });

    const second = await callServices(() =>
      billing.services.getTrackers({
        scope: paginationScope,
        period: "2026-07",
        cursor: first.nextCursor,
      }),
    );
    expect(second.trackers.map(({ meter }) => meter)).toEqual(["delta", "gamma"]);
    expect(second).toMatchObject({ hasNextPage: true, nextCursor: expect.any(String) });

    const third = await callServices(() =>
      billing.services.getTrackers({
        scope: paginationScope,
        period: "2026-07",
        cursor: second.nextCursor,
      }),
    );
    expect(third.trackers.map(({ meter }) => meter)).toEqual(["zeta"]);
    expect(third).toMatchObject({ hasNextPage: false, summaryTracker: null });

    await expect(
      callServices(() =>
        billing.services.getTrackers({
          scope: { kind: "org", orgId: "another-org" },
          period: "2026-07",
          cursor: first.nextCursor,
        }),
      ),
    ).rejects.toMatchObject({ code: "BILLING_TRACKER_CURSOR_INVALID" });
  });

  test("rejects reuse of an event id with different contents", async () => {
    const eventId = "pi:org-1:idempotency-conflict";
    await callServices(() => billing.services.recordEvent(usageEvent({ id: eventId })));

    await expect(
      callServices(() =>
        billing.services.recordEvent(
          usageEvent({
            id: eventId,
            measurements: [{ meter: "ai.tokens.input", unit: "token", quantity: 999 }],
          }),
        ),
      ),
    ).rejects.toThrow(`BILLING_EVENT_IDEMPOTENCY_CONFLICT:${eventId}`);
  });
});
