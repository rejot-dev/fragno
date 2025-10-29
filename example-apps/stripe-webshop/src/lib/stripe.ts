import { createStripeFragment } from "@fragno-dev/stripe";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "../db";
import { user } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth/auth";
import { getSubscriptionForUser } from "./subscriptions.repo";

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
    resolveEntityFromRequest: async ({ headers }) => {
      const session = await auth.api.getSession({ headers });

      if (!session?.user) {
        throw new Error("User not authenticated");
      }

      // TODO: why does better-auth not return subscription data using the customSession plugin?
      const subscription = await getSubscriptionForUser(session.user.id);

      return {
        referenceId: session.user.id,
        stripeCustomerId: session.user.stripeCustomerId,
        customerEmail: session.user.email,
        subscriptionId: subscription?.id || undefined,
        stripeMetadata: {},
        // Check if user has admin role (via Better Auth admin plugin)
        // @ts-expect-error - Better Auth admin plugin adds role field
        isAdmin: session.user.role === "admin",
      };
    },
    onStripeCustomerCreated: async (stripeCustomerId, referenceId) => {
      // Update user with Stripe customer ID
      await db.update(user).set({ stripeCustomerId }).where(eq(user.id, referenceId));
    },
    enableAdminRoutes: true,
  },
  {
    databaseAdapter: new DrizzleAdapter({
      db,
      provider: "postgresql",
    }),
  },
);
