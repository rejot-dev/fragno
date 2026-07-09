import { describe, expect, test } from "vitest";

import { jsonSchema202012ValidationSchema } from "./validation";

describe("jsonSchema202012ValidationSchema", () => {
  test("accepts a recursive draft 2020-12 schema", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    };

    expect(jsonSchema202012ValidationSchema.parse(schema)).toEqual(schema);
  });

  test.each([
    ["invalid type", { type: 42 }],
    ["invalid nested schema", { properties: { id: { type: 42 } } }],
    ["invalid required", { type: "object", required: "id" }],
    ["invalid numeric constraint", { type: "number", minimum: "0" }],
    ["invalid composition", { anyOf: {} }],
  ])("rejects %s", (_label, schema) => {
    expect(() => jsonSchema202012ValidationSchema.parse(schema)).toThrow();
  });

  test("rejects unsupported drafts", () => {
    expect(() =>
      jsonSchema202012ValidationSchema.parse({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
      }),
    ).toThrow();
  });

  test("preserves extension keywords", () => {
    const schema = { type: "string", "x-example": "value" };

    expect(jsonSchema202012ValidationSchema.parse(schema)).toEqual(schema);
  });
});
