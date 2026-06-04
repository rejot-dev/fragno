import { z } from "zod";

const idSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "valueOf" in value) {
    const primitive = value.valueOf();
    if (typeof primitive === "string" || typeof primitive === "number") {
      return String(primitive);
    }
  }
  return value;
}, z.string());

const isoTimestampSchema = z.preprocess((value) => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === "object" && (value as { tag?: unknown }).tag === "db-now") {
    return new Date().toISOString();
  }
  return value;
}, z.iso.datetime());

export const automationIdentityBindingRecordSchema = z.object({
  id: idSchema.optional(),
  source: z.string(),
  key: z.string(),
  value: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  linkedAt: isoTimestampSchema.optional(),
  createdAt: isoTimestampSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
});

export type AutomationIdentityBindingRecord = z.infer<typeof automationIdentityBindingRecordSchema>;
