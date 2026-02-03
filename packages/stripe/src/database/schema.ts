import { schema, idColumn, column } from "@fragno-dev/db/schema";

/**
 * Database schema for subscriptions that are linked to external stripe subscriptions.
 */
export const stripeSchema = schema("stripe", (s) => {
  return s.addTable("subscription", (t) => {
    return (
      t
        .addColumn("id", idColumn())
        // referenceId: entity to which this subscription applies (i.e. userId), nullable because unset on subscription updates
        .addColumn("referenceId", column("string").nullable())
        .addColumn("stripePriceId", column("string"))
        .addColumn("stripeCustomerId", column("string"))
        .addColumn("stripeSubscriptionId", column("string"))
        .addColumn("status", column("string").defaultTo("incomplete")) // Stripe.Subscription.Status
        .addColumn("periodStart", column("timestamp").nullable())
        .addColumn("periodEnd", column("timestamp").nullable())
        .addColumn("trialStart", column("timestamp").nullable())
        .addColumn("trialEnd", column("timestamp").nullable())
        .addColumn("cancelAtPeriodEnd", column("bool").defaultTo(false))
        .addColumn("cancelAt", column("timestamp").nullable())
        .addColumn("seats", column("integer").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_stripe_customer_id", ["stripeCustomerId"])
        .createIndex("idx_stripe_subscription_id", ["stripeSubscriptionId"])
        .createIndex("idx_reference_id", ["referenceId"])
    );
  });
});
