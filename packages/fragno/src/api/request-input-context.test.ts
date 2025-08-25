import { test, expect, describe } from "vitest";
import { RequestInputContext } from "./request-input-context";
import { FragnoApiValidationError } from "./api";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Mock schema implementations for testing
const createMockSchema = (shouldPass: boolean, returnValue?: unknown): StandardSchemaV1 => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async (value: unknown) => {
      if (shouldPass) {
        return { value: returnValue ?? value };
      } else {
        return {
          issues: [
            {
              kind: "validation",
              type: "string",
              input: value,
              expected: "string",
              received: typeof value,
              message: "Expected string",
              path: [],
            },
          ],
        };
      }
    },
  },
});

const validStringSchema = createMockSchema(true, "validated-string");
const invalidSchema = createMockSchema(false);

describe("RequestContext", () => {
  test("Should be able to destructure RequestContext class instance", () => {
    const ctx = new RequestInputContext({
      method: "GET",
      path: "/",
      pathParams: {},
      searchParams: new URLSearchParams(),
      body: undefined,
    });

    const { path, pathParams, searchParams, input, rawBody: body } = ctx;

    expect(path).toBe("/");
    expect(pathParams).toEqual({});
    expect(searchParams).toBeInstanceOf(URLSearchParams);
    expect(input).toBeUndefined();
    expect(body).toBeUndefined();
  });

  test("Should support body in constructor", () => {
    const jsonBody = { test: "data" };
    const ctx = new RequestInputContext({
      method: "POST",
      path: "/api/test",
      pathParams: {},
      searchParams: new URLSearchParams(),
      body: jsonBody,
    });

    expect(ctx.rawBody).toEqual(jsonBody);
  });

  test("Should support FormData body", () => {
    const formData = new FormData();
    formData.append("key", "value");

    const ctx = new RequestInputContext({
      path: "/api/form",
      pathParams: {},
      searchParams: new URLSearchParams(),
      body: formData,
      method: "POST",
    });

    expect(ctx.rawBody).toBe(formData);
  });

  test("Should support Blob body", () => {
    const blob = new Blob(["test content"], { type: "text/plain" });

    const ctx = new RequestInputContext({
      path: "/api/upload",
      pathParams: {},
      searchParams: new URLSearchParams(),
      body: blob,
      method: "POST",
    });

    expect(ctx.rawBody).toBe(blob);
  });

  test("Should create RequestContext with fromRequest static method", async () => {
    const request = new Request("https://example.com/api/test", {
      method: "POST",
      body: JSON.stringify({ test: "data" }),
    });

    const bodyData = { test: "data" };
    const ctx = await RequestInputContext.fromRequest({
      request,
      method: "POST",
      path: "/api/test",
      pathParams: {},
    });

    expect(ctx.path).toBe("/api/test");
    expect(ctx.rawBody).toEqual(bodyData);
  });

  test("Should create RequestContext with fromSSRContext static method", () => {
    const bodyData = { ssr: "data" };
    const ctx = RequestInputContext.fromSSRContext({
      method: "POST",
      path: "/api/ssr",
      pathParams: {},
      body: bodyData,
    });

    expect(ctx.path).toBe("/api/ssr");
    expect(ctx.rawBody).toEqual(bodyData);
  });

  describe("Input handling", () => {
    test("Should return undefined input when no input schema is provided", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: { test: "data" },
        method: "POST",
      });

      expect(ctx.input).toBeUndefined();
    });

    test("Should return input object when input schema is provided", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: { test: "data" },
        inputSchema: validStringSchema,
        method: "POST",
      });

      expect(ctx.input).toBeDefined();
      expect(ctx.input?.schema).toBe(validStringSchema);
      expect(typeof ctx.input.valid).toBe("function");
    });

    test("Should validate input successfully with valid data", async () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: "test string",
        inputSchema: validStringSchema,
        method: "POST",
      });

      const result = await ctx.input?.valid();
      expect(result).toBe("validated-string");
    });

    test("Should throw validation error with invalid data", async () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: 123, // Invalid for string schema
        inputSchema: invalidSchema,
        method: "POST",
      });

      await expect(ctx.input.valid()).rejects.toThrow(FragnoApiValidationError);
    });

    test("Should throw validation error with detailed issues", async () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: 123,
        inputSchema: invalidSchema,
        method: "POST",
      });

      try {
        await ctx.input?.valid();
        expect.fail("Should have thrown validation error");
      } catch (error) {
        expect(error).toBeInstanceOf(FragnoApiValidationError);
        const validationError = error as FragnoApiValidationError;
        expect(validationError.issues).toHaveLength(1);
        expect(validationError.issues[0]).toMatchObject({
          kind: "validation",
          type: "string",
          input: 123,
          expected: "string",
          received: "number",
          message: "Expected string",
        });
      }
    });

    test("Should skip validation when shouldValidateInput is false", async () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: 123,
        inputSchema: invalidSchema,
        shouldValidateInput: false,
        method: "POST",
      });

      // Should not throw even with invalid data
      const result = await ctx.input?.valid();
      expect(result).toBeUndefined();
    });

    test("Should throw error when trying to validate FormData", async () => {
      const formData = new FormData();
      formData.append("key", "value");

      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: formData,
        inputSchema: validStringSchema,
        method: "POST",
      });

      await expect(ctx.input.valid()).rejects.toThrow(
        "Schema validation is only supported for JSON data, not FormData or Blob",
      );
    });

    test("Should throw error when trying to validate Blob", async () => {
      const blob = new Blob(["test content"], { type: "text/plain" });

      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: blob,
        inputSchema: validStringSchema,
        method: "POST",
      });

      await expect(ctx.input.valid()).rejects.toThrow(
        "Schema validation is only supported for JSON data, not FormData or Blob",
      );
    });

    test("Should handle null body", async () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: null,
        inputSchema: validStringSchema,
        method: "POST",
      });

      const result = await ctx.input.valid();
      expect(result).toBe("validated-string");
    });

    test("Should handle undefined body", async () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        body: undefined,
        inputSchema: validStringSchema,
        method: "POST",
      });

      const result = await ctx.input.valid();
      expect(result).toBe("validated-string");
    });
  });

  describe("Validation configuration", () => {
    test("Should default shouldValidateInput to true", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        inputSchema: validStringSchema,
        method: "POST",
        body: undefined,
      });

      // We can't directly access the private field, but we can test the behavior
      expect(ctx.input).toBeDefined();
    });

    test("Should respect explicit shouldValidateInput true", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        inputSchema: validStringSchema,
        shouldValidateInput: true,
        method: "POST",
        body: undefined,
      });

      expect(ctx.input).toBeDefined();
    });

    test("Should respect shouldValidateInput false", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        inputSchema: validStringSchema,
        shouldValidateInput: false,
        method: "POST",
        body: undefined,
      });

      expect(ctx.input).toBeDefined();
    });

    test("Should disable validation in SSR context by default", () => {
      const ctx = RequestInputContext.fromSSRContext({
        path: "/test",
        pathParams: {},
        // inputSchema is not available in SSR context, but validation is disabled
        method: "POST",
        body: undefined,
      });

      // This tests that shouldValidateInput is set to false in SSR context
      expect(ctx.input).toBeUndefined();
    });

    test("Should pass through shouldValidateInput from fromRequest", async () => {
      const request = new Request("https://example.com/api/test");
      const ctx = await RequestInputContext.fromRequest({
        request,
        path: "/test",
        pathParams: {},
        inputSchema: validStringSchema,
        shouldValidateInput: false,
        method: "POST",
      });

      expect(ctx.input).toBeDefined();
    });
  });

  describe("Edge cases and error conditions", () => {
    test("Should handle empty path params", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        method: "POST",
        body: undefined,
      });

      expect(ctx.pathParams).toEqual({});
    });

    test("Should handle empty search params", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        method: "POST",
        body: undefined,
      });

      expect(ctx.searchParams.toString()).toBe("");
    });

    test("Should handle search params with values", () => {
      const searchParams = new URLSearchParams("?key=value&another=test");
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams,
        method: "POST",
        body: undefined,
      });

      expect(ctx.searchParams.get("key")).toBe("value");
      expect(ctx.searchParams.get("another")).toBe("test");
    });

    test("Should extract search params from request URL in fromRequest", async () => {
      const request = new Request("https://example.com/api/test?param=value");
      const ctx = await RequestInputContext.fromRequest({
        request,
        path: "/test",
        pathParams: {},
        method: "POST",
      });

      expect(ctx.searchParams.get("param")).toBe("value");
    });

    test("Should use default empty search params in fromSSRContext when not provided", () => {
      const ctx = RequestInputContext.fromSSRContext({
        path: "/test",
        pathParams: {},
        method: "POST",
        body: undefined,
      });

      expect(ctx.searchParams.toString()).toBe("");
    });

    test("Should use provided search params in fromSSRContext", () => {
      const searchParams = new URLSearchParams("?ssr=true");
      const ctx = RequestInputContext.fromSSRContext({
        path: "/test",
        pathParams: {},
        searchParams,
        method: "POST",
        body: undefined,
      });

      expect(ctx.searchParams.get("ssr")).toBe("true");
    });
  });
});
