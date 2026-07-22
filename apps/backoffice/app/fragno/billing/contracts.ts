import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";

export const billingMeterSchema = z.string().trim().min(1).max(100);

export const billingMeasurementInputSchema = z.object({
  meter: billingMeterSchema,
  unit: z.string().trim().min(1).max(50),
  quantity: z.number().int().nonnegative(),
});

export type BillingMeasurementInput = z.infer<typeof billingMeasurementInputSchema>;

export const billingEventInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    scope: backofficeContextScopeSchema,
    source: z.string().trim().min(1).max(100),
    eventType: z.string().trim().min(1).max(100),
    occurredAt: z.iso.datetime(),
    measurements: z.array(billingMeasurementInputSchema).min(1).max(50),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine(({ measurements }, context) => {
    const meters = new Set<string>();
    for (const measurement of measurements) {
      if (meters.has(measurement.meter)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate billing meter ${measurement.meter}.`,
          path: ["measurements"],
        });
      }
      meters.add(measurement.meter);
    }
  });

export type BillingEventInput = z.infer<typeof billingEventInputSchema>;

export type BillingRecordEventResult = {
  accepted: boolean;
  eventId: string;
};

export const billingPeriodSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);

export const BILLING_TRACKER_DEFAULT_PAGE_SIZE = 25;
export const BILLING_TRACKER_MAX_PAGE_SIZE = 100;

export const billingTrackerPageInputSchema = z.object({
  scope: backofficeContextScopeSchema,
  period: billingPeriodSchema,
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(BILLING_TRACKER_MAX_PAGE_SIZE)
    .default(BILLING_TRACKER_DEFAULT_PAGE_SIZE),
  cursor: z.string().trim().min(1).optional(),
  summaryMeter: billingMeterSchema.optional(),
});

export type BillingTrackerPageInput = {
  scope: BackofficeContextScope;
  period: string;
  pageSize?: number;
  cursor?: string;
  summaryMeter?: string;
};

export type BillingTracker = {
  scope: BackofficeContextScope;
  period: string;
  meter: string;
  unit: string;
  quantity: string;
  eventCount: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  updatedAt: string;
};

export type BillingTrackerPage = {
  trackers: BillingTracker[];
  nextCursor?: string;
  hasNextPage: boolean;
  summaryTracker: BillingTracker | null;
};
