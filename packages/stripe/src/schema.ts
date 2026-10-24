import { column, idColumn, schema } from "@fragno-dev/db/schema";

/**
 * A local copy of the Stripe state the app reads. Rows are keyed by Stripe IDs and only written
 * from what Stripe reports, so Stripe stays the source of truth.
 */
export const stripeSchema = schema("stripe", (s) => {
  return s
    .addTable("customer", (t) => {
      return (
        t
          // The Stripe customer ID.
          .addColumn("id", idColumn())
          // The app entity (user, organization, ...) this customer pays for.
          .addColumn("referenceId", column("string"))
          .addColumn(
            "linkedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_customer_reference_id", ["referenceId"], { unique: true })
      );
    })
    .addTable("subscription", (t) => {
      return (
        t
          // The Stripe subscription ID.
          .addColumn("id", idColumn())
          .addColumn("customerId", column("string"))
          // Null while the customer is not linked to an app entity.
          .addColumn("referenceId", column("string").nullable())
          // Subscriptions created by this fragment have exactly one item.
          .addColumn("itemId", column("string"))
          .addColumn("priceId", column("string"))
          .addColumn("quantity", column("integer").nullable())
          // Stripe.Subscription.Status
          .addColumn("status", column("string"))
          .addColumn("currentPeriodStart", column("timestamp"))
          .addColumn("currentPeriodEnd", column("timestamp"))
          .addColumn("trialStart", column("timestamp").nullable())
          .addColumn("trialEnd", column("timestamp").nullable())
          .addColumn("cancelAtPeriodEnd", column("bool"))
          .addColumn("cancelAt", column("timestamp").nullable())
          .addColumn("canceledAt", column("timestamp").nullable())
          .addColumn("endedAt", column("timestamp").nullable())
          // When Stripe created the subscription.
          .addColumn("createdAt", column("timestamp"))
          // When this row last changed.
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_subscription_customer_id", ["customerId"])
          .createIndex("idx_subscription_reference_id", ["referenceId"])
      );
    });
});
