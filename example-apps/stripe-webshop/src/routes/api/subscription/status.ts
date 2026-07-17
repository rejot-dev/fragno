import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/lib/auth/auth";
import { stripeFragment } from "@/lib/stripe";

export const Route = createFileRoute("/api/subscription/status")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (session?.user?.id && session?.user?.stripeCustomerId) {
          const referenceId = session.user.id;
          const stripeCustomerId = session.user.stripeCustomerId;
          const stripeClient = stripeFragment.services.getStripeClient();
          const stripeSubscriptions = await stripeClient.subscriptions.list({
            customer: stripeCustomerId,
            status: "all",
          });

          // Sync subscription from Stripe to ensure database is up-to-date
          await stripeFragment.callServices(() =>
            stripeFragment.services.syncStripeSubscriptions(
              referenceId,
              stripeCustomerId,
              stripeSubscriptions.data,
            ),
          );
        } else {
          throw new Error("User not linked to Stripe account");
        }

        return Response.json({ synced: true });
      },
    },
  },
});
