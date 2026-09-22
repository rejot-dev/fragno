import { backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import {
  jsonSchemaToTypeScript,
  type JsonSchemaObject,
  zodSchemaToJsonSchema,
} from "@/lib/zod/zod-formatter";

const backofficeUiCatalogReferenceIntroduction = `# Production Component Catalog

This reference is generated from the definitions used by runtime validation and rendering. Props are
strict: use only the fields shown by each props type and satisfy every listed limit.`;

type ConstrainedJsonSchema = JsonSchemaObject & {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function describeRange(minimum: number | undefined, maximum: number | undefined, unit: string) {
  if (minimum !== undefined && maximum !== undefined) {
    return `${minimum}-${maximum} ${unit}`;
  }
  if (minimum !== undefined) {
    return `at least ${minimum} ${unit}`;
  }
  if (maximum !== undefined) {
    return `at most ${maximum} ${unit}`;
  }
  return undefined;
}

function collectSchemaLimits(schema: JsonSchemaObject, path: string): string[] {
  const constrainedSchema = schema as ConstrainedJsonSchema;
  const limits = [
    describeRange(constrainedSchema.minLength, constrainedSchema.maxLength, "characters"),
    describeRange(constrainedSchema.minimum, constrainedSchema.maximum, "numeric value"),
    describeRange(constrainedSchema.minItems, constrainedSchema.maxItems, "items"),
  ].filter((limit): limit is string => Boolean(limit));
  const lines = limits.length > 0 ? [`${path}: ${limits.join(", ")}`] : [];

  for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
    lines.push(...collectSchemaLimits(propertySchema, `${path}.${propertyName}`));
  }

  if (schema.items && !Array.isArray(schema.items)) {
    lines.push(...collectSchemaLimits(schema.items, `${path}[]`));
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    lines.push(...collectSchemaLimits(schema.additionalProperties, `${path}.*`));
  }

  return lines;
}

function renderComponentReference() {
  return Object.entries(backofficeUiComponentDefinitions)
    .map(([name, definition]) => {
      const propsSchema = zodSchemaToJsonSchema(definition.props, "input");
      if (!propsSchema) {
        throw new Error(`Expected ${name} to define a props schema.`);
      }

      const propsType = jsonSchemaToTypeScript(propsSchema);
      const propLimits = Object.entries(propsSchema.properties ?? {}).flatMap(
        ([propertyName, propertySchema]) => collectSchemaLimits(propertySchema, propertyName),
      );
      const limitsReference = propLimits.length
        ? `\n\nLimits:\n${propLimits.map((limit) => `- ${limit}`).join("\n")}`
        : "";
      const children = (definition.slots as readonly string[]).includes("default")
        ? "May contain child element ids."
        : "Must use an empty children array.";

      return `### \`${name}\`

${definition.description}

Props type:

\`\`\`ts
${propsType}
\`\`\`${limitsReference}

Children: ${children}

Example props:

\`\`\`json
${JSON.stringify(definition.example, null, 2)}
\`\`\``;
    })
    .join("\n\n");
}

export function generateBackofficeUiCatalogReferenceMarkdown() {
  return `${backofficeUiCatalogReferenceIntroduction}\n\n${renderComponentReference()}\n`;
}
