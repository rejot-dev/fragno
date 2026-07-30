import { z } from "zod";

import { VisibilityConditionSchema } from "@json-render/core";

const generatedPropsSchemaCache = new WeakMap<z.ZodObject, z.ZodType>();

function createGeneratedPropSchema(literalSchema: z.ZodType): z.ZodType {
  let generatedPropSchema: z.ZodType;
  generatedPropSchema = z.lazy(() =>
    z.union([
      literalSchema,
      z.strictObject({ $state: z.string() }),
      z.strictObject({ $bindState: z.string() }),
      z.strictObject({ $item: z.string() }),
      z.strictObject({ $bindItem: z.string() }),
      z.strictObject({ $index: z.literal(true) }),
      z.strictObject({ $template: z.string() }),
      z.strictObject({
        $cond: VisibilityConditionSchema,
        $then: generatedPropSchema,
        $else: generatedPropSchema,
      }),
    ]),
  );
  return generatedPropSchema;
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
