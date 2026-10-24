---
"@fragno-dev/stripe": minor
---

feat!: process Stripe webhooks with durable hooks

The webhook route now verifies an event, records it once and returns; durable hooks fetch the
subscription from Stripe and store it, so redelivered, late and out-of-order events cannot roll it
back. Applications must run a durable hooks processor.

Breaking changes:

- The fragment links Stripe customers to entities itself in a new `customer` table and replaces the
  `subscription` table: rows are keyed by Stripe IDs, with `customerId`, `itemId`, `priceId`,
  `quantity`, `currentPeriodStart`/`End`, `canceledAt` and `endedAt`.
- `resolveEntityFromRequest` returns `{ referenceId, customerEmail, customerMetadata }` or `null`
  for unauthenticated requests (401 `UNAUTHENTICATED`).
- `onStripeCustomerCreated` and `onEvent` are replaced by the durable callbacks `onCustomerLinked`,
  `onSubscriptionChanged` and `onStripeEvent`, which receive the hook context.
- `enableAdminRoutes`, `stripeClientOptions` and `logger` are removed; protect `/admin/*` with
  middleware. `fetch` replaces the HTTP client option.
- Services are reduced to `getSubscriptionsByReferenceId`, `getCustomerByReferenceId`,
  `syncSubscriptions(referenceId)` and `linkCustomer`.
- `/subscription/upgrade`, `/subscription/cancel` and `/portal` respond with `{ url }`. Unknown
  promotion codes fail with `PROMOTION_CODE_INVALID`, and canceling a subscription that is already
  scheduled to cancel fails with `SUBSCRIPTION_ALREADY_CANCELED`.
- `/subscription/upgrade` and `/subscription/cancel` decide from the customer's subscriptions as
  Stripe lists them, so they act on the current state before webhooks arrive.
- `/admin/subscriptions` is cursor-paginated, the admin Stripe lists return narrowed objects and the
  client hook is renamed to `useSubscriptions`. Invalid `limit`, `pageSize`, `startingAfter` or
  `cursor` values fail with `400 INVALID_QUERY`.
- Requires `stripe` 23 and pins API version `2026-09-30.endive`.
