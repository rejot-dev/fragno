import { describe, expect, test } from "vitest";

import type { AnySchema } from "ajv";

import { createAjv } from "@jsonforms/core";

import { getBackofficeJsonFormErrorMessages } from "./backoffice-json-form-errors";

function validate(schema: AnySchema, data: unknown) {
  const ajv = createAjv();
  void ajv.validate(schema, data);
  return getBackofficeJsonFormErrorMessages(ajv.errors);
}

describe("getBackofficeJsonFormErrorMessages", () => {
  test("translates email format errors", () => {
    expect(validate({ type: "string", format: "email" }, "not-an-email")).toEqual([
      "Enter a valid email address.",
    ]);
  });

  test("translates false schemas without exposing JSON Schema terminology", () => {
    expect(validate(false, "unexpected")).toEqual(["This value is not allowed."]);
  });

  test("includes actionable length limits", () => {
    expect(validate({ type: "string", minLength: 3 }, "x")).toEqual([
      "Enter at least 3 characters.",
    ]);
  });
});
