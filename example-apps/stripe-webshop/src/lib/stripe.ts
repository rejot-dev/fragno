import { createStripeFragment } from "@fragno-dev/stripe";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { db } from "../db";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import { auth } from "./auth/auth";
import { KyselyPGlite } from "kysely-pglite";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";

const { dialect } = new KyselyPGlite(db.$client);

export const stripeFragment = createStripeFragment(
  {
    get stripeSecretKey() {
      if (!process.env["STRIPE_SECRET_KEY"]) {
        throw new Error("STRIPE_SECRET_KEY is not set");
      }
      return process.env["STRIPE_SECRET_KEY"]!;
    },
    get webhookSecret() {
      if (!process.env["STRIPE_WEBHOOK_KEY"]) {
        throw new Error("STRIPE_WEBHOOK_KEY is not set");
      }
      return process.env["STRIPE_WEBHOOK_KEY"]!;
    },
    resolveEntityFromRequest: async ({ headers }) => {
      const session = await auth.api.getSession({ headers });

      if (!session?.user) {
        throw new Error("User not authenticated");
      }

      return {
        referenceId: session.user.id,
        stripeCustomerId: session.user.stripeCustomerId,
        customerEmail: session.user.email,
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
    databaseAdapter: new SqlAdapter({
      dialect,
      driverConfig: new PGLiteDriverConfig(),
    }),
  },
);
