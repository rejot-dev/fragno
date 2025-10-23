import { createFileRoute } from "@tanstack/react-router";
import { stripeFragment } from "@/lib/stripe";

export const Route = createFileRoute("/api/stripe/$")({
  server: {
    handlers: stripeFragment.handlersFor("tanstack-start"),
  },
});
