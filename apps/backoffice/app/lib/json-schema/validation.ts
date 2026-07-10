import { z } from "zod";

const jsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonSchemaValueSchema: z.ZodType = z.lazy(() =>
  z.union([z.boolean(), jsonSchema202012ValidationSchema]),
);

export const jsonSchema202012ValidationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      $schema: z.literal("https://json-schema.org/draft/2020-12/schema").optional(),
      $id: z.string().optional(),
      $anchor: z.string().optional(),
      $ref: z.string().optional(),
      $dynamicRef: z.string().optional(),
      $dynamicAnchor: z.string().optional(),
      $vocabulary: z.record(z.string(), z.boolean()).optional(),
      $comment: z.string().optional(),
      $defs: z
        .record(
          z.string(),
          z.lazy(() => jsonSchema202012ValidationSchema),
        )
        .optional(),
      type: z
        .union([
          z.enum(["object", "array", "string", "number", "boolean", "null", "integer"]),
          z.array(z.enum(["object", "array", "string", "number", "boolean", "null", "integer"])),
        ])
        .optional(),
      additionalItems: jsonSchemaValueSchema.optional(),
      unevaluatedItems: jsonSchemaValueSchema.optional(),
      prefixItems: z.array(jsonSchemaValueSchema).optional(),
      items: z.union([jsonSchemaValueSchema, z.array(jsonSchemaValueSchema)]).optional(),
      contains: jsonSchemaValueSchema.optional(),
      additionalProperties: jsonSchemaValueSchema.optional(),
      unevaluatedProperties: jsonSchemaValueSchema.optional(),
      properties: z.record(z.string(), jsonSchemaValueSchema).optional(),
      patternProperties: z.record(z.string(), jsonSchemaValueSchema).optional(),
      dependentSchemas: z.record(z.string(), jsonSchemaValueSchema).optional(),
      propertyNames: jsonSchemaValueSchema.optional(),
      if: jsonSchemaValueSchema.optional(),
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword.
      then: jsonSchemaValueSchema.optional(),
      else: jsonSchemaValueSchema.optional(),
      allOf: z.array(z.lazy(() => jsonSchema202012ValidationSchema)).optional(),
      anyOf: z.array(z.lazy(() => jsonSchema202012ValidationSchema)).optional(),
      oneOf: z.array(z.lazy(() => jsonSchema202012ValidationSchema)).optional(),
      not: jsonSchemaValueSchema.optional(),
      multipleOf: z.number().optional(),
      maximum: z.number().optional(),
      exclusiveMaximum: z.union([z.number(), z.boolean()]).optional(),
      minimum: z.number().optional(),
      exclusiveMinimum: z.union([z.number(), z.boolean()]).optional(),
      maxLength: z.number().optional(),
      minLength: z.number().optional(),
      pattern: z.string().optional(),
      maxItems: z.number().optional(),
      minItems: z.number().optional(),
      uniqueItems: z.boolean().optional(),
      maxContains: z.number().optional(),
      minContains: z.number().optional(),
      maxProperties: z.number().optional(),
      minProperties: z.number().optional(),
      required: z.array(z.string()).optional(),
      dependentRequired: z.record(z.string(), z.array(z.string())).optional(),
      enum: z.array(jsonValueSchema).optional(),
      const: jsonValueSchema.optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      default: z.unknown().optional(),
      deprecated: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      writeOnly: z.boolean().optional(),
      nullable: z.boolean().optional(),
      examples: z.array(z.unknown()).optional(),
      format: z.string().optional(),
      contentMediaType: z.string().optional(),
      contentEncoding: z.string().optional(),
      contentSchema: z.lazy(() => jsonSchema202012ValidationSchema).optional(),
      _prefault: z.unknown().optional(),
    })
    .catchall(z.unknown()),
);
