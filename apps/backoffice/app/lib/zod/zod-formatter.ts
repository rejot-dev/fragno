import { z } from "zod";

export type JsonSchemaObject = {
  type?: string | string[];
  description?: string;
  format?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  const?: unknown;
  enum?: unknown[];
  $ref?: string;
};

export const zodSchemaToJsonSchema = (
  schema: z.ZodType | undefined,
  io: "input" | "output" = "output",
) => {
  if (!schema) {
    return undefined;
  }

  return z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    reused: "inline",
    override: ({ zodSchema, jsonSchema }) => {
      if ((zodSchema as unknown as z.ZodType)._zod.def.type === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      }
      delete jsonSchema["~standard"];
    },
  }) as JsonSchemaObject;
};

const literalToType = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    default:
      return "unknown";
  }
};

const renderUnion = (items: string[]) => {
  const unique = [...new Set(items)];
  return unique.length ? unique.join(" | ") : "unknown";
};

const indent = (value: string, spaces = 2) =>
  value
    .split("\n")
    .map((line) => `${" ".repeat(spaces)}${line}`)
    .join("\n");

const schemaJSDoc = (schema: JsonSchemaObject) => {
  if (schema.description?.trim()) {
    return schema.description.trim();
  }
  if (schema.type === "string" && schema.format === "date-time") {
    return "ISO 8601 datetime string.";
  }
  return undefined;
};

const renderSchemaJSDoc = (description: string) => {
  const lines = description.split("\n").filter(Boolean);
  if (lines.length === 1) {
    return `/** ${lines[0]} */`;
  }
  return ["/**", ...lines.map((line) => ` * ${line}`), " */"].join("\n");
};

const renderProperty = ({
  name,
  schema,
  required,
  depth,
}: {
  name: string;
  schema: JsonSchemaObject;
  required: boolean;
  depth: number;
}) => {
  const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  const property = `${key}${required ? "" : "?"}: ${jsonSchemaToTypeScript(schema, depth)};`;
  const jsDoc = schemaJSDoc(schema);
  return jsDoc ? `${renderSchemaJSDoc(jsDoc)}\n${property}` : property;
};

export const jsonSchemaToTypeScript = (schema: JsonSchemaObject | undefined, depth = 0): string => {
  if (!schema || Object.keys(schema).length === 0 || schema.$ref) {
    return "unknown";
  }

  if (schema.const !== undefined) {
    return literalToType(schema.const);
  }

  if (schema.enum) {
    return renderUnion(schema.enum.map(literalToType));
  }

  if (schema.oneOf?.length) {
    return renderUnion(schema.oneOf.map((entry) => jsonSchemaToTypeScript(entry, depth)));
  }

  if (schema.anyOf?.length) {
    return renderUnion(schema.anyOf.map((entry) => jsonSchemaToTypeScript(entry, depth)));
  }

  if (schema.allOf?.length) {
    return schema.allOf.map((entry) => jsonSchemaToTypeScript(entry, depth)).join(" & ");
  }

  if (Array.isArray(schema.type)) {
    return renderUnion(
      schema.type.map((type) => jsonSchemaToTypeScript({ ...schema, type }, depth)),
    );
  }

  switch (schema.type) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "array": {
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map((item) => jsonSchemaToTypeScript(item, depth)).join(", ")}]`;
      }
      const itemType = jsonSchemaToTypeScript(schema.items, depth);
      return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
    }
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const propertyLines = Object.entries(properties).map(([name, propertySchema]) =>
        renderProperty({
          name,
          schema: propertySchema,
          required: required.has(name),
          depth: depth + 1,
        }),
      );

      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        propertyLines.push(
          `[key: string]: ${jsonSchemaToTypeScript(schema.additionalProperties, depth + 1)};`,
        );
      } else if (schema.additionalProperties === true) {
        propertyLines.push("[key: string]: unknown;");
      }

      if (!propertyLines.length) {
        return "Record<string, unknown>";
      }

      return `{\n${indent(propertyLines.join("\n"), (depth + 1) * 2)}\n${" ".repeat(depth * 2)}}`;
    }
    default:
      return "unknown";
  }
};

export const zodSchemaToTypeScript = (schema: z.ZodType, io: "input" | "output") => {
  try {
    return jsonSchemaToTypeScript(zodSchemaToJsonSchema(schema, io));
  } catch {
    return "unknown";
  }
};

const renderFieldLiteral = (value: unknown) => {
  if (value === null) {
    return "null";
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
};

const renderFieldType = (schema: JsonSchemaObject | undefined): string => {
  if (!schema || Object.keys(schema).length === 0) {
    return "unknown";
  }
  if (schema.const !== undefined) {
    return renderFieldLiteral(schema.const);
  }
  if (schema.enum) {
    return schema.enum.map(renderFieldLiteral).join(" | ");
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (union?.length) {
    return union.map(renderFieldType).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }
  if (schema.type === "array") {
    const itemType = Array.isArray(schema.items) ? "tuple" : renderFieldType(schema.items);
    return itemType === "unknown" ? "array" : `${itemType}[]`;
  }
  if (schema.type === "object") {
    return "object";
  }
  return schema.type ?? "unknown";
};

const isNullable = (schema: JsonSchemaObject): boolean => {
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) {
    return true;
  }
  const candidates = schema.anyOf ?? schema.oneOf;
  return candidates?.some((candidate) => isNullable(candidate)) ?? false;
};

const pad = (value: string, width: number) => value.padEnd(width, " ");

export const formatJsonSchemaFields = (schema: unknown) => {
  const objectSchema = schema as JsonSchemaObject | undefined;
  const properties = objectSchema?.properties ?? {};
  const entries = Object.entries(properties);
  if (!entries.length) {
    return "  -";
  }

  const required = new Set(objectSchema?.required ?? []);
  const nameWidth = Math.max(...entries.map(([name]) => name.length));
  const typeWidth = Math.max(...entries.map(([, property]) => renderFieldType(property).length));

  return entries
    .map(([name, property]) => {
      const type = renderFieldType(property);
      const notes = [
        required.has(name) ? "required" : undefined,
        isNullable(property) ? "nullable" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      return `  ${pad(name, nameWidth)}  ${notes ? pad(type, typeWidth) : type}${notes ? `  ${notes}` : ""}`;
    })
    .join("\n");
};
