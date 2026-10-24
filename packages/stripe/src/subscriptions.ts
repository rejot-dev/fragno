import type { TableToColumnValues } from "@fragno-dev/db/query";
import type Stripe from "stripe";
import { z } from "zod";

import type { stripeSchema } from "./schema";

const subscriptionStatuses = [
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
] as const;

export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const subscriptionSchema = z.object({
  id: z.string().describe("Stripe subscription ID"),
  customerId: z.string().describe("Stripe customer ID"),
  referenceId: z.string().nullable().describe("App entity the customer is linked to"),
  itemId: z.string().describe("Stripe subscription item ID"),
  priceId: z.string(),
  quantity: z.number().nullable(),
  status: z.enum(subscriptionStatuses),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  trialStart: z.date().nullable(),
  trialEnd: z.date().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  cancelAt: z.date().nullable(),
  canceledAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Subscription = z.infer<typeof subscriptionSchema>;

type SubscriptionRow = TableToColumnValues<typeof stripeSchema.tables.subscription>;

/** The columns Stripe determines; `referenceId` comes from the customer link instead. */
export type SubscriptionRecord = Omit<Subscription, "referenceId" | "updatedAt">;

/** A subscription as Stripe reported it, retrieved with its customer expanded. */
export type ReportedSubscription = {
  record: SubscriptionRecord;
  /**
   * The entity the `referenceId` metadata of the customer names. The fragment sets it on the
   * customers it creates, as earlier integrations did. Null for deleted customers.
   */
  customerReferenceId: string | null;
};

export function subscriptionFromRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id.externalId,
    customerId: row.customerId,
    referenceId: row.referenceId,
    itemId: row.itemId,
    priceId: row.priceId,
    quantity: row.quantity,
    // The pinned Stripe API version fixes the set of statuses Stripe reports.
    status: row.status as SubscriptionStatus,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    trialStart: row.trialStart,
    trialEnd: row.trialEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelAt: row.cancelAt,
    canceledAt: row.canceledAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function reportedSubscription(subscription: Stripe.Subscription): ReportedSubscription {
  const customer = subscription.customer;
  return {
    record: subscriptionRecordFromStripe(subscription),
    customerReferenceId:
      typeof customer === "string" || customer.deleted
        ? null
        : (customer.metadata["referenceId"] ?? null),
  };
}

function subscriptionRecordFromStripe(subscription: Stripe.Subscription): SubscriptionRecord {
  // Stripe rejects subscriptions without items. Subscriptions created by this fragment have exactly
  // one; for others the first item stands for the subscription.
  const item = subscription.items.data[0];
  return {
    id: subscription.id,
    customerId: stripeId(subscription.customer),
    itemId: item.id,
    priceId: item.price.id,
    quantity: item.quantity ?? null,
    status: subscription.status as SubscriptionStatus,
    currentPeriodStart: fromUnixTime(item.current_period_start),
    currentPeriodEnd: fromUnixTime(item.current_period_end),
    trialStart: nullableFromUnixTime(subscription.trial_start),
    trialEnd: nullableFromUnixTime(subscription.trial_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: nullableFromUnixTime(subscription.cancel_at),
    canceledAt: nullableFromUnixTime(subscription.canceled_at),
    endedAt: nullableFromUnixTime(subscription.ended_at),
    createdAt: fromUnixTime(subscription.created),
  };
}

/** Whether syncing `record` would leave `row` as it is. */
export function rowMatchesRecord(
  row: SubscriptionRow,
  record: SubscriptionRecord,
  referenceId: string | null,
): boolean {
  return (
    row.customerId === record.customerId &&
    row.referenceId === referenceId &&
    row.itemId === record.itemId &&
    row.priceId === record.priceId &&
    row.quantity === record.quantity &&
    row.status === record.status &&
    sameTime(row.currentPeriodStart, record.currentPeriodStart) &&
    sameTime(row.currentPeriodEnd, record.currentPeriodEnd) &&
    sameTime(row.trialStart, record.trialStart) &&
    sameTime(row.trialEnd, record.trialEnd) &&
    row.cancelAtPeriodEnd === record.cancelAtPeriodEnd &&
    sameTime(row.cancelAt, record.cancelAt) &&
    sameTime(row.canceledAt, record.canceledAt) &&
    sameTime(row.endedAt, record.endedAt) &&
    sameTime(row.createdAt, record.createdAt)
  );
}

/** Subscriptions that still bill or can still be paid; the customer manages these in the portal. */
export function isOngoing(subscription: { status: string }): boolean {
  return subscription.status === "active" || subscription.status === "trialing";
}

/** Stripe returns related objects as IDs unless they are expanded. */
export function stripeId(related: string | { id: string }): string {
  return typeof related === "string" ? related : related.id;
}

function fromUnixTime(seconds: number): Date {
  return new Date(seconds * 1000);
}

function nullableFromUnixTime(seconds: number | null): Date | null {
  return seconds === null ? null : fromUnixTime(seconds);
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}
