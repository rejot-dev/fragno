import type Stripe from "stripe";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import type { stripeSchema } from "./database/schema";
import type { SubscriptionResponse } from "./models/subscriptions";

export interface StripeFragmentConfig {
  stripeSecretKey: string;
  webhookSecret: string;
  stripeClientOptions?: Stripe.StripeConfig;
  /**
   * Optional callback for checkout.session.completed webhook events.
   *
   * The fragment automatically handles the subscription by:
   * - Retrieving the subscription from Stripe
   * - Extracting subscription details (customer, plan, status, trial dates, etc.)
   * - Creating or updating a subscription record in the database
   *
   * This callback runs AFTER the default handling, allowing you to add custom logic such as:
   * - Sending notification emails to users
   * - Updating user records in your application database
   * - Triggering additional business logic or integrations
   */
  onCheckoutSessionCompleted?: (args: {
    event: Stripe.CheckoutSessionCompletedEvent;
    stripeClient: Stripe;
  }) => Promise<void>;
  onSubscriptionCreated?: (args: { event: Stripe.Event; stripeClient: Stripe }) => Promise<void>;
  /**
   * Optional callback for customer.subscription.updated webhook events.
   *
   * The fragment automatically handles the update by:
   * - Finding the subscription in the database
   * - Updating subscription details (status, plan, period dates, cancellation status, etc.)
   *
   * This callback runs AFTER the default handling, allowing you to add custom logic such as:
   * - Notifying users of subscription changes
   * - Handling plan upgrades/downgrades
   * - Tracking subscription lifecycle events
   */
  onSubscriptionUpdated?: (args: { event: Stripe.Event; stripeClient: Stripe }) => Promise<void>;
  /**
   * Optional callback for customer.subscription.deleted webhook events.
   *
   * The fragment automatically handles the deletion by:
   * - Finding the subscription in the database
   * - Marking it as canceled
   *
   * This callback runs AFTER the default handling, allowing you to add custom logic such as:
   * - Notifying users of cancellation
   * - Cleaning up user access/permissions
   * - Archiving user data
   */
  onSubscriptionDeleted?: (args: { event: Stripe.Event; stripeClient: Stripe }) => Promise<void>;
  /**
   * Called when a checkout session is created via the upgrade endpoint
   */
  onUpgradeCheckoutCreated?: (args: {
    checkoutSession: Stripe.Checkout.Session;
    userId: string;
    stripeClient: Stripe;
  }) => Promise<void>;
  /**
   * Called when a billing portal session is created via the upgrade endpoint
   */
  onUpgradeBillingPortalCreated?: (args: {
    portalSession: Stripe.BillingPortal.Session;
    userId: string;
    stripeClient: Stripe;
  }) => Promise<void>;
  /**
   * Optional callback to provide custom metadata for new Stripe customers
   */
  getCustomerMetadata?: (
    userId: string,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

export interface StripeFragmentDeps {
  stripe: Stripe;
  stripeClientOptions?: Stripe.StripeConfig;
}

export interface StripeFragmentServices {
  /**
   * Get the Stripe client instance
   */
  getStripeClient(): Stripe;
  /**
   * Create a new subscription record in the database
   */
  createSubscription(
    data: Omit<TableToInsertValues<typeof stripeSchema.tables.subscription>, "id">,
  ): Promise<{ id: string } & typeof data>;
  /**
   * Update an existing subscription record
   */
  updateSubscription(
    id: string,
    data: Partial<Omit<TableToInsertValues<typeof stripeSchema.tables.subscription>, "id">>,
  ): Promise<void>;
  /**
   * Find a subscription by Stripe subscription ID
   */
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<SubscriptionResponse | null>;
  /**
   * Find all subscriptions for a Stripe customer ID
   */
  getSubscriptionByStripeCustomerId(stripeCustomerId: string): Promise<SubscriptionResponse[]>;
  /**
   * Delete a subscription record
   */
  deleteSubscription(id: string): Promise<void>;
  /**
   * Get all subscriptions
   */
  getAllSubscriptions(): Promise<SubscriptionResponse[]>;
}
