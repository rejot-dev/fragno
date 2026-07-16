import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { billingFragmentDefinition } from "./definition";

export const createBillingFragment = (options: FragnoPublicConfigWithDatabase) =>
  instantiate(billingFragmentDefinition).withConfig({}).withRoutes([]).withOptions(options).build();

export type BillingFragment = ReturnType<typeof createBillingFragment>;

export type {
  BillingEventInput,
  BillingMeasurementInput,
  BillingRecordEventResult,
  BillingTracker,
  BillingTrackerPage,
  BillingTrackerPageInput,
} from "./contracts";
export {
  BILLING_TRACKER_DEFAULT_PAGE_SIZE,
  BILLING_TRACKER_MAX_PAGE_SIZE,
  billingEventInputSchema,
  billingPeriodSchema,
  billingTrackerPageInputSchema,
} from "./contracts";
