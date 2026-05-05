import { describe, expect, it } from "vitest";

import AjvModule from "ajv";

import { validateToolArguments } from "@mariozechner/pi-ai";

import { bashParametersSchema } from "./pi-schema";

describe("typebox failure reproduction", () => {
  it("validateToolArguments reports a validation error for invalid bash args", () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "Tool used to reproduce AJV eval/Function CSP failures.",
      parameters: bashParametersSchema,
    };

    const toolCall = {
      type: "toolCall" as const,
      id: "test-tool-call-invalid",
      name: "bash",
      arguments: { script: "" },
    };

    let thrown: unknown = null;
    try {
      validateToolArguments(tool, toolCall);
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown ?? "");
    expect(message).toMatch(/Validation failed for tool "bash"/i);
    expect(message).toMatch(/script/i);
  });

  it("validateToolArguments accepts valid bash args", () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "Tool used to validate bash args.",
      parameters: bashParametersSchema,
    };

    const toolCall = {
      type: "toolCall" as const,
      id: "test-tool-call",
      name: "bash",
      arguments: { script: "echo ok" },
    };

    try {
      const result = validateToolArguments(tool, toolCall);
      expect(result).toEqual(toolCall.arguments);
    } finally {
      // no-op
    }
  });

  it("ajv compiles the bash schema", () => {
    const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default || AjvModule;
    const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
    const validate = ajv.compile(bashParametersSchema);
    expect(validate({ script: "echo ok" })).toBe(true);
    expect(validate({ script: "" })).toBe(false);
  });
});
