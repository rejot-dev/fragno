import { test, expect, describe } from "vitest";
import { RequestInputContext } from "./request-input-context";
import { FragnoApiValidationError } from "./api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { MutableRequestState } from "./mutable-request-state";

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
      headers: new Headers(),
      parsedBody: undefined,
    });

    const { path, pathParams, query: searchParams, input, rawBody } = ctx;

    expect(path).toBe("/");
    expect(pathParams).toEqual({});
    expect(searchParams).toBeInstanceOf(URLSearchParams);
    expect(input).toBeUndefined();
    expect(rawBody).toBeUndefined();
  });

  test("Should support body in constructor", () => {
    const jsonBody = { test: "data" };
    const rawBodyText = JSON.stringify(jsonBody);
    const ctx = new RequestInputContext({
      method: "POST",
      path: "/api/test",
      pathParams: {},
      searchParams: new URLSearchParams(),
      headers: new Headers(),
      parsedBody: jsonBody,
      rawBody: rawBodyText,
    });

    expect(ctx.rawBody).toEqual(rawBodyText);
  });

  test("Should support FormData body", () => {
    const formData = new FormData();
    formData.append("key", "value");
    const rawBodyText = "form-data-as-text";

    const ctx = new RequestInputContext({
      path: "/api/form",
      pathParams: {},
      searchParams: new URLSearchParams(),
      headers: new Headers(),
      parsedBody: formData,
      rawBody: rawBodyText,
      method: "POST",
    });

    expect(ctx.rawBody).toBe(rawBodyText);
  });

  test("Should support Blob body", () => {
    const blob = new Blob(["test content"], { type: "text/plain" });
    const rawBodyText = "test content";

    const ctx = new RequestInputContext({
      path: "/api/upload",
      pathParams: {},
      searchParams: new URLSearchParams(),
      headers: new Headers(),
      parsedBody: blob,
      rawBody: rawBodyText,
      method: "POST",
    });

    expect(ctx.rawBody).toBe(rawBodyText);
  });

  test("Should create RequestContext with fromRequest static method", async () => {
    const request = new Request("https://example.com/api/test", {
      method: "POST",
      body: JSON.stringify({ test: "data" }),
    });

    const url = new URL(request.url);
    const clonedReq = request.clone();
    const body = clonedReq.body instanceof ReadableStream ? await clonedReq.json() : undefined;
    const rawBodyText = JSON.stringify({ test: "data" });

    const state = new MutableRequestState({
      pathParams: {},
      searchParams: url.searchParams,
      body,
      headers: new Headers(request.headers),
    });

    const ctx = await RequestInputContext.fromRequest({
      request,
      method: "POST",
      path: "/api/test",
      pathParams: {},
      state,
      rawBody: rawBodyText,
    });

    expect(ctx.path).toBe("/api/test");
    expect(ctx.rawBody).toEqual(rawBodyText);
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
    // rawBody is not set in fromSSRContext
    expect(ctx.rawBody).toBeUndefined();
  });

  describe("Input handling", () => {
    test("Should return undefined input when no input schema is provided", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: { test: "data" },
        method: "POST",
      });

      expect(ctx.input).toBeUndefined();
    });

    test("Should return input object when input schema is provided", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: { test: "data" },
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
        headers: new Headers(),
        parsedBody: "test string",
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
        headers: new Headers(),
        parsedBody: 123, // Invalid for string schema
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
        headers: new Headers(),
        parsedBody: 123,
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
        headers: new Headers(),
        parsedBody: 123,
        inputSchema: invalidSchema,
        shouldValidateInput: false,
        method: "POST",
      });

      // Should return the parsed body without validation when validation is disabled
      const result = await ctx.input?.valid();
      expect(result).toBe(123);
    });

    test("Should throw error when trying to validate FormData", async () => {
      const formData = new FormData();
      formData.append("key", "value");

      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: formData,
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
        headers: new Headers(),
        parsedBody: blob,
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
        headers: new Headers(),
        parsedBody: null,
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
        headers: new Headers(),
        parsedBody: undefined,
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
        headers: new Headers(),
        inputSchema: validStringSchema,
        method: "POST",
        parsedBody: undefined,
      });

      // We can't directly access the private field, but we can test the behavior
      expect(ctx.input).toBeDefined();
    });

    test("Should respect explicit shouldValidateInput true", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        inputSchema: validStringSchema,
        shouldValidateInput: true,
        method: "POST",
        parsedBody: undefined,
      });

      expect(ctx.input).toBeDefined();
    });

    test("Should respect shouldValidateInput false", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        inputSchema: validStringSchema,
        shouldValidateInput: false,
        method: "POST",
        parsedBody: undefined,
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
      const url = new URL(request.url);
      const state = new MutableRequestState({
        pathParams: {},
        searchParams: url.searchParams,
        body: undefined,
        headers: new Headers(request.headers),
      });

      const ctx = await RequestInputContext.fromRequest({
        request,
        path: "/test",
        pathParams: {},
        inputSchema: validStringSchema,
        shouldValidateInput: false,
        method: "POST",
        state,
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
        headers: new Headers(),
        method: "POST",
        parsedBody: undefined,
      });

      expect(ctx.pathParams).toEqual({});
    });

    test("Should handle empty search params", () => {
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        method: "POST",
        parsedBody: undefined,
      });

      expect(ctx.query.toString()).toBe("");
    });

    test("Should handle search params with values", () => {
      const searchParams = new URLSearchParams("?key=value&another=test");
      const ctx = new RequestInputContext({
        path: "/test",
        pathParams: {},
        searchParams,
        headers: new Headers(),
        method: "POST",
        parsedBody: undefined,
      });

      expect(ctx.query.get("key")).toBe("value");
      expect(ctx.query.get("another")).toBe("test");
    });

    test("Should extract search params from request URL in fromRequest", async () => {
      const request = new Request("https://example.com/api/test?param=value");
      const url = new URL(request.url);
      const state = new MutableRequestState({
        pathParams: {},
        searchParams: url.searchParams,
        body: undefined,
        headers: new Headers(request.headers),
      });

      const ctx = await RequestInputContext.fromRequest({
        request,
        path: "/test",
        pathParams: {},
        method: "POST",
        state,
      });

      expect(ctx.query.get("param")).toBe("value");
    });

    test("Should use default empty search params in fromSSRContext when not provided", () => {
      const ctx = RequestInputContext.fromSSRContext({
        path: "/test",
        pathParams: {},
        method: "POST",
        body: undefined,
      });

      expect(ctx.query.toString()).toBe("");
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

      expect(ctx.query.get("ssr")).toBe("true");
    });
  });

  describe("FormData handling", () => {
    test("formData() should return FormData when body is FormData", () => {
      const formData = new FormData();
      formData.append("file", new Blob(["test"]), "test.txt");
      formData.append("description", "A test file");

      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: formData,
        method: "POST",
      });

      const result = ctx.formData();
      expect(result).toBe(formData);
      expect(result.get("description")).toBe("A test file");
    });

    test("formData() should throw when body is not FormData", () => {
      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: { key: "value" },
        method: "POST",
      });

      expect(() => ctx.formData()).toThrow(
        "Request body is not FormData. Ensure the request was sent with Content-Type: multipart/form-data.",
      );
    });

    test("formData() should throw when body is undefined", () => {
      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: undefined,
        method: "POST",
      });

      expect(() => ctx.formData()).toThrow(
        "Request body is not FormData. Ensure the request was sent with Content-Type: multipart/form-data.",
      );
    });

    test("isFormData() should return true when body is FormData", () => {
      const formData = new FormData();
      formData.append("key", "value");

      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: formData,
        method: "POST",
      });

      expect(ctx.isFormData()).toBe(true);
    });

    test("isFormData() should return false when body is JSON", () => {
      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: { key: "value" },
        method: "POST",
      });

      expect(ctx.isFormData()).toBe(false);
    });

    test("isFormData() should return false when body is undefined", () => {
      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: undefined,
        method: "POST",
      });

      expect(ctx.isFormData()).toBe(false);
    });

    test("isFormData() should return false when body is Blob", () => {
      const blob = new Blob(["test content"], { type: "text/plain" });

      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: blob,
        method: "POST",
      });

      expect(ctx.isFormData()).toBe(false);
    });

    test("Can use isFormData() to conditionally access formData()", () => {
      const formData = new FormData();
      formData.append("file", new Blob(["test"]), "test.txt");

      const ctx = new RequestInputContext({
        path: "/upload",
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        parsedBody: formData,
        method: "POST",
      });

      if (ctx.isFormData()) {
        const result = ctx.formData();
        expect(result.get("file")).toBeInstanceOf(Blob);
      } else {
        expect.fail("Should have detected FormData");
      }
    });
  });
});
