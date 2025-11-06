import { FragnoApiError } from "@fragno-dev/core/api";

function isStripeError(error: unknown): error is { type: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function stripeToApiError(error: unknown): FragnoApiError | unknown {
  // Attempt to generate more ergnomic error messages
  if (
    isStripeError(error) &&
    error.type === "StripeInvalidRequestError" &&
    error.message.includes("there are no changes to confirm")
  ) {
    return new FragnoApiError(
      { message: "Trying to upgrade to same subscription plan", code: "UPGRADE_HAS_NO_EFFECT" },
      500,
    );
  }

  if (
    isStripeError(error) &&
    error.type === "StripeInvalidRequestError" &&
    error.message.includes("is already set to be canceled at period end")
  ) {
    return new FragnoApiError(
      {
        message: "Subscription is already set to be canceled at period end",
        code: "SUBSCRIPTION_ALREADY_CANCELED",
      },
      500,
    );
  }

  if (
    isStripeError(error) &&
    error.type === "StripeInvalidRequestError" &&
    error.message.includes(
      "the subscription update feature in the portal configuration is disabled",
    )
  ) {
    return new FragnoApiError(
      {
        message: "Subscription cannot be updated to this plan",
        code: "SUBSCRIPTION_UPDATE_NOT_ALLOWED",
      },
      500,
    );
  }

  return error;
}
