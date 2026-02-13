import type Stripe from "stripe";
import type { TxResult } from "@fragno-dev/db";
import type { TableToColumnValues, TableToInsertValues } from "@fragno-dev/db/query";

import type { stripeSchema } from "./database/schema";
import type { SubscriptionResponse } from "./models/subscriptions";

export interface Logger {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  error(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  debug(...data: unknown[]): void;
}

export type StripeRequestContext = {
  method: string;
  path: string;
  pathParams: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  rawBody: string | undefined;
  input: {
    schema: unknown;
    valid: () => Promise<unknown>;
  };
};

export type StripeEntityData = {
  /**
   * The unique identifier for the entity (user, organization, etc.) in your system
   */
  referenceId: string;
  /**
   * The Stripe Customer ID associated with this entity, if one exists
   */
  stripeCustomerId: string | undefined;
  /**
   * The email address of the customer
   */
  customerEmail: string;
  /**
   * Custom metadata to be attached to Stripe Customer for this entity
   */
  stripeMetadata: Record<string, string>;
};

export interface StripeFragmentConfig {
  stripeSecretKey: string;
  webhookSecret: string;
  stripeClientOptions?: Stripe.StripeConfig;
  enableAdminRoutes: boolean;
  /**
   * Resolves the authenticated entity (user, organization or something) from the request context
   * and returns their Stripe-related data.
   *
   * This callback is invoked on user-specific routes (/subscription/upgrade and /subscription/cancel)
   * to identify which entity is making the request. Extract authentication information
   * from the request context (e.g., session cookies, JWT tokens in headers) and return
   * the entity's Stripe customer ID, subscription ID (if exists), email, and custom metadata.
   *
   * @param context - Request context containing headers, query params, path params, and request body
   * @returns Promise resolving to the entity's Stripe-related data
   */
  resolveEntityFromRequest: (context: StripeRequestContext) => Promise<StripeEntityData>;
  /**
   * Callback that gets called when a Stripe Customer is created.
   *
   * Use this callback when you want to store a reference to the customer id in your app.
   */
  onStripeCustomerCreated: (stripeCustomerId: string, referenceId: string) => Promise<void>;
  /**
   * Optional callback for custom Stripe event handlers.
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

export type StripeServiceCall<T, TRetrieve = T> = TxResult<T, TRetrieve>;

type SubscriptionRow = TableToColumnValues<typeof stripeSchema.tables.subscription>;

export interface StripeFragmentServices extends Record<string, unknown> {
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
  ): StripeServiceCall<string>;
  /**
   * Update an existing subscription record
   */
  updateSubscription(
    id: string,
    data: Partial<Omit<TableToInsertValues<typeof stripeSchema.tables.subscription>, "id">>,
  ): StripeServiceCall<void>;
  /**
   * Find a subscription by Stripe subscription ID
   */
  getSubscriptionByStripeId(
    stripeSubscriptionId: string,
  ): StripeServiceCall<SubscriptionResponse | null>;
  /**
   * Find all subscriptions for a Stripe customer ID
   */
  getSubscriptionsByStripeCustomerId(
    stripeCustomerId: string,
  ): StripeServiceCall<SubscriptionResponse[]>;
  /**
   * Delete a subscription record
   */
  deleteSubscription(id: string): StripeServiceCall<void>;

  deleteSubscriptionsByReferenceId(
    referenceId: string,
  ): StripeServiceCall<{ success: boolean }, [SubscriptionRow[]]>;
  /**
   * Get all subscriptions
   */
  getAllSubscriptions(): StripeServiceCall<SubscriptionResponse[]>;
  /**
   * Get subscriptions by id (internal)
   */
  getSubscriptionById(id: string): StripeServiceCall<SubscriptionResponse | null>;
  getSubscriptionsByReferenceId(referenceId: string): StripeServiceCall<SubscriptionResponse[]>;

  syncStripeSubscriptions(
    referenceId: string,
    customerId: string,
    stripeSubscriptions: Stripe.Subscription[],
  ): StripeServiceCall<{ success: boolean }, [SubscriptionRow[]]>;
}
