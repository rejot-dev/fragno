import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const idSchema = z.lazy(() =>
  z.preprocess((value) => {
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
  }, z.string()),
);

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

export const automationStoreCategorySchema = z.lazy(() =>
  z.preprocess(normalizeStringList, z.array(z.string().trim().min(1))),
);

export const automationStoreCategoryInputSchema = z.lazy(() =>
  z.array(z.string().trim().min(1)).transform((value) => normalizeStringList(value)),
);

export const automationStoreVerificationSchema = z.lazy(() =>
  z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("json-schema"),
        schema: z.unknown(),
      }),
    ]),
  ),
);

export const automationStoreSetInputSchema = z.lazy(() =>
  z.strictObject({
    key: z.string().trim().min(1),
    value: z.string(),
    description: z.string().trim().min(1).nullable().optional(),
    category: automationStoreCategoryInputSchema.optional(),
    verification: automationStoreVerificationSchema.optional(),
  }),
);

export const automationStoreListInputSchema = z.lazy(() =>
  z.strictObject({
    prefix: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
);

export const automationStoreDeleteInputSchema = z.lazy(() =>
  z.strictObject({
    key: z.string().trim().min(1),
  }),
);

export const automationStoreValueShape = {
  key: z.lazy(() => z.string()),
  value: z.lazy(() => z.string()),
  description: z.lazy(() => z.string().nullable().optional()),
  category: automationStoreCategorySchema,
};

export const automationStoreEntrySchema = z.lazy(() =>
  z.object({
    id: idSchema.optional(),
    ...automationStoreValueShape,
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
  }),
);

export type AutomationStoreEntry = z.infer<typeof automationStoreEntrySchema>;

export const automationStoreSetResultSchema = z.lazy(() =>
  z.object({
    id: idSchema,
    ...automationStoreValueShape,
  }),
);

export type AutomationStoreSetResult = z.infer<typeof automationStoreSetResultSchema>;

export const automationStoreDeleteResultSchema = z.lazy(() =>
  z.object({
    ok: z.literal(true),
    key: z.string(),
  }),
);

export type AutomationStoreDeleteResult = z.infer<typeof automationStoreDeleteResultSchema>;

export const storeOperations = {
  "store.get": {
    description: "Get an automation store entry by key.",
    permissions: [BACKOFFICE_PERMISSION.store.read],
    input: z.lazy(() => z.strictObject({ key: z.string().trim().min(1) })),
    output: z.lazy(() => automationStoreEntrySchema.nullable()),
  },
  "store.set": {
    description: "Create or update an automation store entry.",
    permissions: [BACKOFFICE_PERMISSION.store.modify],
    input: automationStoreSetInputSchema,
    output: automationStoreSetResultSchema,
  },
  "store.list": {
    description: "List automation store entries, optionally filtered by key prefix.",
    permissions: [BACKOFFICE_PERMISSION.store.read],
    input: automationStoreListInputSchema,
    output: z.lazy(() => z.array(automationStoreEntrySchema)),
  },
  "store.delete": {
    description: "Delete an automation store entry by key.",
    permissions: [BACKOFFICE_PERMISSION.store.modify],
    input: z.lazy(() => z.strictObject({ key: z.string().trim().min(1) })),
    output: z.lazy(() => automationStoreDeleteResultSchema.nullable()),
  },
} satisfies Record<string, BackofficeApiOperation>;
