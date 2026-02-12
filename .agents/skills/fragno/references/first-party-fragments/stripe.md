# Stripe Fragment (@fragno-dev/stripe)

## Summary

A subscription-focused Stripe integration with webhook-backed local state and client mutators for
checkout, upgrades, cancellations, and billing portal access.

## Use when

- You sell subscriptions and want a prebuilt integration.
- You need a local subscription table for app logic and dashboards.
- You want a consistent API across frontend and backend.

## Config

The fragment config wires Stripe and your app identity model.

What you provide:

- `stripeSecretKey`: Stripe API secret key.
- `webhookSecret`: Stripe webhook signing secret.
- `resolveEntityFromRequest`: map the incoming request to your user/org. Must return:
  - `referenceId`: your user/org id.
  - `customerEmail`: email to attach to the Stripe customer.
  - `stripeCustomerId`: existing customer id, or `undefined`.
  - `stripeMetadata`: metadata to attach to the customer.
- `onStripeCustomerCreated`: store the Stripe customer id in your DB.
- `enableAdminRoutes`: `true` to expose `/admin/*` endpoints, otherwise `false`.

Optional config:

- `onEvent`: hook to run before built-in webhook handling.
- `stripeClientOptions`: pass through to the Stripe SDK.
- `logger`: override logging.

What the fragment needs via options:

- `databaseAdapter`: required for `subscription_stripe` table.
- `mountRoute` (optional): defaults to `/api/stripe`.

## What you get

- Subscription creation, upgrade, and cancellation flows.
- A local `subscription_stripe` table synced via webhooks.
- Admin hooks to list products, prices, customers, and subscriptions.

## Docs (curl)

Main docs pages:

- `curl -L "https://fragno.dev/docs/stripe/quickstart" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/stripe/subscriptions" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/stripe/webhooks" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/stripe/admin-hooks" -H "accept: text/markdown"`

Search:

- `curl -s "https://fragno.dev/api/search?query=stripe"`

## Prerequisites

- Stripe API key and webhook secret.
- A Stripe Product and Price configured in the Stripe dashboard.
- A database and `@fragno-dev/db` adapter.
- App authentication for `resolveEntityFromRequest`.

## Install

`npm install @fragno-dev/stripe @fragno-dev/db`

## Server setup

1. Create the fragment instance:
   - `createStripeFragment({ stripeSecretKey, webhookSecret, onStripeCustomerCreated, resolveEntityFromRequest, enableAdminRoutes? })`
2. Mount routes, default `/api/stripe`.
3. Generate migrations for the `subscription_stripe` table.
4. Configure Stripe webhooks to call `{mountRoute}/webhook`.

Example server module:

```ts
import { createStripeFragment } from "@fragno-dev/stripe";

export const stripeFragment = createStripeFragment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  onStripeCustomerCreated: async (stripeCustomerId, referenceId) => {
    // Store stripeCustomerId in your DB
  },
  resolveEntityFromRequest: async (context) => {
    const session = getSession(context.headers);
    return {
      referenceId: session.user.id,
      customerEmail: session.user.email,
      stripeCustomerId: session.user.stripeCustomerId || undefined,
      stripeMetadata: {},
    };
  },
  enableAdminRoutes: false,
});
```

## Database migrations

- `npx fragno-cli db generate lib/stripe.ts --format drizzle -o db/stripe.schema.ts`

## Client setup

```ts
import { createStripeFragmentClient } from "@fragno-dev/stripe/react";

export const stripeClient = createStripeFragmentClient({
  mountRoute: "/api/stripe",
});
```

## Client mutators

- `upgradeSubscription`
- `cancelSubscription`
- `useBillingPortal`

## Admin hooks

Enable `enableAdminRoutes: true` and protect `/admin/*` with middleware. Hooks:

- `useCustomers`
- `useProducts`
- `usePrices`
- `useSubscriptions`

## Webhooks

- Webhook endpoint: `{mountRoute}/webhook`.
- Use Stripe CLI locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## Security notes

- Only expose Price IDs to end users.
- Keep Customer/Product/Subscription IDs private.
- Admin routes must be protected with auth middleware.

## Common pitfalls

- Skipping webhook configuration leads to stale subscription state.
- Forgetting to persist Stripe customer IDs for later upgrades.
- Exposing admin routes without auth.

## Next steps

- Add a success page that calls `syncStripeSubscriptions` to refresh state after checkout.
- Build admin views with the admin hooks.
