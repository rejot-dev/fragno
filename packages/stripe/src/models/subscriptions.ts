import { z } from "zod";

export const SubscriptionReponseSchema = z.object({
  id: z.string(),
  stripeSubscriptionId: z.string(),
  stripeCustomerId: z.string(),
  stripePriceId: z.string(),
  referenceId: z.string().nullable(),
  status: z.enum([
    "active",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "past_due",
    "paused",
    "trialing",
    "unpaid",
  ]),
  periodStart: z.date().nullable(),
  periodEnd: z.date().nullable(),
  trialStart: z.date().nullable(),
  trialEnd: z.date().nullable(),
  cancelAtPeriodEnd: z.boolean().nullable(),
  cancelAt: z.date().nullable(),
  seats: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const SubscriptionUpgradeRequestSchema = z.object({
  priceId: z.string().describe("Stripe price ID to subscribe/upgrade to"),
  quantity: z.number().positive().optional().describe("Number of seats"),
  successUrl: z.url().describe("Redirect URL after successful checkout"),
  cancelUrl: z.url().describe("Redirect URL if checkout is cancelled"),
  returnUrl: z.string().optional().describe("Return URL for billing portal"),
});

export type SubscriptionResponse = z.infer<typeof SubscriptionReponseSchema>;
