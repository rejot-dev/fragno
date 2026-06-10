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

export const automationStoreEntrySchema = z.object({
  id: idSchema.optional(),
  key: z.string(),
  value: z.string(),
  createdAt: isoTimestampSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
});

export const automationStoreDeleteResultSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
});

export type AutomationStoreEntry = z.infer<typeof automationStoreEntrySchema>;
export type AutomationStoreDeleteResult = z.infer<typeof automationStoreDeleteResultSchema>;
