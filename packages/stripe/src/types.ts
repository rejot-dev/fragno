import type Stripe from "stripe";

import type { HookContext } from "@fragno-dev/db";

import type { Subscription } from "./subscriptions";

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

export type StripeEntity = {
  /**
   * The unique identifier for the entity (user, organization, etc.) in your system
   */
  referenceId: string;
  /**
   * The email address set on the Stripe customer the fragment creates for this entity
   */
  customerEmail: string;
  /**
   * Metadata set on the Stripe customer the fragment creates for this entity
   */
  customerMetadata: Record<string, string>;
};

export type StripeCustomerLink = {
  customerId: string;
  referenceId: string;
};

export interface StripeFragmentConfig {
  stripeSecretKey: string;
  webhookSecret: string;
  /** Sends the fragment's Stripe API requests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Resolves the authenticated entity (user, organization or something else) making the request.
   *
   * Invoked on the routes that act for an entity (/subscription/upgrade, /subscription/cancel and
   * /portal). Return null when the request is not authenticated.
   */
  resolveEntityFromRequest: (context: StripeRequestContext) => Promise<StripeEntity | null>;
  /**
   * Runs after a Stripe customer is linked to an entity, either by the upgrade route or by the
   * `linkCustomer` service.
   */
  onCustomerLinked?: (payload: StripeCustomerLink, context: HookContext) => Promise<void> | void;
  /**
   * Runs after a sync changed a subscription. The subscription is read when the hook runs, so it is
   * the current state rather than the state of the change that triggered it.
   */
  onSubscriptionChanged?: (
    payload: { subscription: Subscription },
    context: HookContext,
  ) => Promise<void> | void;
  /**
   * Runs for every verified Stripe event, independently of the fragment's own processing, so a
   * failure here retries without holding back subscription syncs. Events arrive in any order;
   * read subscription state from `onSubscriptionChanged` instead.
   */
  onStripeEvent?: (payload: { event: Stripe.Event }, context: HookContext) => Promise<void> | void;
}
