import { z } from "zod";

export const PriceResponseSchema = z.object({
  id: z.string(),
  object: z.literal("price"),
  active: z.boolean(),
  billing_scheme: z.string(),
  created: z.number(),
  currency: z.string(),
  custom_unit_amount: z.any().nullable().optional(),
  deleted: z.void().optional(),
  livemode: z.boolean(),
  lookup_key: z.string().nullable().optional(),
  metadata: z.any(),
  nickname: z.string().nullable().optional(),
  product: z.union([z.string(), z.any()]),
  recurring: z
    .object({
      aggregate_usage: z.string().nullable().optional(),
      interval: z.enum(["day", "week", "month", "year"]),
      interval_count: z.number(),
      meter: z.string().nullable().optional(),
      trial_period_days: z.number().nullable().optional(),
      usage_type: z.string(),
    })
    .nullable()
    .optional(),
  tax_behavior: z.string().nullable().optional(),
  tiers_mode: z.string().nullable().optional(),
  transform_quantity: z.any().nullable().optional(),
  type: z.enum(["one_time", "recurring"]),
  unit_amount: z.number().nullable().optional(),
  unit_amount_decimal: z.string().nullable().optional(),
});

export type PriceResponseSchema = z.infer<typeof PriceResponseSchema>;
