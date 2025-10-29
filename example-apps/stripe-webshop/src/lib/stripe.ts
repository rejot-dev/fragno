import { createStripeFragment } from "@fragno-dev/stripe";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "../db";
import { user } from "@/db/schema";
import { eq } from "drizzle-orm";

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
    subscriptions: {
      enabled: true,
    },
    onStripeCustomerCreated: async (stripeCustomerId, referenceId) => {
      // Update user with Stripe customer ID
      await db.update(user).set({ stripeCustomerId }).where(eq(user.id, referenceId));
    },
  },
  {
    databaseAdapter: new DrizzleAdapter({
      db,
      provider: "postgresql",
    }),
  },
).withMiddleware(async ({ path, headers }, { error }) => {
  // Protect admin routes
  if (path.startsWith("/admin/")) {
    // Dynamic import to avoid circular dependency (auth.ts imports stripeFragment)
    const { auth } = await import("@/lib/auth/auth");

    // Get session from Better Auth
    const session = await auth.api.getSession({ headers });

    // Check if user is authenticated
    if (!session?.user) {
      return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }

    // Check if user has admin role (via Better Auth admin plugin)
    // @ts-expect-error - Better Auth admin plugin adds role field
    if (session.user.role !== "admin") {
      return error({ message: "Forbidden", code: "FORBIDDEN" }, 403);
    }
  }

  // Allow request to continue
  return undefined;
});
