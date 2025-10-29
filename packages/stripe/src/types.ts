import type Stripe from "stripe";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import type { stripeSchema } from "./database/schema";
import type { SubscriptionResponse } from "./models/subscriptions";

export interface Logger {
  log(...data: any[]): void;
  info(...data: any[]): void;
  error(...data: any[]): void;
  warn(...data: any[]): void;
  debug(...data: any[]): void;
}

export interface StripeFragmentConfig {
  stripeSecretKey: string;
  webhookSecret: string;
  stripeClientOptions?: Stripe.StripeConfig;
  subscriptions: {
    enabled: boolean;
  };
  /**
   * Callback that gets called when a Stripe Customer is created.
   *
   * Use this callback when you want to store a reference to the customer id in your app.
   */
  onStripeCustomerCreated: (stripeCustomerId: string, referenceId: string) => Promise<void>;
  /**
   * Optional callback for stripe events.
   *
   * This callback runs BEFORE the default handling.
   */
  onEvent?: (args: { event: Stripe.Event; stripeClient: Stripe }) => Promise<void>;

  /* Override the default logger */
  logger?: Logger;
}

export interface StripeFragmentDeps {
  stripe: Stripe;
  stripeClientOptions?: Stripe.StripeConfig;
  log: Logger;
}

export interface StripeFragmentServices {
  /**
   * Get the Stripe client instance
   */
  getStripeClient(): Stripe;
  /**
   * Create a new subscription record in the database
   * Note: createdAt and updatedAt are automatically set by the service
   */
  createSubscription(
    data: Omit<
      TableToInsertValues<typeof stripeSchema.tables.subscription>,
      "id" | "createdAt" | "updatedAt"
    >,
  ): Promise<string>;
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

  deleteSubscriptionByReferenceId(referenceId: string): Promise<boolean>;
  /**
   * Get all subscriptions
   */
  getAllSubscriptions(): Promise<SubscriptionResponse[]>;
  /**
   * Get subscriptions by id (internal)
   */
  getSubscriptionById(id: string): Promise<SubscriptionResponse | null>;
  getSubscriptionByReferenceId(referenceId: string): Promise<SubscriptionResponse | null>;

  syncStripeSubscription(referenceId: string, customerId: string): Promise<void>;
}
