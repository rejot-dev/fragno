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
- `resolveEntityFromRequest`: map the incoming request to your user/org, or return `null` when it is
  not authenticated (routes then respond 401). Must return:
  - `referenceId`: your user/org id.
  - `customerEmail`: email set on the Stripe customer the fragment creates.
  - `customerMetadata`: metadata set on that Stripe customer.

Optional callbacks, run as durable hooks (at least once, retried, `(payload, hookContext)`):

- `onCustomerLinked({ customerId, referenceId })`: a Stripe customer was linked to an entity.
- `onSubscriptionChanged({ subscription })`: a subscription changed; read at delivery, so current.
- `onStripeEvent({ event })`: every verified Stripe event.

What the fragment needs via options:

- `databaseAdapter`: required for the `customer` and `subscription` tables.
- `mountRoute` (optional): defaults to `/api/stripe`.

The fragment owns the customer link: it finds (by `metadata.referenceId`) or creates a Stripe
customer on an entity's first upgrade. Import links your app stored earlier with the `linkCustomer`
service.

## What you get

- Subscription creation, upgrade, and cancellation flows.
- Local `customer` and `subscription` tables synced via webhooks and durable hooks.
- Services: `getSubscriptionsByReferenceId`, `getCustomerByReferenceId`, `syncSubscriptions`,
  `linkCustomer`.
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
- A running durable hooks processor (webhook events are processed by durable hooks).
- App authentication for `resolveEntityFromRequest`.

## Install

`npm install @fragno-dev/stripe @fragno-dev/db`

## Server setup

1. Create the fragment instance:
   - `createStripeFragment({ stripeSecretKey, webhookSecret, resolveEntityFromRequest, ...callbacks }, { databaseAdapter })`
2. Mount routes, default `/api/stripe`.
3. Generate migrations for the `customer` and `subscription` tables.
4. Start a durable hooks processor.
5. Configure Stripe webhooks to call `{mountRoute}/webhook`.

Example server module:

```ts
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { createStripeFragment } from "@fragno-dev/stripe";

export const stripeFragment = createStripeFragment(
  {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    resolveEntityFromRequest: async (context) => {
      const session = await getSession(context.headers);
      if (!session) {
        return null;
      }
      return {
        referenceId: session.user.id,
        customerEmail: session.user.email,
        customerMetadata: {},
      };
    },
    onSubscriptionChanged: async ({ subscription }) => {
      // Grant or revoke access for subscription.referenceId
    },
  },
  { databaseAdapter },
);

createDurableHooksProcessor([stripeFragment], { pollIntervalMs: 2000 }).startPolling();
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

Admin routes are always mounted; protect `/admin/*` with middleware. Hooks:

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
- Not running a durable hooks processor: webhook events are recorded but never processed.
- Exposing admin routes without auth.

## Next steps

- Add a success page that calls the `syncSubscriptions` service to refresh state after checkout.
- Build admin views with the admin hooks.
