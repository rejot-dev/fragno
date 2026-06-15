import { z } from "zod";

import { Validator, type Schema } from "@cfworker/json-schema";

import type { AutomationEventActor } from "./contracts";

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

const normalizeStringList = (value: unknown) => {
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

export const automationStoreActorSchema: z.ZodType<AutomationEventActor> = z
  .object({
    scope: z.enum(["internal", "external"]),
    type: z.string().trim().min(1),
    id: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
  })
  .catchall(z.unknown());

const automationStoreCategorySchema = z.preprocess(
  normalizeStringList,
  z.array(z.string().trim().min(1)),
);

const automationStoreCategoryInputSchema = z
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

export const automationStoreSetInputSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string(),
  actor: automationStoreActorSchema.nullable(),
  description: z.string().trim().min(1).nullable().optional(),
  category: automationStoreCategoryInputSchema.optional(),
  verification: automationStoreVerificationSchema.optional(),
});

export const automationStoreListInputSchema = z.object({
  prefix: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const automationStoreEntrySchema = z.object({
  id: idSchema.optional(),
  key: z.string(),
  value: z.string(),
  description: z.string().nullable().optional(),
  category: automationStoreCategorySchema,
  actor: z.preprocess((value) => value ?? null, automationStoreActorSchema.nullable()),
  createdAt: isoTimestampSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
});

export const automationStoreDeleteResultSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
});

export type AutomationStoreVerification = z.infer<typeof automationStoreVerificationSchema>[number];

export class AutomationStoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStoreVerificationError";
  }
}
export type AutomationStoreEntry = z.infer<typeof automationStoreEntrySchema>;
export type AutomationStoreDeleteResult = z.infer<typeof automationStoreDeleteResultSchema>;

const asValidatorSchema = (schema: unknown): Schema | boolean => {
  if (typeof schema === "boolean") {
    return schema;
  }
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Schema;
  }
  throw new AutomationStoreVerificationError(
    "json-schema verification requires schema to be an object or boolean.",
  );
};

const formatSchemaErrors = (errors: Array<{ instanceLocation: string; error: string }>) =>
  errors.map((error) => `${error.instanceLocation}: ${error.error}`).join(", ");

export const validateAutomationStoreVerification = ({
  value,
  verification,
}: {
  value: string;
  verification?: readonly AutomationStoreVerification[];
}) => {
  if (!verification?.length) {
    return;
  }

  for (const item of verification) {
    if (item.type !== "json-schema") {
      continue;
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch (cause) {
      throw new AutomationStoreVerificationError(
        `Store value must be valid JSON for json-schema verification: ${cause instanceof Error ? cause.message : "invalid JSON"}`,
      );
    }

    let validator: Validator;
    try {
      validator = new Validator(asValidatorSchema(item.schema), "2020-12", false);
    } catch (cause) {
      throw new AutomationStoreVerificationError(
        `Invalid store json-schema verification schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const result = validator.validate(parsedValue);
    if (!result.valid) {
      throw new AutomationStoreVerificationError(
        `Store value failed json-schema verification: ${formatSchemaErrors(result.errors)}`,
      );
    }
  }
};

export const hasSystemCategory = (entry: Pick<AutomationStoreEntry, "category">) =>
  entry.category.includes("system");
