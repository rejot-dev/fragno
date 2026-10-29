import {
  backofficeScopeRootOwner,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRpcContext } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import type { BillingEventInput, BillingRecordEventResult } from "./contracts";
import {
  exhaustedUsageLimit,
  usageLimitExhaustedMessage,
  type UsageLimitedMeter,
} from "./usage-limits";

/** System work has no customer; every other scope must have a working usage recorder. */
export type UsageBilling =
  | { kind: "system" }
  | {
      kind: "customer";
      recordEvent: (
        event: BillingEventInput,
        context: BackofficeRpcContext,
      ) => Promise<BillingRecordEventResult>;
      checkUsageLimits: (meters: readonly UsageLimitedMeter[]) => Promise<UsageLimitCheck>;
    };

/** Whether the customer may start work that records usage on the meters it was checked for. */
export type UsageLimitCheck = { kind: "within" } | { kind: "exhausted"; message: string };

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
  const billing = runtime.objects.billing.for(owner).commands;
  return {
    kind: "customer",
    recordEvent: (event, context) => billing.recordEvent(event, context),
    checkUsageLimits: async (meters) => {
      const limits = await billing.getUsageLimits();
      const exhausted = exhaustedUsageLimit(limits, meters);
      return exhausted
        ? {
            kind: "exhausted",
            message: usageLimitExhaustedMessage(owner.kind, limits.period, exhausted),
          }
        : { kind: "within" };
    },
  };
}

/** System work is never limited. */
export async function checkUsageLimits(
  billing: UsageBilling,
  meters: readonly UsageLimitedMeter[],
): Promise<UsageLimitCheck> {
  return billing.kind === "system" ? { kind: "within" } : await billing.checkUsageLimits(meters);
}
