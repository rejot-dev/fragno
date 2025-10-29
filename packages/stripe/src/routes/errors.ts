import { FragnoApiError } from "@fragno-dev/core/api";

export function stripeToApiError(error: any): FragnoApiError | unknown {
  // Attempt to generate more ergnomic error messages
  if (
    "type" in error &&
    error.type === "StripeInvalidRequestError" &&
    "message" in error &&
    error.message.includes("there are no changes to confirm")
  ) {
    return new FragnoApiError(
      { message: "Trying to upgrade to same subscription plan", code: "UPGRADE_HAS_NO_EFFECT" },
      500,
    );
  }

  if (
    "type" in error &&
    error.type === "StripeInvalidRequestError" &&
    "message" in error &&
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

  return error;
}
