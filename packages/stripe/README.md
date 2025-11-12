# Stripe Fragment

`@fragno-dev/stripe` is a minimal Stripe integration fragment built with Fragno.

## Status

This fragment can be used to manage Stripe customers and subscriptions.

## Configuration

```ts
import { createStripeFragment } from "@fragno-dev/stripe";

const fragment = createStripeFragment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  stripeClientOptions: {
    // Optional Stripe SDK configuration
    apiVersion: "2025-09-30.clover",
  },
});
```

## Client Helpers

```ts
import { createStripeFragmentClient } from "@fragno-dev/stripe/react";

export const stripeClient = createStripeFragmentClient();
```

The client provides the following hooks:

- `upgradeSubscription()`: Create or update a subscription
- `cancelSubscription()`: Cancel an existing subscription
- `useBillingPortal()`: Redirect to Stripe's billing portal for managing payment methods and billing
  details

## Build

```bash
bun run types:check
bun run build
```
