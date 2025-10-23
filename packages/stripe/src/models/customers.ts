import { z } from "zod";

export const CustomerSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  created: z.number(),
  metadata: z.record(z.string(), z.string()),
});

export type CustomerSchema = z.infer<typeof CustomerSchema>;
