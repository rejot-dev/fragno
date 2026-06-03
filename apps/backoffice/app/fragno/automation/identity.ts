import { z } from "zod";

export const automationIdentityBindingRecordSchema = z.object({
  id: z.unknown().optional(),
  source: z.string(),
  key: z.string(),
  value: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  linkedAt: z.unknown().optional(),
  createdAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
});

export type AutomationIdentityBindingRecord = z.infer<typeof automationIdentityBindingRecordSchema>;
