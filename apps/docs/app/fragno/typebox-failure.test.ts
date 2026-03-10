/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@mariozechner/pi-ai";
import { bashParametersSchema } from "./pi-schema";
import AjvModule from "ajv";

describe("typebox failure reproduction", () => {
  it("eval is blocked in the workers test runtime", () => {
    expect(env).toBeDefined();
    // oxlint-disable-next-line no-eval -- intentional CSP regression test
    expect(() => eval("1 + 1")).toThrow(/Code generation from strings disallowed/i);
  });

  it("new Function works in the workers test runtime", () => {
    expect(env).toBeDefined();
    const fn = new Function("return 2 + 2;");
    expect(fn()).toBe(4);
  });

  it("validateToolArguments reports a validation error for invalid bash args", () => {
    expect(env).toBeDefined();
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
    expect(env).toBeDefined();
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

  it("ajv compiles the bash schema in the workers test runtime", () => {
    const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default || AjvModule;
    const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
    const validate = ajv.compile(bashParametersSchema);
    expect(validate({ script: "echo ok" })).toBe(true);
    expect(validate({ script: "" })).toBe(false);
  });
});
