import { decodeCursor, type Cursor } from "@fragno-dev/db";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";

import { BILLING_TRACKER_MAX_PAGE_SIZE } from "./contracts";

export const BILLING_TRACKER_INDEX_NAME = "idx_billing_tracker_scope_period_meter";

export class BillingTrackerCursorError extends Error {
  readonly code = "BILLING_TRACKER_CURSOR_INVALID";

  constructor() {
    super("Billing tracker cursor is invalid.");
    this.name = "BillingTrackerCursorError";
  }
}

export const decodeBillingTrackerCursor = (input: {
  encodedCursor?: string;
  scope: BackofficeContextScope;
  period: string;
}): Cursor | undefined => {
  if (!input.encodedCursor) {
    return undefined;
  }

  try {
    const cursor = decodeCursor(input.encodedCursor);
    const expectedScopeKey = backofficeContextScopeSinglePathSegment(input.scope);

    if (
      cursor.indexName !== BILLING_TRACKER_INDEX_NAME ||
      cursor.orderDirection !== "asc" ||
      cursor.pageSize > BILLING_TRACKER_MAX_PAGE_SIZE ||
      cursor.indexValues["scopeKey"] !== expectedScopeKey ||
      cursor.indexValues["period"] !== input.period ||
      typeof cursor.indexValues["meter"] !== "string"
    ) {
      throw new BillingTrackerCursorError();
    }

    return cursor;
  } catch (error) {
    if (error instanceof BillingTrackerCursorError) {
      throw error;
    }
    throw new BillingTrackerCursorError();
  }
};
