import { z } from "zod";

const renderedPropsSchemas = new WeakMap<z.ZodType, z.ZodType>();

/**
 * The props schema a component checks as it renders. Bound props arrive from state, which no
 * one validated, so their shape is checked here; size maxima bound only what a spec may carry,
 * so they are lifted, and components show the first items of longer live data.
 */
export function renderedPropsSchema(literal: z.ZodType): z.ZodType {
  const cached = renderedPropsSchemas.get(literal);
  if (cached) {
    return cached;
  }
  const schema = withoutMaxima(literal);
  renderedPropsSchemas.set(literal, schema);
  return schema;
}

function withoutMaxima(schema: z.ZodType): z.ZodType {
  const def = schema.def as z.core.$ZodTypeDef & { checks?: z.core.$ZodCheck[] };
  const checks = def.checks?.filter((check) => check._zod.def.check !== "max_length");
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, property]) => [
        name,
        withoutMaxima(property),
      ]),
    );
    return schema.clone({ ...schema.def, shape, checks });
  }
  if (schema instanceof z.ZodArray) {
    return schema.clone({
      ...schema.def,
      element: withoutMaxima(schema.element as z.ZodType),
      checks,
    });
  }
  if (schema instanceof z.ZodRecord) {
    return schema.clone({
      ...schema.def,
      valueType: withoutMaxima(schema.valueType as z.ZodType),
      checks,
    });
  }
  if (schema instanceof z.ZodOptional) {
    return schema.clone({ ...schema.def, innerType: withoutMaxima(schema.unwrap() as z.ZodType) });
  }
  if (schema instanceof z.ZodNullable) {
    return schema.clone({ ...schema.def, innerType: withoutMaxima(schema.unwrap() as z.ZodType) });
  }
  if (schema instanceof z.ZodUnion) {
    return schema.clone({
      ...schema.def,
      options: schema.options.map((option) => withoutMaxima(option as z.ZodType)),
    });
  }
  return checks ? schema.clone({ ...def, checks } as typeof schema.def) : schema;
}
