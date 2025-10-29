import { z } from "zod";

export const ProductResponseSchema = z.object({
  id: z.string(),
  object: z.literal("product"),
  active: z.boolean(),
  created: z.number(),
  default_price: z.union([z.string(), z.any()]).nullable().optional(),
  deleted: z.void().optional(),
  description: z.string().nullable(),
  images: z.array(z.string()),
  livemode: z.boolean(),
  marketing_features: z.array(z.any()),
  metadata: z.any(),
  name: z.string(),
  package_dimensions: z.any().nullable(),
  shippable: z.boolean().nullable(),
  statement_descriptor: z.string().nullable().optional(),
  tax_code: z.union([z.string(), z.any()]).nullable(),
  type: z.string(),
  unit_label: z.string().nullable().optional(),
  updated: z.number(),
  url: z.string().nullable(),
});

export type ProductResponseSchema = z.infer<typeof ProductResponseSchema>;
