import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/lib/auth/auth";
import { stripeFragment } from "@/lib/stripe";

export const Route = createFileRoute("/api/users/link-customer")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        // @ts-expect-error - Better Auth admin plugin adds role field
        if (session?.user.role !== "admin") {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { userId, customerId } = (await request.json()) as {
          userId: string;
          customerId: string;
        };
        // `onCustomerLinked` stores the customer ID on the user.
        const result = await stripeFragment.callServices(() =>
          stripeFragment.services.linkCustomer({ customerId, referenceId: userId }),
        );
        return Response.json(result, { status: result.ok ? 200 : 409 });
      },
    },
  },
});
