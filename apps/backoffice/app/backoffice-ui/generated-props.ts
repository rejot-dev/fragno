import { z } from "zod";

import { VisibilityConditionSchema } from "@json-render/core";

const MAX_GENERATED_PROP_CONDITIONAL_DEPTH = 8;
const generatedPropsSchemaCache = new WeakMap<z.ZodObject, z.ZodType>();

function createGeneratedPropSchema(literalSchema: z.ZodType, conditionalDepth = 0): z.ZodType {
  const nestedGeneratedPropSchema =
    conditionalDepth < MAX_GENERATED_PROP_CONDITIONAL_DEPTH
      ? createGeneratedPropSchema(literalSchema, conditionalDepth + 1)
      : z.never();

  return z.union([
    literalSchema,
    z.strictObject({ $state: z.string() }),
    z.strictObject({ $bindState: z.string() }),
    z.strictObject({ $item: z.string() }),
    z.strictObject({ $bindItem: z.string() }),
    z.strictObject({ $index: z.literal(true) }),
    z.strictObject({ $template: z.string() }),
    z.strictObject({
      $cond: VisibilityConditionSchema,
      $then: nestedGeneratedPropSchema,
      $else: nestedGeneratedPropSchema,
    }),
  ]);
}

function generatedPropsSchema(literalPropsSchema: z.ZodObject) {
  const cachedSchema = generatedPropsSchemaCache.get(literalPropsSchema);
  if (cachedSchema) {
    return cachedSchema;
  }

  const generatedShape = Object.fromEntries(
    (Object.entries(literalPropsSchema.shape) as Array<[string, z.ZodType]>).map(
      ([name, literalSchema]) => [name, createGeneratedPropSchema(literalSchema)],
    ),
  );
  const schema = z.strictObject(generatedShape);
  generatedPropsSchemaCache.set(literalPropsSchema, schema);
  return schema;
}

export function validateGeneratedProps(literalPropsSchema: z.ZodObject, value: unknown) {
  return generatedPropsSchema(literalPropsSchema).safeParse(value).success;
}
