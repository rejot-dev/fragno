import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import type { BillingMeasurementInput } from "./contracts";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

export const billingFragmentSchema = schema("billing", (s) =>
  s
    .addTable("billing_event", (t) =>
      t
        // Stable producer-supplied identity used to make event ingestion idempotent.
        .addColumn("id", idColumn())
        // Canonical, indexable encoding of the scope receiving the measured usage.
        .addColumn("scopeKey", column("string"))
        // Structured scope retained for consumers so they do not need to decode scopeKey.
        .addColumn("scope", jsonColumn<BackofficeContextScope>())
        // Component that produced the event, such as pi-harness.
        .addColumn("source", column("string"))
        // Producer-defined classification of the event within its source.
        .addColumn("eventType", column("string"))
        // UTC calendar month derived from occurredAt, formatted as YYYY-MM.
        .addColumn("period", column("string"))
        // Timestamp at which the measured activity occurred, supplied by the producer.
        .addColumn("occurredAt", column("timestamp"))
        // Immutable meter, unit, and quantity values contributed by this event.
        .addColumn("measurements", jsonColumn<BillingMeasurementInput[]>())
        // Optional producer context for audit and debugging; it does not affect aggregation.
        .addColumn("metadata", column("json").nullable())
        // Database time at which the billing event was first persisted.
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_billing_event_scope_period_occurredAt", [
          "scopeKey",
          "period",
          "occurredAt",
          "id",
        ])
        .createIndex("idx_billing_event_source_type_occurredAt", [
          "source",
          "eventType",
          "occurredAt",
          "id",
        ]),
    )
    .addTable("billing_tracker", (t) =>
      t
        // Fragment-generated identity used for optimistic updates to the aggregate row.
        .addColumn("id", idColumn())
        // Canonical, indexable encoding of the scope represented by this aggregate.
        .addColumn("scopeKey", column("string"))
        // Structured scope copied from the first contributing event for direct consumption.
        .addColumn("scope", jsonColumn<BackofficeContextScope>())
        // UTC calendar month covered by this aggregate, formatted as YYYY-MM.
        .addColumn("period", column("string"))
        // Stable name of the measured quantity, unique within a scope and period.
        .addColumn("meter", column("string"))
        // Unit shared by every contribution to this meter, such as token or nano-usd.
        .addColumn("unit", column("string"))
        // Sum of all measurement quantities recorded for this meter in the period.
        .addColumn("quantity", column("bigint"))
        // Number of distinct billing events that contributed to this meter.
        .addColumn("eventCount", column("bigint"))
        // Earliest occurredAt timestamp among the contributing events.
        .addColumn("firstOccurredAt", column("timestamp"))
        // Latest occurredAt timestamp among the contributing events.
        .addColumn("lastOccurredAt", column("timestamp"))
        // Database time at which this aggregate row was created.
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        // Database time at which this aggregate was most recently updated.
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_billing_tracker_scope_period_meter", ["scopeKey", "period", "meter"], {
          unique: true,
        }),
    ),
);
