import { db } from "@/db";
import { subscription_stripe } from "@/db/subscriptions.schema";
import { eq } from "drizzle-orm";
import { getPlanByStripePriceId } from "@/lib/plans";

export async function getSubscriptionForUser(userId: string) {
  const result = await db
    .select()
    .from(subscription_stripe)
    .where(eq(subscription_stripe.referenceId, userId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const sub = result[0];
  const plan = sub.stripePriceId ? getPlanByStripePriceId(sub.stripePriceId) : null;

  return {
    ...sub,
    product: plan,
  };
}
