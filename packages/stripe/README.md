# Stripe Fragment

`@fragno-dev/stripe` is a minimal Stripe integration fragment built with Fragno.

## Status

This fragment is currently in minimal boilerplate state. It provides:

- Stripe SDK client initialization
- Fragment structure ready for route definitions
- Client builder setup for all major frameworks (React, Vue, Svelte, Solid, Vanilla JS)

## Configuration

```ts
import { createStripeFragment } from "@fragno-dev/stripe";

const fragment = createStripeFragment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  stripeClientOptions: {
    // Optional Stripe SDK configuration
    apiVersion: "2024-12-18.acacia",
  },
});
```

## Routes

No routes are currently defined. Routes will be added as the fragment is developed.

## Client Helpers

```ts
import { createStripeFragmentClient } from "@fragno-dev/stripe/react";

const client = createStripeFragmentClient({
  mountRoute: "/api/stripe",
});

// Client hooks will be available as routes are added
```

## Build

```bash
bun run types:check
bun run build
```

## Development

This fragment is under active development. Routes and features will be added incrementally.
