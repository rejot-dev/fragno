import { z } from "zod";

export type JsonSchemaObject = {
  id?: string;
  title?: string;
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
  $defs?: Record<string, JsonSchemaObject>;
  definitions?: Record<string, JsonSchemaObject>;
  codemodeType?: string;
};

export type JsonSchemaTypeScriptRender = {
  declarations: string[];
  type: string;
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
      const metadata = (zodSchema as unknown as z.ZodType).meta?.();
      if (io === "input" && typeof metadata?.codemodeInputId === "string") {
        jsonSchema.id = metadata.codemodeInputId;
      }
      if (typeof metadata?.codemodeType === "string") {
        jsonSchema.codemodeType = metadata.codemodeType;
      }
      const zodType = (zodSchema as unknown as z.ZodType)._zod.def.type;
      if (zodType === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      }
      if (zodType === "void") {
        jsonSchema.codemodeType = "void";
      }
      delete jsonSchema["~standard"];
      delete jsonSchema.codemodeInputId;
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
    case "bigint":
    case "function":
    case "object":
    case "symbol":
    case "undefined":
      return "unknown";
  }

  return "unknown";
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

type JsonSchemaTypeScriptContext = {
  rootSchema: JsonSchemaObject;
  rootTypeName?: string;
  referencedDeclarationRefs: Set<string>;
  typeNamesByRef: Map<string, string>;
  usedTypeNames: Set<string>;
  /** JSDoc type expressions cannot contain comments, so typedefs render none. */
  propertyComments: boolean;
  /** Typedefs share one module scope, so each schema prefixes the declarations it introduces. */
  declarationPrefix: string;
};

const TYPE_NAME_RESERVED_WORDS = new Set([
  "any",
  "boolean",
  "false",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "true",
  "unknown",
  "void",
]);

const decodeJsonPointerSegment = (value: string) =>
  decodeURIComponent(value).replace(/~1/g, "/").replace(/~0/g, "~");

const jsonPointerSegments = (ref: string) => ref.slice(2).split("/").map(decodeJsonPointerSegment);

const pascalCase = (value: string) =>
  value
    .split(/[^a-zA-Z0-9]+|(?=[A-Z])/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");

const sanitizeTypeName = (value: string, fallback = "Schema") => {
  const candidate = /^[A-Za-z_$][\w$]*$/u.test(value) ? value : pascalCase(value);
  const withFallback = candidate || fallback;
  const prefixed = /^[A-Za-z_$]/u.test(withFallback) ? withFallback : `${fallback}${withFallback}`;
  return TYPE_NAME_RESERVED_WORDS.has(prefixed) ? `${fallback}${prefixed}` : prefixed;
};

const fallbackTypeNameForRef = (ref: string, rootTypeName?: string) => {
  const lastSegment = jsonPointerSegments(ref).at(-1) ?? "Schema";
  const generatedSchemaMatch = /^__schema(\d+)$/u.exec(lastSegment);
  if (generatedSchemaMatch) {
    return `${rootTypeName ? sanitizeTypeName(rootTypeName, "Root") : ""}Schema${generatedSchemaMatch[1]}`;
  }
  return sanitizeTypeName(lastSegment);
};

const resolveLocalRef = (
  rootSchema: JsonSchemaObject,
  ref: string,
): JsonSchemaObject | undefined => {
  if (ref === "#") {
    return rootSchema;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }

  let current: unknown = rootSchema;
  for (const segment of jsonPointerSegments(ref)) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current && typeof current === "object" ? (current as JsonSchemaObject) : undefined;
};

const isDeclarationRef = (ref: string) => {
  const [firstSegment] = jsonPointerSegments(ref);
  return firstSegment === "$defs" || firstSegment === "definitions";
};

const typeNameForRef = (
  ref: string,
  schema: JsonSchemaObject,
  context: JsonSchemaTypeScriptContext,
) => {
  const existing = context.typeNamesByRef.get(ref);
  if (existing) {
    return existing;
  }

  const baseName = context.declarationPrefix
    ? `${context.declarationPrefix}${pascalCase(
        typeof schema.id === "string" && schema.id.trim()
          ? schema.id.trim()
          : (jsonPointerSegments(ref).at(-1) ?? "Schema"),
      )}`
    : sanitizeTypeName(
        typeof schema.id === "string" && schema.id.trim()
          ? schema.id.trim()
          : fallbackTypeNameForRef(ref, context.rootTypeName),
      );
  let typeName = baseName;
  let suffix = 2;
  while (context.usedTypeNames.has(typeName)) {
    typeName = `${baseName}${suffix}`;
    suffix += 1;
  }

  context.usedTypeNames.add(typeName);
  context.typeNamesByRef.set(ref, typeName);
  return typeName;
};

const resolveRefType = (ref: string, context: JsonSchemaTypeScriptContext): string => {
  if (ref === "#") {
    if (context.rootSchema.$ref && context.rootSchema.$ref !== "#") {
      return resolveRefType(context.rootSchema.$ref, context);
    }
    if (typeof context.rootSchema.id === "string" && context.rootSchema.id.trim()) {
      return sanitizeTypeName(context.rootSchema.id.trim());
    }
    return context.rootTypeName ?? "unknown";
  }

  const referencedSchema = resolveLocalRef(context.rootSchema, ref);
  if (!referencedSchema || !isDeclarationRef(ref)) {
    return "unknown";
  }

  const typeName = typeNameForRef(ref, referencedSchema, context);
  context.referencedDeclarationRefs.add(ref);
  return typeName;
};

/** Nested unions without constraints of their own, such as a union of discriminated unions. */
function flattenUnionMembers(members: JsonSchemaObject[]): JsonSchemaObject[] {
  return members.flatMap((member) => {
    const { oneOf, anyOf, ...constraints } = member;
    const nested = oneOf ?? anyOf;
    return nested && !(oneOf && anyOf) && Object.keys(constraints).length === 0
      ? flattenUnionMembers(nested)
      : [member];
  });
}

function literalValues(schema: JsonSchemaObject): unknown[] | null {
  const { type: _type, const: constValue, enum: enumValues, ...constraints } = schema;
  if (Object.keys(constraints).length > 0) {
    return null;
  }
  return constValue === undefined ? (enumValues ?? null) : [constValue];
}

/** Joins the object variants that differ only in the literal value of `key`. */
function mergeVariantsOn(members: JsonSchemaObject[], key: string): JsonSchemaObject[] {
  const variants: { schema: JsonSchemaObject; values: unknown[]; merged: boolean }[] = [];
  const variantsByRest = new Map<string, (typeof variants)[number]>();
  for (const schema of members) {
    const property = schema.type === "object" && !schema.id ? schema.properties?.[key] : undefined;
    const values = property ? literalValues(property) : null;
    if (!values) {
      variants.push({ schema, values: [], merged: false });
      continue;
    }
    const { [key]: _merged, ...rest } = schema.properties ?? {};
    const identity = JSON.stringify({ ...schema, properties: rest });
    const variant = variantsByRest.get(identity);
    if (variant) {
      variant.values.push(...values);
      variant.merged = true;
    } else {
      const created = { schema, values: [...values], merged: false };
      variantsByRest.set(identity, created);
      variants.push(created);
    }
  }
  return variants.map(({ schema, values, merged }) =>
    merged
      ? { ...schema, properties: { ...schema.properties, [key]: { enum: [...new Set(values)] } } }
      : schema,
  );
}

// Writes `{ namespace: "store"; permission: "read" | "modify" }` instead of one variant per
// permission; the merged union accepts the same values. It merges on one property, the last that
// merges any: leading properties usually name the variant, as `namespace` does here.
function mergeLiteralVariants(members: JsonSchemaObject[]): JsonSchemaObject[] {
  const keys = [...new Set(members.flatMap((member) => Object.keys(member.properties ?? {})))];
  for (const key of keys.reverse()) {
    const merged = mergeVariantsOn(members, key);
    if (merged.length < members.length) {
      return merged;
    }
  }
  return members;
}

const renderJsonSchemaType = (
  schema: JsonSchemaObject | undefined,
  depth: number,
  context: JsonSchemaTypeScriptContext,
): string => {
  if (!schema || Object.keys(schema).length === 0) {
    return "unknown";
  }

  // An explicit shared type also overrides references emitted for recursive Zod schemas.
  if (schema.codemodeType?.trim()) {
    return schema.codemodeType.trim();
  }

  if (schema.$ref) {
    return resolveRefType(schema.$ref, context);
  }

  if (schema.const !== undefined) {
    return literalToType(schema.const);
  }

  if (schema.enum) {
    return renderUnion(schema.enum.map(literalToType));
  }

  const unionMembers = schema.oneOf?.length ? schema.oneOf : schema.anyOf;
  if (unionMembers?.length) {
    return renderUnion(
      mergeLiteralVariants(flattenUnionMembers(unionMembers)).map((entry) =>
        renderJsonSchemaType(entry, depth, context),
      ),
    );
  }

  if (schema.allOf?.length) {
    return schema.allOf.map((entry) => renderJsonSchemaType(entry, depth, context)).join(" & ");
  }

  if (Array.isArray(schema.type)) {
    return renderUnion(
      schema.type.map((type) => renderJsonSchemaType({ ...schema, type }, depth, context)),
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
        return `[${schema.items.map((item) => renderJsonSchemaType(item, depth, context)).join(", ")}]`;
      }
      const itemType = renderJsonSchemaType(schema.items, depth, context);
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
          depth: 0,
          context,
        }),
      );

      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        propertyLines.push(
          `[key: string]: ${renderJsonSchemaType(schema.additionalProperties, 0, context)};`,
        );
      } else if (schema.additionalProperties === true) {
        propertyLines.push("[key: string]: unknown;");
      }

      if (!propertyLines.length) {
        return "Record<string, unknown>";
      }

      return `{\n${indent(propertyLines.join("\n"))}\n}`;
    }
    case undefined:
      return "unknown";
  }

  return "unknown";
};

const renderProperty = ({
  name,
  schema,
  required,
  depth,
  context,
}: {
  name: string;
  schema: JsonSchemaObject;
  required: boolean;
  depth: number;
  context: JsonSchemaTypeScriptContext;
}) => {
  const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  const property = `${key}${required ? "" : "?"}: ${renderJsonSchemaType(schema, depth, context)};`;
  const jsDoc = context.propertyComments ? schemaJSDoc(schema) : undefined;
  return jsDoc ? `${renderSchemaJSDoc(jsDoc)}\n${property}` : property;
};

const createRenderContext = (
  schema: JsonSchemaObject,
  rootTypeName?: string,
): JsonSchemaTypeScriptContext => ({
  rootSchema: schema,
  rootTypeName,
  referencedDeclarationRefs: new Set(),
  typeNamesByRef: new Map(),
  usedTypeNames: new Set(rootTypeName ? [rootTypeName] : []),
  propertyComments: true,
  declarationPrefix: "",
});

const renderReferencedDeclarations = (context: JsonSchemaTypeScriptContext) => {
  const declarations: { name: string; type: string }[] = [];
  const renderedRefs = new Set<string>();
  const pendingRefs = [...context.referencedDeclarationRefs];

  for (let index = 0; index < pendingRefs.length; index += 1) {
    const ref = pendingRefs[index];
    if (renderedRefs.has(ref)) {
      continue;
    }

    const schema = resolveLocalRef(context.rootSchema, ref);
    if (!schema) {
      continue;
    }

    renderedRefs.add(ref);
    const typeName = typeNameForRef(ref, schema, context);
    const type = renderJsonSchemaType(schema, 0, context);
    declarations.push({ name: typeName, type });

    for (const discoveredRef of context.referencedDeclarationRefs) {
      if (!renderedRefs.has(discoveredRef) && !pendingRefs.includes(discoveredRef)) {
        pendingRefs.push(discoveredRef);
      }
    }
  }

  return declarations;
};

export const jsonSchemaToTypeScriptRender = (
  schema: JsonSchemaObject | undefined,
  options: { rootTypeName?: string } = {},
): JsonSchemaTypeScriptRender => {
  if (!schema || Object.keys(schema).length === 0) {
    return { declarations: [], type: "unknown" };
  }

  const context = createRenderContext(schema, options.rootTypeName);
  const rootSchemaTypeName =
    options.rootTypeName && typeof schema.id === "string" && schema.id.trim()
      ? sanitizeTypeName(schema.id.trim())
      : undefined;

  if (rootSchemaTypeName && rootSchemaTypeName !== options.rootTypeName) {
    context.usedTypeNames.add(rootSchemaTypeName);
    const rootType = renderJsonSchemaType(schema, 0, context);
    return {
      declarations: [
        ...renderReferencedDeclarations(context).map(renderTypeAlias),
        `type ${rootSchemaTypeName} = ${rootType};`,
      ],
      type: rootSchemaTypeName,
    };
  }

  const type = renderJsonSchemaType(schema, 0, context);
  return { declarations: renderReferencedDeclarations(context).map(renderTypeAlias), type };
};

const renderTypeAlias = ({ name, type }: { name: string; type: string }) =>
  `type ${name} = ${type};`;

const renderJSDocBlock = (lines: string[]) => {
  // Schema text is untrusted for comment syntax; an embedded terminator would end the block.
  const body = lines.join("\n").replaceAll("*/", "*\\/").split("\n");
  return body.length === 1
    ? `/** ${body[0]} */`
    : ["/**", ...body.map((line) => ` * ${line}`), " */"].join("\n");
};

/**
 * Renders a JSON Schema as JSDoc typedefs for checked JavaScript. A root object keeps its fields'
 * descriptions as `@property` tags; nested descriptions have no JSDoc syntax and are dropped.
 */
export const jsonSchemaToJSDocTypedefs = (schema: JsonSchemaObject, typeName: string): string[] => {
  // The caller names the root; a schema id would rename it out from under that name.
  const { id: _id, ...root } = schema;
  const context: JsonSchemaTypeScriptContext = {
    ...createRenderContext(root, typeName),
    propertyComments: false,
    declarationPrefix: typeName,
  };
  const properties = Object.entries(root.properties ?? {});
  const documentsFields =
    root.type === "object" &&
    !root.$ref &&
    !root.anyOf &&
    !root.oneOf &&
    !root.allOf &&
    root.additionalProperties !== true &&
    typeof root.additionalProperties !== "object" &&
    properties.length > 0 &&
    properties.every(([name]) => /^[A-Za-z_$][\w$]*$/u.test(name));
  const description = root.description?.trim() ? [root.description.trim()] : [];
  let rootTypedef: string;
  if (documentsFields) {
    const required = new Set(root.required ?? []);
    rootTypedef = renderJSDocBlock([
      ...description,
      `@typedef {Object} ${typeName}`,
      ...properties.map(([name, property]) => {
        const fieldDescription = schemaJSDoc(property);
        return `@property {${renderJsonSchemaType(property, 0, context)}} ${required.has(name) ? name : `[${name}]`}${fieldDescription ? ` ${fieldDescription}` : ""}`;
      }),
    ]);
  } else {
    rootTypedef = renderJSDocBlock([
      ...description,
      `@typedef {${renderJsonSchemaType(root, 0, context)}} ${typeName}`,
    ]);
  }
  return [
    ...renderReferencedDeclarations(context).map(({ name, type }) =>
      renderJSDocBlock([`@typedef {${type}} ${name}`]),
    ),
    rootTypedef,
  ];
};

export const jsonSchemaToTypeScript = (schema: JsonSchemaObject | undefined, depth = 0): string => {
  if (!schema || Object.keys(schema).length === 0) {
    return "unknown";
  }

  const context = createRenderContext(schema);
  return renderJsonSchemaType(schema, depth, context);
};

export const zodSchemaToTypeScriptRender = (
  schema: z.ZodType,
  io: "input" | "output",
  options: { rootTypeName?: string } = {},
): JsonSchemaTypeScriptRender =>
  jsonSchemaToTypeScriptRender(zodSchemaToJsonSchema(schema, io), options);

export const zodSchemaToTypeScript = (schema: z.ZodType, io: "input" | "output") =>
  zodSchemaToTypeScriptRender(schema, io).type;

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
  if (schema.$ref) {
    return schema.$ref.split("/").at(-1) ?? "unknown";
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
