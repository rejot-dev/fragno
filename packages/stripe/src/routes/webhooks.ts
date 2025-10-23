import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import Stripe from "stripe";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";

/**
 * Default handler for checkout.session.completed events.
 * Automatically creates or updates a subscription record in the database.
 */
async function defaultCheckoutSessionCompletedHandler({
  event,
  stripeClient,
  services,
}: {
  event: Stripe.CheckoutSessionCompletedEvent;
  stripeClient: Stripe;
  services: StripeFragmentServices;
}) {
  try {
    console.log(`[Stripe Fragment] Processing checkout.session.completed: ${event.id}`);

    const checkoutSession = event.data.object;

    // Skip if this is a setup mode session (for payment methods only)
    if (checkoutSession.mode === "setup") {
      console.log(`[Stripe Fragment] Skipping setup mode checkout session: ${event.id}`);
      return;
    }

    const subscriptionId = checkoutSession.subscription;
    if (typeof subscriptionId !== "string") {
      console.error("[Stripe Fragment] No subscription ID in checkout session");
      return;
    }

    // Retrieve the full subscription details from Stripe
    const stripeSubscription = await stripeClient.subscriptions.retrieve(subscriptionId);

    // Extract customer ID
    const customerId =
      typeof stripeSubscription.customer === "string"
        ? stripeSubscription.customer
        : stripeSubscription.customer.id;

    // Extract subscription details from first item
    const firstItem = stripeSubscription.items.data[0];
    if (!firstItem) {
      console.error("[Stripe Fragment] No subscription items found");
      return;
    }

    const priceId = typeof firstItem.price === "string" ? firstItem.price : firstItem.price.id;

    // Get referenceId from checkout session (client_reference_id or metadata)
    const referenceId =
      checkoutSession.client_reference_id || checkoutSession.metadata?.["referenceId"];

    // Get existing subscription ID from metadata (if updating an existing one)
    const existingSubscriptionId = checkoutSession.metadata?.["subscriptionId"];

    // Prepare trial dates if applicable
    const trialDates =
      stripeSubscription.trial_start && stripeSubscription.trial_end
        ? {
            trialStart: new Date(stripeSubscription.trial_start * 1000),
            trialEnd: new Date(stripeSubscription.trial_end * 1000),
          }
        : {};

    // Prepare subscription data
    const subscriptionData = {
      plan: priceId,
      referenceId: referenceId || stripeSubscription.id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSubscription.id,
      status: stripeSubscription.status,
      // Use period from subscription items for accuracy
      periodStart: new Date(firstItem.current_period_start * 1000),
      periodEnd: new Date(firstItem.current_period_end * 1000),
      ...trialDates,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
      seats: firstItem.quantity ?? null,
    };

    // If we have an existing subscription ID, try to update it
    if (existingSubscriptionId) {
      try {
        await services.updateSubscription(existingSubscriptionId, subscriptionData);
        console.log(
          `[Stripe Fragment] Updated subscription ${existingSubscriptionId} for customer ${customerId}`,
        );
        return;
      } catch (error) {
        console.warn(
          `[Stripe Fragment] Failed to update subscription ${existingSubscriptionId}, will create new one`,
          error,
        );
      }
    }

    // Otherwise, check if subscription already exists by Stripe subscription ID
    const existing = await services.getSubscriptionByStripeId(stripeSubscription.id);
    if (existing) {
      console.log(
        `[Stripe Fragment] Subscription already exists for Stripe ID ${stripeSubscription.id}`,
      );
      return;
    }

    // Create new subscription record
    const result = await services.createSubscription(subscriptionData);
    console.log(
      `[Stripe Fragment] Created subscription ${result.id} for customer ${customerId} (Stripe ID: ${stripeSubscription.id})`,
    );
  } catch (error) {
    console.error(`[Stripe Fragment] checkout.session.completed webhook failed:`, error);
    throw error;
  }
}

/**
 * Default handler for customer.subscription.updated events.
 * Automatically updates the subscription record in the database.
 */
async function defaultSubscriptionUpdatedHandler({
  event,
  services,
}: {
  event: Stripe.Event;
  stripeClient: Stripe;
  services: StripeFragmentServices;
}) {
  try {
    console.log(`[Stripe Fragment] Processing customer.subscription.updated: ${event.id}`);

    const stripeSubscription = event.data.object as Stripe.Subscription;
    const firstItem = stripeSubscription.items.data[0];
    if (!firstItem) {
      console.error("[Stripe Fragment] No subscription items found");
      return;
    }

    const priceId = typeof firstItem.price === "string" ? firstItem.price : firstItem.price.id;
    const customerId =
      typeof stripeSubscription.customer === "string"
        ? stripeSubscription.customer
        : stripeSubscription.customer.id;

    // Try to find existing subscription
    let subscription = await services.getSubscriptionByStripeId(stripeSubscription.id);

    // If not found by Stripe ID, try to find by customer ID
    if (!subscription) {
      const customerSubs = await services.getSubscriptionByStripeCustomerId(customerId);
      if (customerSubs.length > 1) {
        // If multiple subscriptions, prefer active/trialing ones
        subscription =
          customerSubs.find((sub) => sub.status === "active" || sub.status === "trialing") ?? null;
        if (!subscription) {
          console.warn(
            `[Stripe Fragment] Multiple subscriptions found for customer ${customerId} but none active`,
          );
          return;
        }
      } else {
        subscription = customerSubs[0] ?? null;
      }
    }

    if (!subscription) {
      console.warn(
        `[Stripe Fragment] No subscription found for Stripe ID ${stripeSubscription.id}`,
      );
      return;
    }

    // Prepare update data
    const updateData = {
      plan: priceId,
      status: stripeSubscription.status,
      periodStart: new Date(firstItem.current_period_start * 1000),
      periodEnd: new Date(firstItem.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
      seats: firstItem.quantity ?? null,
      stripeSubscriptionId: stripeSubscription.id,
      stripeCustomerId: customerId,
    };

    await services.updateSubscription(subscription.id, updateData);
    console.log(
      `[Stripe Fragment] Updated subscription ${(subscription as any).id} (Stripe ID: ${stripeSubscription.id})`,
    );
  } catch (error) {
    console.error(`[Stripe Fragment] customer.subscription.updated webhook failed:`, error);
    throw error;
  }
}

/**
 * Default handler for customer.subscription.deleted events.
 * Marks the subscription as canceled in the database.
 */
async function defaultSubscriptionDeletedHandler({
  event,
  services,
}: {
  event: Stripe.Event;
  stripeClient: Stripe;
  services: StripeFragmentServices;
}) {
  try {
    console.log(`[Stripe Fragment] Processing customer.subscription.deleted: ${event.id}`);

    const stripeSubscription = event.data.object as Stripe.Subscription;

    // Find existing subscription
    const subscription = await services.getSubscriptionByStripeId(stripeSubscription.id);

    if (!subscription) {
      console.warn(
        `[Stripe Fragment] No subscription found for Stripe ID ${stripeSubscription.id}`,
      );
      return;
    }

    // Update status to canceled
    await services.updateSubscription((subscription as any).id, {
      status: "canceled",
    });

    console.log(
      `[Stripe Fragment] Marked subscription ${(subscription as any).id} as canceled (Stripe ID: ${stripeSubscription.id})`,
    );
  } catch (error) {
    console.error(`[Stripe Fragment] customer.subscription.deleted webhook failed:`, error);
    throw error;
  }
}

export const webhookRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ config, deps, services }) => {
  return [
    defineRoute({
      method: "POST",
      path: "/webhook",
      outputSchema: z.object({
        success: z.boolean(),
      }),
      errorCodes: [
        "MISSING_SIGNATURE",
        "WEBHOOK_SIGNATURE_INVALID",
        "WEBHOOK_ERROR",
        "WEBHOOK_UNKNOWN_EVENT", // TODO: need this?
      ] as const,
      handler: async ({ rawBodyText, headers }, { json, error }) => {
        // Get the signature
        const signature = headers.get("stripe-signature");

        if (!signature) {
          return error(
            { message: "Missing stripe-signature header", code: "MISSING_SIGNATURE" },
            400,
          );
        }

        // Verify the webhook signature
        let event: Stripe.Event;
        try {
          // Support both Stripe v18 (constructEvent) and v19+ (constructEventAsync)
          if (typeof deps.stripe.webhooks.constructEventAsync === "function") {
            // Stripe v19+ - use async method
            event = await deps.stripe.webhooks.constructEventAsync(
              rawBodyText,
              signature,
              config.webhookSecret,
            );
          } else {
            // Stripe v18 - use sync method
            event = deps.stripe.webhooks.constructEvent(
              rawBodyText,
              signature,
              config.webhookSecret,
            );
          }
        } catch (err) {
          console.error("Stripe webhook signature verification failed", err);
          return error(
            {
              message: `Webhook verification failed: ${err instanceof Stripe.errors.StripeSignatureVerificationError ? err.message : "Unknown error"}`,
              code: "WEBHOOK_SIGNATURE_INVALID",
            },
            400,
          );
        }

        if (!event) {
          return error({ message: "Failed to construct event", code: "WEBHOOK_ERROR" }, 400);
        }
        console.log(`Stripe webhook event: ${event.id} ${event.type}`);

        switch (event.type) {
          case "checkout.session.completed":
            await defaultCheckoutSessionCompletedHandler({
              event,
              stripeClient: deps.stripe,
              services,
            });
            await config.onCheckoutSessionCompleted?.({ event, stripeClient: deps.stripe });
            break;
          case "customer.subscription.updated":
            await defaultSubscriptionUpdatedHandler({
              event,
              stripeClient: deps.stripe,
              services,
            });
            await config.onSubscriptionUpdated?.({ event, stripeClient: deps.stripe });
            break;
          case "customer.subscription.deleted":
            await defaultSubscriptionDeletedHandler({
              event,
              stripeClient: deps.stripe,
              services,
            });
            await config.onSubscriptionDeleted?.({ event, stripeClient: deps.stripe });
            break;
          default:
            console.error(`Unknown event type: ${event.type}`);
            return error({
              message: `Unknown event type: ${event.type}`,
              code: "WEBHOOK_UNKNOWN_EVENT",
            });
        }

        return json({ success: true });
      },
    }),
  ];
});
