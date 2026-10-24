import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { eq } from "drizzle-orm";
import { KyselyPGlite } from "kysely-pglite";

import { createStripeFragment } from "@fragno-dev/stripe";

import { db } from "../db";
import { user } from "../db/schema";
import { auth } from "./auth/auth";

const { dialect } = new KyselyPGlite(db.$client);

export const stripeFragment: ReturnType<typeof createStripeFragment> = createStripeFragment(
  {
    get stripeSecretKey() {
      if (!process.env["STRIPE_SECRET_KEY"]) {
        throw new Error("STRIPE_SECRET_KEY is not set");
      }
      return process.env["STRIPE_SECRET_KEY"];
    },
    get webhookSecret() {
      if (!process.env["STRIPE_WEBHOOK_KEY"]) {
        throw new Error("STRIPE_WEBHOOK_KEY is not set");
      }
      return process.env["STRIPE_WEBHOOK_KEY"];
    },
    resolveEntityFromRequest: async ({ headers }) => {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) {
        return null;
      }
      return {
        referenceId: session.user.id,
        customerEmail: session.user.email,
        customerMetadata: {},
      };
    },
    onCustomerLinked: async ({ customerId, referenceId }) => {
      // Keep a copy on the user so the admin users table can show it.
      await db.update(user).set({ stripeCustomerId: customerId }).where(eq(user.id, referenceId));
    },
  },
  {
    databaseAdapter: new SqlAdapter({
      dialect,
      driverConfig: new PGLiteDriverConfig(),
    }),
  },
).withMiddleware(async ({ path, headers }, { error }) => {
  if (!path.startsWith("/admin/")) {
    return undefined;
  }
  const session = await auth.api.getSession({ headers });
  // @ts-expect-error - Better Auth admin plugin adds role field
  if (session?.user.role !== "admin") {
    return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  return undefined;
});

// Webhooks are processed by durable hooks; poll so retries run even without new requests.
createDurableHooksProcessor([stripeFragment], { pollIntervalMs: 2000 }).startPolling();
