<p align="center">
  <img src="./assets/stripe-integration.png" alt="Stripe integration example" width="600" />
</p>

# @fragno-dev/stripe

Stripe subscriptions library for Fragno.

It manages customers, subscriptions, and billing portal access, and handles Stripe webhooks for you.

## Who is this for?

- **App developers** who want a batteries-included Stripe subscriptions integration without wiring
  up all webhooks, routes, and client calls by hand.

You configure Stripe keys; the library provides routes and client helpers.

## Quick start

### 1. Install

```bash
npm install @fragno-dev/stripe
# or
pnpm add @fragno-dev/stripe
```

### 2. Configure on the server

```ts
import { createStripeFragment } from "@fragno-dev/stripe";

export const stripe = createStripeFragment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  stripeClientOptions: {
    // Optional Stripe SDK configuration
    apiVersion: "2025-09-30.clover",
  },
});
```

### 3. Client helpers

```ts
import { createStripeFragmentClient } from "@fragno-dev/stripe/react";

export const stripeClient = createStripeFragmentClient();
```

The client exposes helpers to manage subscriptions and billing flows from your frontend.

Example (React):

```tsx
import { stripeClient } from "@/lib/stripe-client";

export function UpgradeButton() {
  const { upgradeSubscription } = stripeClient;

  return (
    <button
      type="button"
      onClick={() => {
        return upgradeSubscription({
          priceId: "price_123",
        });
      }}
    >
      Upgrade
    </button>
  );
}
```

## Features

- **Customers and subscriptions**: create and manage customer subscriptions in your app.
- **Billing portal redirect**: send users to Stripe's billing portal for payment methods and
  invoices.
- **Webhook handling**: verify and process Stripe webhooks in one place.
- **Typed client helpers**: simple helpers for common subscription flows.

## Documentation

For a full walkthrough and framework-specific setup (Next.js, React Router, etc.), see:

- [Stripe Quick Start](https://fragno.dev/docs/stripe/quickstart)

## Build

```bash
bun run types:check
bun run build
```
