import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { customSession } from "better-auth/plugins";
import { admin } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";

import { db } from "@/db";

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
});

export type CustomAuth = typeof auth;
