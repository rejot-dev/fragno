import { describe, expect, test } from "vitest";

import {
  assertAutomationEventJsonSchema,
  AutomationEventDefinitionValidationError,
} from "./event-definitions";

describe("assertAutomationEventJsonSchema", () => {
  test.each([
    ["array root", []],
    ["string root", "object"],
    ["invalid nested type", { type: "object", properties: { id: { type: 42 } } }],
    ["non-array required", { type: "object", required: "id" }],
    ["non-object properties", { type: "object", properties: [] }],
    ["non-number minimum", { type: "number", minimum: "0" }],
    ["non-array anyOf", { anyOf: {} }],
  ])("rejects structurally invalid schema: %s", (_label, invalidSchema) => {
    expect(() => assertAutomationEventJsonSchema(invalidSchema, "payload")).toThrow(
      AutomationEventDefinitionValidationError,
    );
    expect(() => assertAutomationEventJsonSchema(invalidSchema, "payload")).toThrow(
      "Invalid payload JSON Schema",
    );
  });

  test.each(["http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-04/schema#"])(
    "rejects unsupported schema draft: %s",
    ($schema) => {
      expect(() => assertAutomationEventJsonSchema({ $schema, type: "object" }, "payload")).toThrow(
        AutomationEventDefinitionValidationError,
      );
    },
  );

  test("accepts structurally valid draft 2020-12 schemas", () => {
    expect(() =>
      assertAutomationEventJsonSchema(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        "payload",
      ),
    ).not.toThrow();
  });
});
