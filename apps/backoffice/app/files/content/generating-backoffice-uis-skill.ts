import { backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import {
  jsonSchemaToTypeScript,
  type JsonSchemaObject,
  zodSchemaToJsonSchema,
} from "@/lib/zod/zod-formatter";

import type { FileContent } from "../interface";

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

export function renderComponentReference() {
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

const generatingBackofficeUisModules = import.meta.glob<string>(
  "../../../content/static/skills/generating-backoffice-uis/*.md",
  { eager: true, query: "?raw", import: "default" },
);

export const GENERATING_BACKOFFICE_UIS_SKILL_CONTENT = Object.fromEntries(
  Object.entries(generatingBackofficeUisModules).map(([path, content]) => {
    const staticPath = path.replace("../../../content/static/", "");
    const renderedContent = content.replace(
      "<!-- BACKOFFICE_UI_COMPONENT_REFERENCE -->",
      renderComponentReference(),
    );
    return [staticPath, renderedContent];
  }),
) satisfies Record<string, FileContent>;
