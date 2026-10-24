import { FragnoApiError } from "@fragno-dev/core/api";
import Stripe from "stripe";

/** Stripe rejections the entity can act on, recognized by Stripe's message or code. */
const knownRejections = [
  {
    matches: (error: Stripe.errors.StripeInvalidRequestError) =>
      error.message.includes("there are no changes to confirm"),
    message: "Trying to upgrade to same subscription plan",
    code: "UPGRADE_HAS_NO_EFFECT",
  },
  {
    matches: (error: Stripe.errors.StripeInvalidRequestError) =>
      error.message.includes("is already set to be canceled at period end"),
    message: "Subscription is already set to be canceled at period end",
    code: "SUBSCRIPTION_ALREADY_CANCELED",
  },
  {
    matches: (error: Stripe.errors.StripeInvalidRequestError) =>
      error.message.includes(
        "the subscription update feature in the portal configuration is disabled",
      ),
    message: "Subscription cannot be updated to this plan",
    code: "SUBSCRIPTION_UPDATE_NOT_ALLOWED",
  },
  {
    matches: (error: Stripe.errors.StripeInvalidRequestError) =>
      error.message.includes("does not include `promotion_code`"),
    message: "Cannot apply promotion code when updating subscription",
    code: "SUBSCRIPTION_UPDATE_PROMO_CODE_NOT_ALLOWED",
  },
  {
    matches: (error: Stripe.errors.StripeInvalidRequestError) =>
      error.code === "promotion_code_customer_not_first_time",
    message: "This promotion code cannot be redeemed because you have already used it before.",
    code: "PROMOTION_CODE_CUSTOMER_NOT_FIRST_TIME",
  },
] as const;

export function stripeToApiError(error: unknown): unknown {
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) {
    return error;
  }
  const rejection = knownRejections.find((candidate) => candidate.matches(error));
  return rejection
    ? new FragnoApiError({ message: rejection.message, code: rejection.code }, 400)
    : error;
}
