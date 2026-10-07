import { Validator, dereference, type Schema, type SchemaDraft } from "@cfworker/json-schema";

import { jsonSchema202012ValidationSchema } from "@/lib/json-schema/validation";

// MCP SDK servers publish draft-07; catalogs without a dialect use 2020-12.
const supportedDialects = new Map<unknown, SchemaDraft>([
  [undefined, "2020-12"],
  ["https://json-schema.org/draft/2020-12/schema", "2020-12"],
  ["http://json-schema.org/draft-07/schema#", "7"],
  ["http://json-schema.org/draft-07/schema", "7"],
]);

/**
 * Compiles a source-published action contract, or returns null when its dialect, references, or
 * vocabulary would be silently weakened by validation.
 */
export function compileIntegrationActionSchema(schema: Record<string, unknown>): Validator | null {
  const draft = supportedDialects.get(schema.$schema);
  if (draft === undefined) {
    return null;
  }
  try {
    const { $schema: _dialect, ...body } = schema;
    const parsed = jsonSchema202012ValidationSchema.parse(draft === "7" ? body : schema) as Schema;
    const references = dereference(parsed);
    for (const subschema of Object.values(references)) {
      if (typeof subschema === "boolean") {
        continue;
      }
      for (const keyword of [
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "minProperties",
        "maxProperties",
        "minContains",
        "maxContains",
      ] as const) {
        const value = subschema[keyword];
        if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
          return null;
        }
      }
      // Boolean bounds are draft-04 semantics, which neither supported dialect shares.
      for (const keyword of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
        if (typeof subschema[keyword] === "boolean") {
          return null;
        }
      }
      if (subschema.multipleOf !== undefined && subschema.multipleOf <= 0) {
        return null;
      }
      if (subschema.pattern !== undefined) {
        new RegExp(subschema.pattern, "u");
      }
      for (const pattern of Object.keys(subschema.patternProperties ?? {})) {
        new RegExp(pattern, "u");
      }
      if (
        subschema.$dynamicRef !== undefined ||
        subschema.$recursiveRef !== undefined ||
        subschema.$vocabulary !== undefined ||
        (subschema.__absolute_ref__ !== undefined &&
          references[subschema.__absolute_ref__] === undefined)
      ) {
        return null;
      }
    }
    return new Validator(parsed, draft);
  } catch {
    // Malformed schemas and invalid patterns are unsupported contracts, not runtime failures.
    return null;
  }
}
