import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { signOut, useSession } from "@/lib/auth/client";
import { useState } from "react";
import { stripeClient } from "@/lib/stripe.client";
import { PLANS } from "@/lib/plans";
import { formatDate } from "@/lib/dates";

export const Route = createFileRoute("/_authenticated/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const { data: session } = useSession();
  const navigate = useNavigate();

  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [promotionCode, setPromotionCode] = useState<string>("");
  const {
    mutate: upgrade,
    error: upgradeError,
    loading: isUpgrading,
  } = stripeClient.upgradeSubscription();

  const {
    mutate: cancelSubscription,
    error: cancelError,
    loading: isCanceling,
  } = stripeClient.cancelSubscription();

  const {
    mutate: createPortal,
    error: portalError,
    loading: isCreatingPortal,
  } = stripeClient.useBillingPortal();

  const baseUrl = window.location.origin;

  const handleUpgradeSubscription = async (priceId: string) => {
    if (!session?.user.id) {
      return;
    }
    const result = await upgrade({
      body: {
        priceId,
        successUrl: `${baseUrl}/checkout?checkoutType=subscribe`,
        cancelUrl: window.location.href,
        quantity: 1,
        ...(promotionCode && { promotionCode }),
      },
    });

    if (result?.redirect) {
      window.location.href = result.url;
    }
  };

  const handleBillingPortal = async () => {
    if (!session?.user.id) {
      return;
    }
    const result = await createPortal({
      body: {
        returnUrl: `${baseUrl}/checkout?checkoutType=subscribe`,
      },
    });

    if (result?.redirect) {
      window.location.href = result.url;
    }
  };

  const handleCancelSubscription = async () => {
    if (!session?.subscription?.id) {
      return;
    }

    const result = await cancelSubscription({
      body: {
        returnUrl: `${baseUrl}/checkout?checkoutType=cancel`,
      },
    });

    if (result?.redirect) {
      window.location.href = result.url;
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/" });
  };

  const formatPrice = (cents: number) => {
    if (cents === 0) {
      return "Free";
    }
    return `$${(cents / 100).toFixed(0)}`;
  };

  // Safety check - should be protected by _authenticated layout
  if (!session?.user) {
    return null;
  }

  return (
    <div className="flex min-h-svh w-full flex-col items-center p-6 md:p-10">
      <div className="w-full max-w-4xl space-y-8">
        {/* User Profile Section */}
        <Card>
          <CardHeader>
            <CardTitle>User Profile</CardTitle>
            <CardDescription>Manage your account information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div>
                <label className="text-muted-foreground text-sm font-medium">Name</label>
                <p className="text-lg font-semibold">{session.user.name}</p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">Email</label>
                <p className="text-lg">{session.user.email}</p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">Email Verified</label>
                <p className="text-lg">
                  {session.user.emailVerified ? (
                    <span className="text-green-600">✓ Verified</span>
                  ) : (
                    <span className="text-amber-600">Not verified</span>
                  )}
                </p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">
                  Subscription Status
                </label>
                <p className="text-lg">
                  {session.subscription?.status || "No subscription"}
                  {session.subscription?.cancelAt && (
                    <span className="text-muted-foreground ml-2 text-sm">
                      (cancels {formatDate(session.subscription.cancelAt)})
                    </span>
                  )}
                </p>
              </div>

              {session.subscription?.product && (
                <div>
                  <label className="text-muted-foreground text-sm font-medium">Current Plan</label>
                  <p className="text-lg font-semibold">
                    {session.subscription.product.displayName}
                  </p>
                </div>
              )}

              {session.subscription && (
                <div>
                  <span className="text-muted-foreground text-sm font-medium">
                    Change Billing Details
                  </span>
                  {portalError && <p className="text-sm text-red-500">{portalError.message}</p>}
                  <p>
                    <Button
                      variant="secondary"
                      onClick={handleBillingPortal}
                      disabled={isCreatingPortal}
                    >
                      Manage Billing
                    </Button>
                  </p>
                </div>
              )}

              <div>
                <label className="text-muted-foreground text-sm font-medium">Account Created</label>
                <p className="text-lg">{formatDate(session.user.createdAt)}</p>
              </div>
            </div>

            <div className="flex gap-4 pt-4">
              <Button variant="destructive" onClick={handleSignOut}>
                Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Subscription Plans Section */}
        <Card>
          <CardHeader>
            <CardTitle>Subscription Plans</CardTitle>
            <CardDescription>Choose the plan that works best for you</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Promotion Code Input */}
            <div className="flex flex-col gap-2">
              <label htmlFor="promotion-code" className="text-sm font-medium">
                Promotion Code (Optional)
              </label>
              <Input
                id="promotion-code"
                type="text"
                placeholder="Enter promotion code"
                value={promotionCode}
                onChange={(e) => setPromotionCode(e.target.value)}
                className="max-w-xs"
              />
              <p className="text-muted-foreground text-xs">
                Enter a promotion code to apply a discount to your subscription
              </p>
            </div>

            {/* Billing Cycle Toggle */}
            <div className="flex items-center justify-center gap-4">
              <Button
                variant={billingCycle === "monthly" ? "default" : "outline"}
                onClick={() => setBillingCycle("monthly")}
              >
                Monthly
              </Button>
              <Button
                variant={billingCycle === "yearly" ? "default" : "outline"}
                onClick={() => setBillingCycle("yearly")}
              >
                Yearly
                <span className="ml-2 rounded bg-green-600 px-2 py-0.5 text-xs text-white">
                  Special Price!
                </span>
              </Button>
            </div>
            {(upgradeError || cancelError) && (
              <div className="text-center text-red-600">
                <span className="font-bold">{upgradeError?.code || cancelError?.code}</span>:
                {upgradeError?.message || cancelError?.message}
              </div>
            )}

            {/* Products Grid */}
            <div className="grid gap-6 md:grid-cols-3">
              {PLANS.map((plan) => {
                const price = billingCycle === "monthly" ? plan.priceMonthly : plan.priceYearly;
                const priceId =
                  billingCycle === "monthly" ? plan.stripeMonthlyPriceId : plan.stripeYearlyPriceId;
                const isCurrentPlan = session.subscription?.stripePriceId === priceId;
                const isPopular = plan.name === "plus";
                const isFreePlan = plan.name === "free";
                const hasActiveSubscription = session.subscription?.status === "active";
                const isScheduledToCancel =
                  Boolean(session.subscription?.cancelAtPeriodEnd) ||
                  Boolean(session.subscription?.cancelAt);

                // Determine button text and behavior
                let buttonText = "Switch";
                if (isCurrentPlan && isScheduledToCancel) {
                  buttonText = "Renew";
                } else if (isCurrentPlan) {
                  buttonText = "Current Plan";
                } else if (isFreePlan && hasActiveSubscription) {
                  buttonText = "Cancel";
                }

                return (
                  <Card
                    key={plan.id}
                    className={`relative ${isPopular ? "border-2 border-blue-500" : ""} ${isCurrentPlan ? "border-2 border-green-500" : ""}`}
                  >
                    {isCurrentPlan && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-green-500 px-3 py-1 text-xs font-semibold text-white">
                        Current Plan
                      </div>
                    )}
                    {!isCurrentPlan && isPopular && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-500 px-3 py-1 text-xs font-semibold text-white">
                        Popular
                      </div>
                    )}
                    <CardHeader>
                      <CardTitle className="text-2xl">{plan.displayName}</CardTitle>
                      <CardDescription>{plan.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div>
                        <div className="text-4xl font-bold">{formatPrice(price)}</div>
                        {price > 0 && (
                          <div className="text-muted-foreground text-sm">
                            per {billingCycle === "monthly" ? "month" : "year"}
                          </div>
                        )}
                      </div>
                      {isCurrentPlan && isScheduledToCancel && session.subscription?.cancelAt && (
                        <div className="text-center text-sm font-medium text-amber-600">
                          Cancels {formatDate(session.subscription.cancelAt)}
                        </div>
                      )}
                      <Button
                        className="w-full"
                        disabled={
                          isUpgrading ||
                          isCanceling ||
                          (isCurrentPlan && !isScheduledToCancel) ||
                          (!priceId && !isFreePlan) ||
                          (isFreePlan && !hasActiveSubscription) ||
                          (isFreePlan && isScheduledToCancel)
                        }
                        variant={
                          isCurrentPlan && isScheduledToCancel
                            ? "default"
                            : isCurrentPlan
                              ? "secondary"
                              : isFreePlan && hasActiveSubscription
                                ? "destructive"
                                : "default"
                        }
                        onClick={() => {
                          if (isFreePlan && hasActiveSubscription && !isScheduledToCancel) {
                            handleCancelSubscription();
                          } else if (priceId) {
                            handleUpgradeSubscription(priceId);
                          }
                        }}
                      >
                        {buttonText}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
