import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/client";

type CheckoutType = "subscribe" | "cancel";

type SearchParams = {
  checkoutType: CheckoutType;
};

export const Route = createFileRoute("/_authenticated/checkout")({
  component: CheckoutPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const param = search["checkoutType"];
    if (param === "subscribe" || param === "cancel") {
      return {
        checkoutType: param as CheckoutType,
      };
    }
    return {
      checkoutType: "subscribe",
    };
  },
});

function CheckoutPage() {
  const navigate = useNavigate();
  const { refetch: refetchSession } = useSession();
  const { checkoutType } = Route.useSearch();

  // Sync subscription on successful checkout or cancellation
  const { isLoading, isSuccess, isError } = useQuery({
    queryKey: ["syncSubscription"],
    queryFn: async () => {
      const response = await fetch("/api/subscription/status");
      if (!response.ok) {
        throw new Error("Failed to get subscription");
      }
      return response.json();
    },
    retry: true,
  });

  useEffect(() => {
    if (isSuccess) {
      // Update session as it contains our user's subscription status
      refetchSession();
      navigate({ to: "/profile" });
    }
  }, [isSuccess]);

  return (
    <div className="flex min-h-svh w-full flex-col items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">
            {isLoading && checkoutType == "subscribe" && "Verifying your subscription..."}
            {isLoading && checkoutType == "cancel" && "Verifying your cancellation..."}
            {isSuccess && "Verified!"}
            {isError && "Verification Failed"}
          </CardTitle>
          <CardDescription className="text-center">
            {isLoading &&
              checkoutType == "subscribe" &&
              "Please wait while we verify your subscription."}
            {isLoading &&
              checkoutType == "cancel" &&
              "Please wait while we verify your cancellation."}
            {isSuccess && "Done! Redirecting to your profile..."}
            {isError && "Failed to verify your action"}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
