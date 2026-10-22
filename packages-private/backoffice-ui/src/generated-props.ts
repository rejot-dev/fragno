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
  // Built on first use: eager branches nest a full chain inside every nested field, so a
  // component's first parse grew exponentially with prop nesting.
  const nestedGeneratedPropSchema =
    conditionalDepth < MAX_GENERATED_PROP_CONDITIONAL_DEPTH
      ? z.lazy(() => createGeneratedPropSchema(literalSchema, conditionalDepth + 1))
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

/**
 * Explains rejected props for the author. Generated-schema issues are unions of every expression
 * form, so the literal schema names the actual mismatch; issues at expression values are skipped
 * because the literal schema cannot judge them.
 */
export function describeInvalidGeneratedProps(literalPropsSchema: z.ZodObject, value: unknown) {
  const literalResult = literalPropsSchema.safeParse(value);
  const problems = (literalResult.error?.issues ?? [])
    .filter((issue) => !isExpressionPath(value, issue.path))
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${describeIssue(issue)}` : describeIssue(issue);
    });
  return problems.length > 0
    ? problems.join("; ")
    : "a dynamic expression ($state, $bindState, $cond, ...) is malformed or misplaced";
}

function describeIssue(issue: z.core.$ZodIssue) {
  if (issue.code === "invalid_union") {
    const expectedValues = issue.errors.flatMap((branch) =>
      branch.length === 1 && branch[0]?.code === "invalid_value" ? branch[0].values : [],
    );
    if (expectedValues.length === issue.errors.length) {
      return `expected one of ${expectedValues.map((expected) => JSON.stringify(expected)).join("|")}`;
    }
  }
  return issue.message;
}

function isExpressionPath(value: unknown, path: readonly PropertyKey[]) {
  let current = value;
  for (const segment of path) {
    if (isExpression(current)) {
      return true;
    }
    if (current === null || typeof current !== "object") {
      return false;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return isExpression(current);
}

function isExpression(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith("$"))
  );
}
