import { z } from "zod";

import { VisibilityConditionSchema } from "@json-render/core";

const MAX_GENERATED_PROP_CONDITIONAL_DEPTH = 8;
const generatedPropsSchemaCache = new WeakMap<z.ZodObject, z.ZodType>();

function createGeneratedObjectSchema(
  literalSchema: z.ZodObject,
  conditionalDepth: number,
  discriminator?: string,
): z.ZodObject {
  const generatedShape = Object.fromEntries(
    (Object.entries(literalSchema.shape) as Array<[string, z.ZodType]>).map(
      ([name, propertySchema]) => [
        name,
        name === discriminator
          ? propertySchema
          : createGeneratedPropSchema(propertySchema, conditionalDepth),
      ],
    ),
  );
  return literalSchema.clone({ ...literalSchema.def, shape: generatedShape });
}

function createGeneratedLiteralSchema(
  literalSchema: z.ZodType,
  conditionalDepth: number,
): z.ZodType {
  if (literalSchema instanceof z.ZodDiscriminatedUnion) {
    return literalSchema.clone({
      ...literalSchema.def,
      options: literalSchema.options.map((option) =>
        createGeneratedObjectSchema(
          option as z.ZodObject,
          conditionalDepth,
          literalSchema.def.discriminator,
        ),
      ),
    });
  }

  if (literalSchema instanceof z.ZodObject) {
    return createGeneratedObjectSchema(literalSchema, conditionalDepth);
  }

  if (literalSchema instanceof z.ZodArray) {
    return literalSchema.clone({
      ...literalSchema.def,
      element: createGeneratedPropSchema(literalSchema.element as z.ZodType, conditionalDepth),
    });
  }

  if (literalSchema instanceof z.ZodRecord) {
    return literalSchema.clone({
      ...literalSchema.def,
      valueType: createGeneratedPropSchema(literalSchema.valueType as z.ZodType, conditionalDepth),
    });
  }

  if (literalSchema instanceof z.ZodOptional) {
    return literalSchema.clone({
      ...literalSchema.def,
      innerType: createGeneratedPropSchema(literalSchema.unwrap() as z.ZodType, conditionalDepth),
    });
  }

  if (literalSchema instanceof z.ZodUnion) {
    return literalSchema.clone({
      ...literalSchema.def,
      options: literalSchema.options.map((option) =>
        createGeneratedLiteralSchema(option as z.ZodType, conditionalDepth),
      ),
    });
  }

  return literalSchema;
}

function createGeneratedPropSchema(literalSchema: z.ZodType, conditionalDepth = 0): z.ZodType {
  const nestedGeneratedPropSchema =
    conditionalDepth < MAX_GENERATED_PROP_CONDITIONAL_DEPTH
      ? createGeneratedPropSchema(literalSchema, conditionalDepth + 1)
      : z.never();

  return z.union([
    createGeneratedLiteralSchema(literalSchema, conditionalDepth),
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
