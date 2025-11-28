import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { customSession } from "better-auth/plugins";
import { admin } from "better-auth/plugins";
import { db } from "@/db";
import { stripeFragment } from "@/lib/stripe";
import { getSubscriptionForUser } from "../subscriptions.repo";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    customSession(async ({ user, session }) => {
      const subscription = await getSubscriptionForUser(user.id);
      return {
        subscription: subscription,
        user: {
          ...user,
          // Added here because I couldn't get type inference with additionalFields working
          // @ts-expect-error TS2339
          stripeCustomerId: user.stripeCustomerId as string | undefined,
        },
        session,
      };
    }),
    admin(),
    tanstackStartCookies(),
  ],
  user: {
    additionalFields: {
      stripeCustomerId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user, ctx) => {
          // Create Stripe Customer when user is signed up
          const client = stripeFragment.services.getStripeClient();

          // If this call fails the user will still be created in the database but not linked to a Stripe customer!
          try {
            const customer = await client.customers.create({
              name: user.name,
              email: user.email,
              metadata: {
                referenceId: user.id,
              },
            });

            await ctx?.context.internalAdapter.updateUser(user.id, {
              stripeCustomerId: customer.id,
            });
          } catch (error) {
            console.warn("Failed to create Stripe customer:", error);
          }
        },
      },
    },
  },
});

export type CustomAuth = typeof auth;
