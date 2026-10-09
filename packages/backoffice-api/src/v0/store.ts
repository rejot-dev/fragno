import { z } from "zod";

import type { BackofficeApiOperation } from "../api";

export const idSchema = z.preprocess((value) => {
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

export const normalizeStringList = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
};

export const automationStoreCategorySchema = z.preprocess(
  normalizeStringList,
  z.array(z.string().trim().min(1)),
);

export const automationStoreCategoryInputSchema = z
  .array(z.string().trim().min(1))
  .transform((value) => normalizeStringList(value));

export const automationStoreVerificationSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("json-schema"),
      schema: z.unknown(),
    }),
  ]),
);

export const automationStoreSetInputSchema = z.strictObject({
  key: z.string().trim().min(1),
  value: z.string(),
  description: z.string().trim().min(1).nullable().optional(),
  category: automationStoreCategoryInputSchema.optional(),
  verification: automationStoreVerificationSchema.optional(),
});

export const automationStoreListInputSchema = z.strictObject({
  prefix: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const automationStoreDeleteInputSchema = z.strictObject({
  key: z.string().trim().min(1),
});

export const automationStoreValueShape = {
  key: z.string(),
  value: z.string(),
  description: z.string().nullable().optional(),
  category: automationStoreCategorySchema,
};

export const automationStoreEntrySchema = z.object({
  id: idSchema.optional(),
  ...automationStoreValueShape,
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
});

export type AutomationStoreEntry = z.infer<typeof automationStoreEntrySchema>;

export const automationStoreSetResultSchema = z.object({
  id: idSchema,
  ...automationStoreValueShape,
});

export type AutomationStoreSetResult = z.infer<typeof automationStoreSetResultSchema>;

export const automationStoreDeleteResultSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
});

export type AutomationStoreDeleteResult = z.infer<typeof automationStoreDeleteResultSchema>;

export const storeOperations = {
  "store.get": {
    description: "Get an automation store entry by key.",
    input: z.strictObject({ key: z.string().trim().min(1) }),
    output: automationStoreEntrySchema.nullable(),
  },
  "store.set": {
    description: "Create or update an automation store entry.",
    input: automationStoreSetInputSchema,
    output: automationStoreSetResultSchema,
  },
  "store.list": {
    description: "List automation store entries, optionally filtered by key prefix.",
    input: automationStoreListInputSchema,
    output: z.array(automationStoreEntrySchema),
  },
  "store.delete": {
    description: "Delete an automation store entry by key.",
    input: z.strictObject({ key: z.string().trim().min(1) }),
    output: automationStoreDeleteResultSchema.nullable(),
  },
} satisfies Record<string, BackofficeApiOperation>;
