import { describe, expect, it, assert } from "vitest";

import Ajv from "ajv";

import { execCodeModeParametersSchema } from "@/fragno/pi/pi-tools";

describe("Pi tool TypeBox schemas", () => {
  it("rejects empty codemode programs", () => {
    const validate = new Ajv().compile(execCodeModeParametersSchema);

    assert(!validate({ code: "" }));
    expect(validate.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "minLength" })]),
    );
  });

  it("accepts immediate and durable codemode programs", () => {
    const validate = new Ajv().compile(execCodeModeParametersSchema);

    assert(validate({ code: "async () => ({ ok: true })" }));
    assert(validate({ code: 'defineWorkflow({ name: "demo" }, async () => ({}))' }));
  });
});
