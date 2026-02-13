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
          const stripeClient = stripeFragment.services.getStripeClient();
          const stripeSubscriptions = await stripeClient.subscriptions.list({
            customer: session.user.stripeCustomerId,
            status: "all",
          });

          // Sync subscription from Stripe to ensure database is up-to-date
          await stripeFragment.services.syncStripeSubscriptions(
            session.user.id,
            session.user.stripeCustomerId,
            stripeSubscriptions.data,
          );
        } else {
          throw new Error("User not linked to Stripe account");
        }

        return Response.json({ synced: true });
      },
    },
  },
});
