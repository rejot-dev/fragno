import type Stripe from "stripe";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import type { stripeSchema } from "./database/schema";

export function toDate(s: number): Date;
export function toDate(s: undefined): undefined;
export function toDate(s: null): null;
export function toDate(s: number | null): Date | null;
export function toDate(s: number | undefined | null): Date | undefined | null {
  return s !== undefined && s !== null ? new Date(s * 1000) : s;
}

export function getId(x: string | { id: string }): string {
  return typeof x === "string" ? x : x.id;
}

/**
 * Maps a Stripe.Subscription to the internal subscription schema.
 */
export function stripeSubscriptionToInternalSubscription(
  stripeSubscription: Stripe.Subscription,
): Omit<
  TableToInsertValues<typeof stripeSchema.tables.subscription>,
  "id" | "updatedAt" | "referenceId"
> {
  const firstItem = stripeSubscription.items.data[0];

  if (!firstItem) {
    // It should be impossible for a subscription to have no items (CITATION NEEDED)
    throw new Error("Subscription contains no items");
  }

  const priceId = getId(firstItem.price);
  const customerId = getId(stripeSubscription.customer);

  return {
    stripePriceId: priceId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSubscription.id,
    status: stripeSubscription.status,
    periodStart: toDate(firstItem.current_period_start),
    periodEnd: toDate(firstItem.current_period_end),
    trialStart: toDate(stripeSubscription.trial_start),
    trialEnd: toDate(stripeSubscription.trial_end),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
    cancelAt: toDate(stripeSubscription.cancel_at),
    createdAt: toDate(stripeSubscription.created),
    seats: firstItem.quantity ?? null,
  };
}
