import { getPlanByStripePriceId } from "@/lib/plans";
import { stripeFragment } from "@/lib/stripe";

/** The user's current subscription: the ongoing one if any, else the most recent. */
export async function getSubscriptionForUser(userId: string) {
  const subscriptions = await stripeFragment.callServices(() =>
    stripeFragment.services.getSubscriptionsByReferenceId(userId),
  );
  const [subscription] = subscriptions.toSorted(
    (a, b) =>
      Number(isOngoing(b)) - Number(isOngoing(a)) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  if (!subscription) {
    return null;
  }

  return {
    ...subscription,
    product: getPlanByStripePriceId(subscription.priceId),
  };
}

function isOngoing(subscription: { status: string }) {
  return subscription.status === "active" || subscription.status === "trialing";
}
