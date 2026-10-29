import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import {
  billingEventInputSchema,
  billingPeriodSchema,
  billingStatementInputSchema,
  billingTrackerPageInputSchema,
  type BillingEventInput,
  type BillingRecordEventResult,
  type BillingStatement,
  type BillingStatementInput,
  type BillingStatementTracker,
  type BillingTracker,
  type BillingTrackerPage,
  type BillingTrackerPageInput,
} from "./contracts";
import { BILLING_TRACKER_INDEX_NAME, decodeBillingTrackerCursor } from "./pagination";
import {
  BILLING_LIMIT_METER_INDEX_NAME,
  BILLING_STATEMENT_TRACKER_INDEX_NAME,
  billingFragmentSchema,
} from "./schema";
import {
  usageLimitedMeterSchema,
  usageLimitsReachedBy,
  usageLimitStatuses,
  type ExhaustedUsageLimit,
  type UsageLimitSetting,
  type UsageLimitedMeter,
  type UsageLimits,
} from "./usage-limits";

/** A recorded event, with the limits it used up in its period for its owner's monitoring. */
type RecordedBillingEvent = BillingRecordEventResult & {
  period: string;
  reachedLimits: ExhaustedUsageLimit[];
};

const billingPeriodForDate = (date: Date) => date.toISOString().slice(0, 7);

const timestampToIsoString = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value as string | number);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Billing record contains an invalid timestamp.");
  }
  return parsed.toISOString();
};

const sameTimestamp = (left: unknown, right: Date) =>
  timestampToIsoString(left) === right.toISOString();

const assertIdempotentEventMatches = (
  existing: {
    scopeKey: string;
    source: string;
    eventType: string;
    period: string;
    occurredAt: unknown;
    measurements: unknown;
    metadata: unknown;
  },
  input: BillingEventInput,
  scopeKey: string,
  period: string,
  occurredAt: Date,
) => {
  const matches =
    existing.scopeKey === scopeKey &&
    existing.source === input.source &&
    existing.eventType === input.eventType &&
    existing.period === period &&
    sameTimestamp(existing.occurredAt, occurredAt) &&
    JSON.stringify(existing.measurements) === JSON.stringify(input.measurements) &&
    JSON.stringify(existing.metadata ?? null) === JSON.stringify(input.metadata ?? null);

  if (!matches) {
    throw new Error(`BILLING_EVENT_IDEMPOTENCY_CONFLICT:${input.id}`);
  }
};

type StoredBillingTracker = {
  scope: BillingTracker["scope"];
  period: string;
  meter: string;
  unit: string;
  quantity: bigint;
  eventCount: bigint;
  firstOccurredAt: unknown;
  lastOccurredAt: unknown;
  updatedAt: unknown;
};

const normalizeTracker = (tracker: StoredBillingTracker): BillingTracker => ({
  scope: tracker.scope,
  period: tracker.period,
  meter: tracker.meter,
  unit: tracker.unit,
  quantity: tracker.quantity.toString(),
  eventCount: tracker.eventCount.toString(),
  firstOccurredAt: timestampToIsoString(tracker.firstOccurredAt),
  lastOccurredAt: timestampToIsoString(tracker.lastOccurredAt),
  updatedAt: timestampToIsoString(tracker.updatedAt),
});

const aggregateStatementTrackers = (
  trackers: StoredBillingTracker[],
): BillingStatementTracker[] => {
  const aggregates = new Map<
    string,
    {
      meter: string;
      unit: string;
      quantity: bigint;
      eventCount: bigint;
      firstOccurredAt: string;
      lastOccurredAt: string;
      updatedAt: string;
    }
  >();

  for (const tracker of trackers) {
    const firstOccurredAt = timestampToIsoString(tracker.firstOccurredAt);
    const lastOccurredAt = timestampToIsoString(tracker.lastOccurredAt);
    const updatedAt = timestampToIsoString(tracker.updatedAt);
    const aggregate = aggregates.get(tracker.meter);

    if (!aggregate) {
      aggregates.set(tracker.meter, {
        meter: tracker.meter,
        unit: tracker.unit,
        quantity: tracker.quantity,
        eventCount: tracker.eventCount,
        firstOccurredAt,
        lastOccurredAt,
        updatedAt,
      });
      continue;
    }

    if (aggregate.unit !== tracker.unit) {
      throw new Error(
        `BILLING_STATEMENT_METER_UNIT_CONFLICT:${tracker.meter}:${aggregate.unit}:${tracker.unit}`,
      );
    }

    aggregate.quantity += tracker.quantity;
    aggregate.eventCount += tracker.eventCount;
    if (firstOccurredAt < aggregate.firstOccurredAt) {
      aggregate.firstOccurredAt = firstOccurredAt;
    }
    if (lastOccurredAt > aggregate.lastOccurredAt) {
      aggregate.lastOccurredAt = lastOccurredAt;
    }
    if (updatedAt > aggregate.updatedAt) {
      aggregate.updatedAt = updatedAt;
    }
  }

  return [...aggregates.values()]
    .sort((left, right) => left.meter.localeCompare(right.meter))
    .map((tracker) => ({
      ...tracker,
      quantity: tracker.quantity.toString(),
      eventCount: tracker.eventCount.toString(),
    }));
};

export const billingFragmentDefinition = defineFragment("billing")
  .extend(withDatabase(billingFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      recordEvent: function (rawInput: BillingEventInput) {
        const input = billingEventInputSchema.parse(rawInput);
        const occurredAt = new Date(input.occurredAt);
        const period = billingPeriodForDate(occurredAt);
        const scopeKey = backofficeScopePathSegment(input.scope);

        return this.serviceTx(billingFragmentSchema, { name: "billing.recordEvent" })
          .retrieve((uow) =>
            uow
              .findFirst("billing_event", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
              )
              .find("billing_tracker", (b) =>
                b.whereIndex(BILLING_TRACKER_INDEX_NAME, (eb) =>
                  eb.and(eb("scopeKey", "=", scopeKey), eb("period", "=", period)),
                ),
              )
              .find("billing_limit", (b) => b.whereIndex(BILLING_LIMIT_METER_INDEX_NAME))
              .find("billing_tracker", (b) =>
                b.whereIndex(BILLING_STATEMENT_TRACKER_INDEX_NAME, (eb) =>
                  eb.and(
                    eb("period", "=", period),
                    eb("meter", "in", usageLimitedMeterSchema.options),
                  ),
                ),
              ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [existingEvent, existingTrackers, customLimits, limitedTrackers],
            }) => {
              if (existingEvent) {
                assertIdempotentEventMatches(existingEvent, input, scopeKey, period, occurredAt);
                return {
                  accepted: false,
                  eventId: input.id,
                  period,
                  reachedLimits: [],
                } satisfies RecordedBillingEvent;
              }

              const now = uow.now();
              // Concurrent writers race to create the same event or a meter's first tracker; the loser
              // retries against the winner's row instead of failing.
              const retryOnUniqueConflict = { retryOnUniqueConflict: () => true };
              uow.create(
                "billing_event",
                {
                  id: input.id,
                  scopeKey,
                  scope: input.scope,
                  source: input.source,
                  eventType: input.eventType,
                  period,
                  occurredAt,
                  measurements: input.measurements,
                  metadata: input.metadata ?? null,
                  createdAt: now,
                },
                retryOnUniqueConflict,
              );

              const trackersByMeter = new Map(
                existingTrackers.map((tracker) => [tracker.meter, tracker] as const),
              );

              for (const measurement of input.measurements) {
                const existingTracker = trackersByMeter.get(measurement.meter);
                if (existingTracker) {
                  if (existingTracker.unit !== measurement.unit) {
                    throw new Error(
                      `BILLING_METER_UNIT_CONFLICT:${measurement.meter}:${existingTracker.unit}:${measurement.unit}`,
                    );
                  }

                  const existingFirstOccurredAt = new Date(existingTracker.firstOccurredAt);
                  const existingLastOccurredAt = new Date(existingTracker.lastOccurredAt);
                  uow.update("billing_tracker", existingTracker.id, (b) =>
                    b
                      .set({
                        quantity: existingTracker.quantity + BigInt(measurement.quantity),
                        eventCount: existingTracker.eventCount + 1n,
                        firstOccurredAt:
                          existingFirstOccurredAt.getTime() > occurredAt.getTime()
                            ? occurredAt
                            : existingTracker.firstOccurredAt,
                        lastOccurredAt:
                          existingLastOccurredAt.getTime() < occurredAt.getTime()
                            ? occurredAt
                            : existingTracker.lastOccurredAt,
                        updatedAt: now,
                      })
                      .check(),
                  );
                  continue;
                }

                uow.create(
                  "billing_tracker",
                  {
                    scopeKey,
                    scope: input.scope,
                    period,
                    meter: measurement.meter,
                    unit: measurement.unit,
                    quantity: BigInt(measurement.quantity),
                    eventCount: 1n,
                    firstOccurredAt: occurredAt,
                    lastOccurredAt: occurredAt,
                    createdAt: now,
                    updatedAt: now,
                  },
                  retryOnUniqueConflict,
                );
              }

              return {
                accepted: true,
                eventId: input.id,
                period,
                reachedLimits: usageLimitsReachedBy(
                  usageLimitStatuses({ customLimits, trackers: limitedTrackers }),
                  input.measurements,
                ),
              } satisfies RecordedBillingEvent;
            },
          )
          .build();
      },

      getStatement: function (rawInput: BillingStatementInput) {
        const input = billingStatementInputSchema.parse(rawInput);

        return this.serviceTx(billingFragmentSchema)
          .retrieve((uow) =>
            uow.find("billing_tracker", (b) =>
              b
                .whereIndex(BILLING_STATEMENT_TRACKER_INDEX_NAME, (eb) =>
                  eb("period", "=", input.period),
                )
                .orderByIndex(BILLING_STATEMENT_TRACKER_INDEX_NAME, "asc"),
            ),
          )
          .transformRetrieve(
            ([trackers]) =>
              ({
                period: input.period,
                trackers: aggregateStatementTrackers(trackers),
              }) satisfies BillingStatement,
          )
          .build();
      },

      /** The owner's limits and what it used of them in `period`, across all of its scopes. */
      getUsageLimits: function ({ period }: { period: string }) {
        return this.serviceTx(billingFragmentSchema)
          .retrieve((uow) =>
            uow
              .find("billing_limit", (b) => b.whereIndex(BILLING_LIMIT_METER_INDEX_NAME))
              .find("billing_tracker", (b) =>
                b.whereIndex(BILLING_STATEMENT_TRACKER_INDEX_NAME, (eb) =>
                  eb.and(
                    eb("period", "=", period),
                    eb("meter", "in", usageLimitedMeterSchema.options),
                  ),
                ),
              ),
          )
          .transformRetrieve(
            ([customLimits, trackers]) =>
              ({
                period,
                limits: usageLimitStatuses({ customLimits, trackers }),
              }) satisfies UsageLimits,
          )
          .build();
      },

      /** Sets the owner's limit on `meter`, answering its limits as they are afterwards. */
      setUsageLimit: function ({
        meter,
        setting,
        period,
      }: {
        meter: UsageLimitedMeter;
        setting: UsageLimitSetting;
        period: string;
      }) {
        return this.serviceTx(billingFragmentSchema)
          .retrieve((uow) =>
            uow
              .find("billing_limit", (b) => b.whereIndex(BILLING_LIMIT_METER_INDEX_NAME))
              .find("billing_tracker", (b) =>
                b.whereIndex(BILLING_STATEMENT_TRACKER_INDEX_NAME, (eb) =>
                  eb.and(
                    eb("period", "=", period),
                    eb("meter", "in", usageLimitedMeterSchema.options),
                  ),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [customLimits, trackers] }) => {
            const existing = customLimits.find((limit) => limit.meter === meter);
            if (setting.kind === "default") {
              if (existing) {
                uow.delete("billing_limit", existing.id, (b) => b.check());
              }
            } else if (existing) {
              uow.update("billing_limit", existing.id, (b) =>
                b.set({ limit: setting, updatedAt: uow.now() }).check(),
              );
            } else {
              uow.create("billing_limit", { meter, limit: setting, updatedAt: uow.now() });
            }
            const otherLimits = customLimits.filter((limit) => limit.meter !== meter);
            return {
              period,
              limits: usageLimitStatuses({
                customLimits:
                  setting.kind === "default"
                    ? otherLimits
                    : [...otherLimits, { meter, limit: setting }],
                trackers,
              }),
            } satisfies UsageLimits;
          })
          .build();
      },

      getTrackers: function (rawInput: BillingTrackerPageInput) {
        const input = billingTrackerPageInputSchema.parse(rawInput);
        const period = billingPeriodSchema.parse(input.period);
        const scopeKey = backofficeScopePathSegment(input.scope);
        const cursor = decodeBillingTrackerCursor({
          encodedCursor: input.cursor,
          scope: input.scope,
          period,
        });
        const effectivePageSize = cursor?.pageSize ?? input.pageSize;
        const summaryMeter = input.summaryMeter ?? "";

        return this.serviceTx(billingFragmentSchema)
          .retrieve((uow) =>
            uow
              .findWithCursor("billing_tracker", (b) => {
                const query = b
                  .whereIndex(BILLING_TRACKER_INDEX_NAME, (eb) =>
                    eb.and(eb("scopeKey", "=", scopeKey), eb("period", "=", period)),
                  )
                  .orderByIndex(BILLING_TRACKER_INDEX_NAME, "asc")
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              })
              .findFirst("billing_tracker", (b) =>
                b.whereIndex(BILLING_TRACKER_INDEX_NAME, (eb) =>
                  eb.and(
                    eb("scopeKey", "=", scopeKey),
                    eb("period", "=", period),
                    eb("meter", "=", summaryMeter),
                  ),
                ),
              ),
          )
          .transformRetrieve(
            ([page, summaryTracker]) =>
              ({
                trackers: page.items.map(normalizeTracker),
                ...(page.cursor ? { nextCursor: page.cursor.encode() } : {}),
                hasNextPage: page.hasNextPage,
                summaryTracker: summaryTracker ? normalizeTracker(summaryTracker) : null,
              }) satisfies BillingTrackerPage,
          )
          .build();
      },
    }),
  )
  .build();
