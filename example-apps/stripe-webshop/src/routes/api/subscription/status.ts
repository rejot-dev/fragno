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
        if (!session?.user?.id) {
          throw new Error("Not signed in");
        }

        // Stripe's webhook may arrive after Checkout redirects back, so sync from Stripe now.
        await stripeFragment.callServices(() =>
          stripeFragment.services.syncSubscriptions(session.user.id),
        );

        return Response.json({ synced: true });
      },
    },
  },
});
