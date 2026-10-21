import {
  backofficeScopeRootOwner,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRpcContext } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import type { BillingEventInput, BillingRecordEventResult } from "./contracts";

/** System work has no customer; every other scope must have a working usage recorder. */
export type UsageBilling =
  | { kind: "system" }
  | {
      kind: "customer";
      recordEvent: (
        event: BillingEventInput,
        context: BackofficeRpcContext,
      ) => Promise<BillingRecordEventResult>;
    };

/** Attribution follows ownership, independently of who will eventually receive an invoice. */
export function usageBillingForScope(
  runtime: BackofficeRuntimeServices,
  scope: BackofficeContextScope,
): UsageBilling {
  const owner = backofficeScopeRootOwner(scope);
  if (owner === null) {
    return { kind: "system" };
  }
  if (!runtime.config.bindings.billing) {
    throw new Error("BILLING_UNAVAILABLE: customer-owned work requires Billing.");
  }
  return {
    kind: "customer",
    recordEvent: (event, context) =>
      runtime.objects.billing.for(owner).commands.recordEvent(event, context),
  };
}
