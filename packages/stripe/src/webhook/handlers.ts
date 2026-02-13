import type { Stripe } from "stripe";
import type { DatabaseRequestContext } from "@fragno-dev/db";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { FragnoApiError } from "@fragno-dev/core/api";
import { stripeSchema } from "../database/schema";
import { getId, stripeSubscriptionToInternalSubscription } from "../utils";

export interface StripeEventHandler {
  event: Stripe.Event;
  services: StripeFragmentServices;
  deps: StripeFragmentDeps;
  config: StripeFragmentConfig;
  handlerTx: DatabaseRequestContext["handlerTx"];
}

// https://docs.stripe.com/api/events/types
export type SupportedStripeEvent =
  | "checkout.session.completed"
  | "customer.subscription.deleted"
  | "customer.subscription.updated"
  | "customer.subscription.paused"
  | "customer.subscription.created"
  | "customer.subscription.pending_update_applied"
  | "customer.subscription.pending_update_expired"
  | "customer.subscription.resumed"
  | "customer.subscription.trial_will_end";
// TODO: for customer tracking
// | "customer.updated"
// TODO: for stripe product payment tracking
// | "invoice.marked_uncollectible"
// | "invoice.paid"
// | "invoice.payment_action_required"
// | "invoice.payment_failed"
// | "invoice.payment_succeeded"
// | "invoice.upcoming"
// | "payment_intent.canceled"
// | "payment_intent.payment_failed"
// | "payment_intent.succeeded";

/**
 * Event Handler for checkout.session.completed
 *
 * This handler is ONLY for subscription checkout sessions.
 * Occurs when a Checkout Session has been successfully completed.
 */
export async function checkoutSessionCompletedHandler({
  event,
  services,
  deps,
  handlerTx,
}: StripeEventHandler) {
  const checkoutSession = event.data.object as Stripe.Checkout.Session;

  // Skip if this is not a subscription session
  if (checkoutSession.mode !== "subscription") {
    deps.log.info(`Not handling checkout session with mode ${checkoutSession.mode}: ${event.id}`);
    return;
  }

  const subscriptionId = checkoutSession.subscription;
  if (typeof subscriptionId !== "string") {
    deps.log.error("No subscription ID in checkout session");
    return;
  }

  // Retrieve the full subscription details from Stripe
  const stripeSubscription = await deps.stripe.subscriptions.retrieve(subscriptionId);

  // Extract customer ID
  const customerId = getId(stripeSubscription.customer);

  // Extract subscription details from first item
  const firstItem = stripeSubscription.items.data[0];
  if (!firstItem) {
    deps.log.error("No subscription items found");
    return;
  }

  // Get referenceId from checkout session (client_reference_id or metadata)
  const referenceId =
    checkoutSession.metadata?.["referenceId"] || checkoutSession.client_reference_id;

  // Get existing subscription ID from metadata (if updating an existing one)
  const existingSubscriptionId = checkoutSession.metadata?.["subscriptionId"];

  const subscriptionData = {
    ...stripeSubscriptionToInternalSubscription(stripeSubscription),
    referenceId: referenceId ?? null,
  };

  // If we have an existing subscription ID, try to update it
  if (existingSubscriptionId) {
    await handlerTx()
      .withServiceCalls(
        () => [services.updateSubscription(existingSubscriptionId, subscriptionData)] as const,
      )
      .execute();
    deps.log.info(`Updated subscription ${existingSubscriptionId} for customer ${customerId}`);
    return;
  }

  const result = await handlerTx()
    .withServiceCalls(() => [services.getSubscriptionByStripeId(stripeSubscription.id)] as const)
    .mutate(({ forSchema, serviceIntermediateResult: [existing] }) => {
      if (existing) {
        return { action: "exists" as const, id: existing.id };
      }

      const created = forSchema(stripeSchema).create("subscription", subscriptionData);
      return { action: "created" as const, id: created.externalId };
    })
    .execute();

  if (result.action === "exists") {
    // TODO: update that subscription's data?
    deps.log.info(`Subscription already exists for Stripe ID ${stripeSubscription.id}`);
    return;
  }

  deps.log.info(
    `Created subscription ${result.id} for customer ${customerId} (Stripe ID: ${stripeSubscription.id})`,
  );
}

/**
 * Event Handler for customer.subscription.paused
 *
 * Occurs whenever a customer’s subscription is paused. Only applies when
 * subscriptions enter status=paused, not when payment collection is paused.
 *
 * PAUSED status: The subscription has ended its trial period without a default
 * payment method and the trial_settings.end_behavior.missing_payment_method is set
 * to pause. Invoices are no longer created for the subscription. After attaching a
 * default payment method to the customer, you can resume the subscription.
 */
export async function customerSubscriptionPausedHandler(args: StripeEventHandler) {
  // As far as I can tell, this only sets the status of a subscription to paused and nothing else.
  return customerSubscriptionUpdatedHandler(args);
}

/**
 * Event Handler for customer.subscription.pending_update_applied
 *
 * Occurs whenever a customer’s subscription’s pending update is applied,
 * and the subscription is updated.
 */
export async function customerSubscriptionPendingUpdateAppliedHandler(args: StripeEventHandler) {
  return customerSubscriptionUpdatedHandler(args);
}

/**
 * Event Handler for customer.subscription.pending_update_expired
 *
 * Occurs whenever a customer’s subscription’s pending update expires
 * before the related invoice is paid.
 */
export async function customerSubscriptionPendingUpdateExpiredHandler(args: StripeEventHandler) {
  return customerSubscriptionUpdatedHandler(args);
}

/**
 * Event Handler for customer.subscription.resumed
 *
 * Occurs whenever a customer’s subscription is no longer paused.
 * Only applies when a status=paused subscription is resumed, not when payment
 * collection is resumed.
 */
export async function customerSubscriptionResumedHandler(args: StripeEventHandler) {
  return customerSubscriptionUpdatedHandler(args);
}

/**
 * Event Handler for customer.subscription.trial_will_end
 *
 * Occurs three days before a subscription's trial period is scheduled to end,
 * or when a trial is ended immediately (using trial_end=now). This event allows
 * you to send reminders or take action before the trial expires.
 */
export async function customerSubscriptionTrialWillEndHandler(args: StripeEventHandler) {
  return customerSubscriptionUpdatedHandler(args);
}

/**
 * Event Handler for customer.subscription.updated
 *
 * Occurs whenever a subscription changes (e.g., switching from one plan to another,
 * or changing the status from trial to active).
 */
export async function customerSubscriptionUpdatedHandler({
  event,
  services,
  deps,
  handlerTx,
}: StripeEventHandler) {
  deps.log.info(`Processing ${event.type}: ${event.id}`);

  const stripeSubscription = event.data.object as Stripe.Subscription;

  const firstItem = stripeSubscription.items?.data?.[0];
  if (!firstItem) {
    throw new FragnoApiError(
      { message: "Subscription contains no items", code: "EMPTY_SUBSCRIPTION" },
      400,
    );
  }

  const customerId = getId(stripeSubscription.customer);

  const subscriptionPayload = stripeSubscriptionToInternalSubscription(stripeSubscription);
  const referenceId = stripeSubscription.metadata?.["referenceId"] ?? null;

  const result = await handlerTx()
    .withServiceCalls(
      () =>
        [
          services.getSubscriptionByStripeId(stripeSubscription.id),
          services.getSubscriptionsByStripeCustomerId(customerId),
        ] as const,
    )
    .mutate(({ forSchema, serviceIntermediateResult: [byStripeId, byCustomerId] }) => {
      let subscription = byStripeId;

      if (!subscription) {
        if (byCustomerId.length > 1) {
          subscription =
            byCustomerId.find((sub) => sub.status === "active" || sub.status === "trialing") ??
            null;

          if (!subscription) {
            return { action: "skipped" as const };
          }
        } else {
          subscription = byCustomerId[0] ?? null;
        }
      }

      if (!subscription) {
        const created = forSchema(stripeSchema).create("subscription", {
          ...subscriptionPayload,
          referenceId,
        });
        return { action: "created" as const, id: created.externalId };
      }

      forSchema(stripeSchema).update("subscription", subscription.id, (b) =>
        b.set({ ...subscriptionPayload, updatedAt: new Date() }),
      );
      return { action: "updated" as const, id: subscription.id };
    })
    .execute();

  if (result.action === "skipped") {
    deps.log.warn(
      `Multiple subscriptions found for customer ${customerId} but none active or trialing`,
    );
    return;
  }

  if (result.action === "created") {
    deps.log.warn(
      `No subscription found for Stripe ID ${stripeSubscription.id}, creating new record`,
    );
    deps.log.info(
      `Created subscription ${result.id} for customer ${customerId} (Stripe ID: ${stripeSubscription.id})`,
    );
    return;
  }

  deps.log.info(`Updated subscription ${result.id} (Stripe ID: ${stripeSubscription.id})`);
}

/**
 * Event Handler for customer.subscription.deleted
 *
 * Occurs whenever a customer's subscription ends.
 */
export async function customerSubscriptionDeletedHandler({
  event,
  services,
  deps,
  handlerTx,
}: StripeEventHandler) {
  deps.log.info(`Processing customer.subscription.deleted: ${event.id}`);

  const stripeSubscription = event.data.object as Stripe.Subscription;

  const result = await handlerTx()
    .withServiceCalls(() => [services.getSubscriptionByStripeId(stripeSubscription.id)] as const)
    .mutate(({ forSchema, serviceIntermediateResult: [subscription] }) => {
      if (!subscription) {
        return { action: "missing" as const };
      }

      forSchema(stripeSchema).update("subscription", subscription.id, (b) =>
        b.set({ status: "canceled", updatedAt: new Date() }),
      );
      return { action: "canceled" as const, id: subscription.id };
    })
    .execute();

  if (result.action === "missing") {
    deps.log.warn(`No subscription found for Stripe ID ${stripeSubscription.id}`);
    return;
  }

  deps.log.info(
    `Marked subscription ${result.id} as canceled (Stripe ID: ${stripeSubscription.id})`,
  );
}

export const eventToHandler: Record<
  SupportedStripeEvent,
  (args: StripeEventHandler) => Promise<void>
> = {
  "checkout.session.completed": checkoutSessionCompletedHandler,
  "customer.subscription.deleted": customerSubscriptionDeletedHandler,
  "customer.subscription.created": customerSubscriptionUpdatedHandler,
  "customer.subscription.updated": customerSubscriptionUpdatedHandler,
  "customer.subscription.paused": customerSubscriptionPausedHandler,
  "customer.subscription.pending_update_applied": customerSubscriptionPendingUpdateAppliedHandler,
  "customer.subscription.pending_update_expired": customerSubscriptionPendingUpdateExpiredHandler,
  "customer.subscription.resumed": customerSubscriptionResumedHandler,
  "customer.subscription.trial_will_end": customerSubscriptionTrialWillEndHandler,
};
