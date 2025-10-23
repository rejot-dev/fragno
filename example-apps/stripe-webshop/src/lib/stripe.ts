import { createStripeFragment } from "@fragno-dev/stripe";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "@/db";

// check env
if (!process.env["STRIPE_SECRET_KEY"]) {
  throw new Error("STRIPE_SECRET_KEY is not set");
} else if (!process.env["STRIPE_WEBHOOK_KEY"]) {
  throw new Error("STRIPE_WEBHOOK_SECRET is not set");
}

export const stripeFragment = createStripeFragment(
  {
    stripeSecretKey: process.env["STRIPE_SECRET_KEY"]!,
    webhookSecret: process.env["STRIPE_WEBHOOK_KEY"]!,
    // Note: Webhook callbacks are optional!
    // The fragment automatically handles all webhook events:
    // - checkout.session.completed: Creates/updates subscription in database
    // - customer.subscription.updated: Updates subscription details
    // - customer.subscription.deleted: Marks subscription as canceled
    //
    // You can provide callbacks to add custom logic that runs AFTER the default handling:
    // onCheckoutSessionCompleted: async ({ event, stripeClient }) => {
    //   // Send welcome email, update user permissions, etc.
    // },
    // onSubscriptionUpdated: async ({ event, stripeClient }) => {
    //   // Notify user of changes, handle plan upgrades, etc.
    // },
    // onSubscriptionDeleted: async ({ event, stripeClient }) => {
    //   // Send cancellation email, revoke access, etc.
    // },
  },
  {
    databaseAdapter: new DrizzleAdapter({
      db,
      provider: "postgresql",
    }),
  },
);

// For fragno-cli
export const fragment = stripeFragment;
