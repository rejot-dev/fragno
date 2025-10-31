import { z } from "zod";

export const CustomerResponseSchema = z.object({
  id: z.string(),
  object: z.literal("customer"),
  balance: z.number(),
  business_name: z.string().optional(),
  created: z.number(),
  currency: z.string().nullable().optional(),
  deleted: z.void().optional(),
  delinquent: z.boolean().nullable().optional(),
  description: z.string().nullable(),
  email: z.string().nullable(),
  individual_name: z.string().optional(),
  invoice_credit_balance: z.record(z.string(), z.number()).optional(),
  invoice_prefix: z.string().nullable().optional(),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()),
  name: z.string().nullable().optional(),
  next_invoice_sequence: z.number().optional(),
  phone: z.string().nullable().optional(),
  preferred_locales: z.array(z.string()).nullable().optional(),
});

export type CustomerResponseSchema = z.infer<typeof CustomerResponseSchema>;
