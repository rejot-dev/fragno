import { z } from "zod";

import type { BackofficeApi } from "./api";
import {
  BACKOFFICE_API_ERROR_DESCRIPTIONS,
  BACKOFFICE_API_ERROR_STATUS,
  backofficeApiErrorSchema,
} from "./errors";

type JsonSchema = { [key: string]: unknown };
type SchemaIo = "input" | "output";

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string };
  servers: { url: string }[];
  security: { bearer: [] }[];
  paths: Record<string, { post: JsonSchema }>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: { bearer: JsonSchema };
  };
};

/** Scope ids are URI-encoded inside the segment, so `:` only separates components. */
const SCOPE_PARAMETER = {
  name: "scope",
  in: "path",
  required: true,
  description:
    "Where the operation runs: `system`, `user:<userId>`, `org:<orgId>`, or `project:<orgId>:<projectId>`. Operations that are not available to the credential in this scope answer `404`.",
  schema: {
    type: "string",
    pattern: "^(?:system|user:[^:/]+|org:[^:/]+|project:[^:/]+:[^:/]+)$",
  },
};

const DEFINITION_REF_PREFIX = "#/$defs/";

/**
 * Describes an API version as OpenAPI 3.1. Every operation is `POST
 * /api/<version>/scopes/{scope}/<operationId>` with its input as the JSON body. Void inputs take no
 * body and void outputs answer `204`; every error response carries `BackofficeApiError`.
 *
 * Schemas with a zod `.meta({ id })` become shared components. A schema whose request form differs
 * from its response form (defaults, transforms) gets a separate `<id>Input` component, but only
 * when both forms are used.
 */
export function createOpenApiDocument(
  api: BackofficeApi,
  { serverUrl }: { serverUrl: string },
): OpenApiDocument {
  const definitions: Record<SchemaIo, Map<string, JsonSchema>> = {
    input: new Map(),
    output: new Map(),
  };

  function convert(schema: z.ZodType, io: SchemaIo, conversionName: string): JsonSchema {
    const {
      $defs,
      $schema: _dialect,
      ...root
    } = z.toJSONSchema(schema, {
      io,
      target: "draft-2020-12",
      unrepresentable: "throw",
      // zod copies every `.meta()` field; Codemode's type-name hints are not JSON Schema.
      override: ({ jsonSchema }) => {
        delete jsonSchema["codemodeInputId"];
        delete jsonSchema["codemodeType"];
      },
    });
    const { root: localizedRoot, definitions: localizedDefinitions } = localizeAnonymousDefinitions(
      root,
      ($defs ?? {}) as Record<string, JsonSchema>,
      conversionName,
    );
    for (const [id, definition] of Object.entries(localizedDefinitions)) {
      const existing = definitions[io].get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new Error(`Two different schemas use the OpenAPI component id '${id}'.`);
      }
      definitions[io].set(id, definition);
    }
    return localizedRoot;
  }

  const operations = Object.entries(api.operations).map(([operationId, operation]) => ({
    operationId,
    operation,
    // A void input is an operation without a request body, not a JSON value.
    input:
      operation.input.def.type === "void"
        ? null
        : convert(operation.input, "input", `${operationId}.input`),
    // A void output is a response without a body.
    output:
      operation.output.def.type === "void"
        ? null
        : convert(operation.output, "output", `${operationId}.output`),
  }));
  const errorSchema = convert(backofficeApiErrorSchema, "output", "error");

  const inputFormDiffers = new Map<string, boolean>();
  function hasSeparateInputComponent(id: string): boolean {
    const known = inputFormDiffers.get(id);
    if (known !== undefined) {
      return known;
    }
    const input = definitions.input.get(id);
    const output = definitions.output.get(id);
    if (!input || !output) {
      return false;
    }
    // Assume equal while visiting so recursive schemas terminate.
    inputFormDiffers.set(id, false);
    const differs =
      JSON.stringify(input) !== JSON.stringify(output) ||
      referencedDefinitionIds(input).some(hasSeparateInputComponent);
    inputFormDiffers.set(id, differs);
    return differs;
  }

  function componentName(id: string, io: SchemaIo): string {
    return io === "input" && hasSeparateInputComponent(id) ? `${id}Input` : id;
  }

  function toComponentRefs(schema: JsonSchema, io: SchemaIo): JsonSchema {
    return JSON.parse(JSON.stringify(schema), (key, value: unknown) =>
      key === "$ref" && typeof value === "string" && value.startsWith(DEFINITION_REF_PREFIX)
        ? `#/components/schemas/${componentName(value.slice(DEFINITION_REF_PREFIX.length), io)}`
        : value,
    ) as JsonSchema;
  }

  const schemas: Record<string, JsonSchema> = {};
  for (const io of ["output", "input"] as const) {
    for (const [id, definition] of definitions[io]) {
      schemas[componentName(id, io)] = toComponentRefs(definition, io);
    }
  }

  const errorResponses = Object.fromEntries(
    Object.entries(BACKOFFICE_API_ERROR_STATUS).map(([code, status]) => [
      String(status),
      {
        description:
          BACKOFFICE_API_ERROR_DESCRIPTIONS[code as keyof typeof BACKOFFICE_API_ERROR_STATUS],
        content: { "application/json": { schema: toComponentRefs(errorSchema, "output") } },
      },
    ]),
  );

  const paths: OpenApiDocument["paths"] = {};
  for (const { operationId, operation, input, output } of operations) {
    paths[`/api/${api.version}/scopes/{scope}/${operationId}`] = {
      post: {
        operationId,
        description: operation.description,
        tags: [operationId.split(".")[0]],
        parameters: [SCOPE_PARAMETER],
        ...(input && {
          requestBody: {
            required: true,
            content: { "application/json": { schema: toComponentRefs(input, "input") } },
          },
        }),
        responses: {
          ...(output
            ? {
                "200": {
                  description: "The operation's result.",
                  content: { "application/json": { schema: toComponentRefs(output, "output") } },
                },
              }
            : { "204": { description: "The operation succeeded." } }),
          ...errorResponses,
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: { title: "Backoffice API", version: api.version },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    paths,
    components: {
      schemas,
      securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    },
  };
}

function referencedDefinitionIds(schema: JsonSchema): string[] {
  const ids: string[] = [];
  JSON.stringify(schema, (key, value: unknown) => {
    if (key === "$ref" && typeof value === "string" && value.startsWith(DEFINITION_REF_PREFIX)) {
      ids.push(value.slice(DEFINITION_REF_PREFIX.length));
    }
    return value;
  });
  return ids;
}

const ANONYMOUS_DEFINITION = /^__schema\d+$/;

/**
 * zod names definitions it cannot identify `__schema<n>`, separately in every conversion, and
 * represents a described or re-annotated copy of a recursive schema as an alias of one. Aliases
 * collapse into their named component; other anonymous definitions get a per-conversion name so
 * conversions cannot collide.
 */
function localizeAnonymousDefinitions(
  root: JsonSchema,
  definitions: Record<string, JsonSchema>,
  conversionName: string,
): { root: JsonSchema; definitions: Record<string, JsonSchema> } {
  const renames = new Map<string, string>();
  for (const [id, definition] of Object.entries(definitions)) {
    const target = aliasTarget(definition);
    if (!ANONYMOUS_DEFINITION.test(id) && target && ANONYMOUS_DEFINITION.test(target)) {
      renames.set(target, id);
    }
  }
  for (const id of Object.keys(definitions)) {
    if (ANONYMOUS_DEFINITION.test(id) && !renames.has(id)) {
      renames.set(id, `${conversionName}.${id.slice("__".length)}`);
    }
  }
  const rename = (schema: JsonSchema): JsonSchema =>
    JSON.parse(JSON.stringify(schema), (key, value: unknown) => {
      if (key !== "$ref" || typeof value !== "string" || !value.startsWith(DEFINITION_REF_PREFIX)) {
        return value;
      }
      const id = value.slice(DEFINITION_REF_PREFIX.length);
      return `${DEFINITION_REF_PREFIX}${renames.get(id) ?? id}`;
    }) as JsonSchema;

  const localized: Record<string, JsonSchema> = {};
  for (const [id, definition] of Object.entries(definitions)) {
    const target = aliasTarget(definition);
    // An alias's body is its anonymous target's, which is stored under the alias's name instead.
    if (target && renames.get(target) === id) {
      continue;
    }
    localized[renames.get(id) ?? id] = rename(definition);
  }
  return { root: rename(root), definitions: localized };
}

function aliasTarget(definition: JsonSchema): string | null {
  const ref = definition["$ref"];
  return Object.keys(definition).length === 1 &&
    typeof ref === "string" &&
    ref.startsWith(DEFINITION_REF_PREFIX)
    ? ref.slice(DEFINITION_REF_PREFIX.length)
    : null;
}
