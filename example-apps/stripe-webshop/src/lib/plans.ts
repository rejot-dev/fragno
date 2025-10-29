export type Plan = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  stripeProductId: string | null;
  stripeMonthlyPriceId: string | null;
  stripeYearlyPriceId: string | null;
};

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "free",
    displayName: "Free",
    description: "Perfect for trying out our platform with basic features",
    priceMonthly: 0,
    priceYearly: 0,
    stripeProductId: null,
    stripeMonthlyPriceId: null,
    stripeYearlyPriceId: null,
  },
  {
    id: "plus",
    name: "plus",
    displayName: "Plus",
    description: "Enhanced features for growing teams and professionals",
    priceMonthly: 900, // $9.00
    priceYearly: 9000, // $90.00
    stripeProductId: "prod_TJPwj9ZzyMF6ne",
    stripeMonthlyPriceId: "price_1SMn6rQmJc11Jgb4uyX5jRRL",
    stripeYearlyPriceId: "price_1SMn6rQmJc11Jgb4a8oT0yri",
  },
  {
    id: "premium",
    name: "premium",
    displayName: "Premium",
    description: "Full access to all features for power users and enterprises",
    priceMonthly: 2900, // $29.00
    priceYearly: 29000, // $290.00
    stripeProductId: "prod_TJPwm1A8z8eR3x",
    stripeMonthlyPriceId: "price_1SMn6sQmJc11Jgb4Xd74XDP7",
    stripeYearlyPriceId: "price_1SMn6sQmJc11Jgb42RkyvbG9",
  },
];

/**
 * Get a plan by its ID
 */
export function getPlanById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/**
 * Get a plan by its Stripe price ID
 */
export function getPlanByStripePriceId(priceId: string): Plan | undefined {
  return PLANS.find(
    (plan) => plan.stripeMonthlyPriceId === priceId || plan.stripeYearlyPriceId === priceId,
  );
}

/**
 * Get a plan by its Stripe product ID
 */
export function getPlanByStripeProductId(productId: string): Plan | undefined {
  return PLANS.find((plan) => plan.stripeProductId === productId);
}
