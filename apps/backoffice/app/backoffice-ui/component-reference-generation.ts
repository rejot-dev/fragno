import { backofficeUiBuilderComponents } from "@fragno-private/backoffice-ui/builder";
import { backofficeUiComponentDefinitions } from "@fragno-private/backoffice-ui/catalog";
import type { z } from "zod";

import {
  jsonSchemaToTypeScript,
  type JsonSchemaObject,
  zodSchemaToJsonSchema,
} from "@/lib/zod/zod-formatter";

type ConstrainedJsonSchema = JsonSchemaObject & {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function describeRange(minimum: number | undefined, maximum: number | undefined, unit: string) {
  const suffix = unit ? ` ${unit}` : "";
  if (minimum !== undefined && maximum !== undefined) {
    return `${minimum}-${maximum}${suffix}`;
  }
  if (minimum !== undefined) {
    return `at least ${minimum}${suffix}`;
  }
  if (maximum !== undefined) {
    return `at most ${maximum}${suffix}`;
  }
  return undefined;
}

function describeOwnLimits(schema: JsonSchemaObject) {
  const constrainedSchema = schema as ConstrainedJsonSchema;
  return [
    describeRange(constrainedSchema.minLength, constrainedSchema.maxLength, "characters"),
    describeRange(constrainedSchema.minimum, constrainedSchema.maximum, ""),
    describeRange(constrainedSchema.minItems, constrainedSchema.maxItems, "items"),
  ].filter((limit): limit is string => Boolean(limit));
}

/** Element and record-value limits have no property of their own to carry their JSDoc. */
function describePropertyLimits(schema: JsonSchemaObject, prefix = ""): string[] {
  const limits = describeOwnLimits(schema).map((limit) => `${prefix}${limit}`);
  if (schema.items && !Array.isArray(schema.items) && !schema.items.properties) {
    limits.push(...describePropertyLimits(schema.items, `${prefix}each item `));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const valuePrefix = prefix ? `${prefix.trimEnd()}'s values ` : "each value ";
    limits.push(...describePropertyLimits(schema.additionalProperties, valuePrefix));
  }
  return limits;
}

/** Copies the schema with each property's limits as its description, which renders as JSDoc. */
function withLimitDescriptions(schema: JsonSchemaObject): JsonSchemaObject {
  const annotated: JsonSchemaObject = { ...schema };
  if (schema.properties) {
    annotated.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, propertySchema]) => {
        const limits = describePropertyLimits(propertySchema).join("; ");
        const description = [propertySchema.description, limits].filter(Boolean).join(" ");
        const annotatedProperty = withLimitDescriptions(propertySchema);
        return [name, description ? { ...annotatedProperty, description } : annotatedProperty];
      }),
    );
  }
  if (schema.items && !Array.isArray(schema.items)) {
    annotated.items = withLimitDescriptions(schema.items);
  }
  if (schema.anyOf) {
    annotated.anyOf = schema.anyOf.map(withLimitDescriptions);
  }
  if (schema.oneOf) {
    annotated.oneOf = schema.oneOf.map(withLimitDescriptions);
  }
  return annotated;
}

function renderPropsType(propsSchema: z.ZodObject, depth: number) {
  const jsonSchema = zodSchemaToJsonSchema(propsSchema, "input");
  if (!jsonSchema) {
    throw new Error("Expected a props schema.");
  }
  return jsonSchemaToTypeScript(withLimitDescriptions(jsonSchema), depth);
}

/** Declares the ui.* function of every catalog component, with its canonical props, for ui.d.ts. */
export function generateBackofficeUiCatalogDeclarations() {
  const componentFunctions = backofficeUiBuilderComponents.map(
    ({ functionName, type, acceptsChildren }) => {
      const definition =
        backofficeUiComponentDefinitions[type as keyof typeof backofficeUiComponentDefinitions];
      const propsType = renderPropsType(definition.props, 1);
      const children = acceptsChildren
        ? ", children: BackofficeUiElement[] | BackofficeUiRepeat"
        : "";
      return `  /** Builds ${type}. ${definition.description} */
  ${functionName}(props: BackofficeUiProps<${propsType}>${children}): BackofficeUiElement;`;
    },
  );
  const submitPropsType = renderPropsType(
    backofficeUiComponentDefinitions.WorkflowEventButton.props.omit({
      eventType: true,
      payload: true,
    }),
    0,
  );

  return `// Generated from the component catalog; ui.d.ts declares the rest of the ui builder.

type BackofficeUiFormSubmitProps = ${submitPropsType};

type BackofficeUiComponents = {
${componentFunctions.join("\n")}
};
`;
}
