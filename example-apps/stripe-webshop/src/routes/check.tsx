import { createFileRoute } from "@tanstack/react-router";
import { StripeProducts } from "@/components/StripeProducts";

// This is for checking async_hooks are not in the client bundle in async_hooks.test.ts

export const Route = createFileRoute("/check")({
  component: RouteComponent,
});

function RouteComponent() {
  return <StripeProducts />;
}
