import { z } from "zod";

export const SubscriptionReponseSchema = z.object({
  id: z.string(),
  plan: z.string(),
  referenceId: z.string(),
  stripeCustomerId: z.string().nullable(),
  stripeSubscriptionId: z.string().nullable(),
  status: z.string(),
  periodStart: z.number().nullable(),
  periodEnd: z.number().nullable(),
  trialStart: z.number().nullable(),
  trialEnd: z.number().nullable(),
  cancelAtPeriodEnd: z.boolean().nullable(),
  seats: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type SubscriptionResponse = z.infer<typeof SubscriptionReponseSchema>;
