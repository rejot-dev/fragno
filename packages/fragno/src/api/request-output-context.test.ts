import { test, expect, describe, vi } from "vitest";
import { RequestOutputContext } from "./request-output-context";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ResponseStream } from "./internal/response-stream";

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

const mockStringSchema = createMockSchema(true, "validated-string");

describe("RequestOutputContext", () => {
  describe("Constructor", () => {
    test("Should create instance without schema", () => {
      const ctx = new RequestOutputContext();
      expect(ctx).toBeInstanceOf(RequestOutputContext);
    });

    test("Should create instance with schema", () => {
      const ctx = new RequestOutputContext(mockStringSchema);
      expect(ctx).toBeInstanceOf(RequestOutputContext);
    });
  });

  describe("empty() method", () => {
    test("Should return empty response with default 201 status", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.empty();

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body).toBe(null);
    });

    test("Should return empty response with custom status number", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.empty(204);

      expect(response.status).toBe(204);

      const body = await response.json();
      expect(body).toBe(null);
    });

    test("Should return empty response with custom headers via second parameter", async () => {
      const ctx = new RequestOutputContext();
      const headers = { "X-Custom": "test-value" };
      const response = ctx.empty(undefined, headers);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Custom")).toBe("test-value");

      const body = await response.json();
      expect(body).toBe(null);
    });

    test("Should return empty response with status and headers via second parameter", async () => {
      const ctx = new RequestOutputContext();
      const headers = { "X-Custom": "test-value" };
      const response = ctx.empty(204, headers);

      expect(response.status).toBe(204);
      expect(response.headers.get("X-Custom")).toBe("test-value");

      const body = await response.json();
      expect(body).toBe(null);
    });

    test("Should return empty response with ResponseInit object", async () => {
      const ctx = new RequestOutputContext();
      const init = {
        status: 204 as const,
        headers: { "X-Custom": "test-value" },
        statusText: "No Content",
      };
      const response = ctx.empty(init);

      expect(response.status).toBe(204);
      expect(response.headers.get("X-Custom")).toBe("test-value");

      const body = await response.json();
      expect(body).toBe(null);
    });

    test("Should handle multiple headers in ResponseInit", async () => {
      const ctx = new RequestOutputContext();
      const init = {
        status: 204 as const,
        headers: {
          "X-Custom": "test-value",
          "X-Another": "another-value",
          "Content-Type": "application/json",
        },
      };
      const response = ctx.empty(init);

      expect(response.status).toBe(204);
      expect(response.headers.get("X-Custom")).toBe("test-value");
      expect(response.headers.get("X-Another")).toBe("another-value");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("json() method", () => {
    test("Should return JSON response with default 200 status", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const response = ctx.json(data);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should return JSON response with custom status number", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "created" };
      const response = ctx.json(data, 201);

      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should have JSON content type by default", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const response = ctx.json(data);
      expect(response.headers.get("content-type")).toBe("application/json");
    });

    test("Should return JSON response with custom headers via third parameter", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const headers = { "X-Custom": "test-value" };
      const response = ctx.json(data, undefined, headers);

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Custom")).toBe("test-value");

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should return JSON response with status and headers via third parameter", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const headers = { "X-Custom": "test-value" };
      const response = ctx.json(data, 201, headers);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Custom")).toBe("test-value");

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should return JSON response with ResponseInit object", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const init = {
        status: 201 as const,
        headers: { "X-Custom": "test-value" },
        statusText: "Created",
      };
      const response = ctx.json(data, init);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Custom")).toBe("test-value");

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should merge headers when both ResponseInit and headers parameter are provided", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const init = {
        status: 201 as const,
        headers: { "X-Init": "init-value" },
      };
      const headers = { "X-Param": "param-value" };
      const response = ctx.json(data, init, headers);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Init")).toBe("init-value");
      expect(response.headers.get("X-Param")).toBe("param-value");

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should override headers when same key exists in both ResponseInit and headers parameter", async () => {
      const ctx = new RequestOutputContext();
      const data = { message: "test" };
      const init = {
        status: 201 as const,
        headers: { "X-Custom": "init-value" },
      };
      const headers = { "X-Custom": "param-value" };
      const response = ctx.json(data, init, headers);

      expect(response.status).toBe(201);
      // Headers parameter should override ResponseInit headers
      expect(response.headers.get("X-Custom")).toBe("param-value");

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should handle null data", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.json(null);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toBe(null);
    });

    test("Should handle array data", async () => {
      const ctx = new RequestOutputContext();
      const data = [1, 2, 3];
      const response = ctx.json(data);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should handle primitive data", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.json("test string");

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toBe("test string");
    });

    test("Should work with typed schema", async () => {
      const ctx = new RequestOutputContext(mockStringSchema);
      const data = "test string";
      const response = ctx.json(data);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toBe(data);
    });
  });

  describe("stream() method", () => {
    test("Should return streaming response", () => {
      const ctx = new RequestOutputContext();
      const response = ctx.jsonStream(() => {});

      expect(response).toBeInstanceOf(Response);
      expect(response.body).toBeInstanceOf(ReadableStream);
    });

    test("Should have chunked transfer encoding by default", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.jsonStream(() => {});
      expect(response.headers.get("transfer-encoding")).toBe("chunked");
    });

    test("Should handle callback that writes data", async () => {
      const ctx = new RequestOutputContext();
      const testData = "Hello, World!";

      const response = ctx.jsonStream(async (stream) => {
        await stream.writeRaw(testData);
      });

      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const decoder = new TextDecoder();
      const result = decoder.decode(value);

      expect(result).toBe(testData);

      reader.releaseLock();
    });

    test("Should handle callback that writes multiple chunks", async () => {
      const ctx = new RequestOutputContext();

      const response = ctx.jsonStream(async (stream) => {
        await stream.writeRaw("Hello, ");
        await stream.writeRaw("World!");
      });

      const reader = response.body!.getReader();
      const chunks: string[] = [];
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(decoder.decode(value));
        }
      } catch {
        // Stream might be closed
      }

      expect(chunks.join("")).toBe("Hello, World!");

      reader.releaseLock();
    });

    test("Should handle callback that uses writeln", async () => {
      const ctx = new RequestOutputContext();

      const response = ctx.jsonStream(async (stream) => {
        await stream.writeRaw("Line 1\n");
        await stream.writeRaw("Line 2\n");
      });

      const reader = response.body!.getReader();
      const chunks: string[] = [];
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(decoder.decode(value));
        }
      } catch {
        // Stream might be closed
      }

      expect(chunks.join("")).toBe("Line 1\nLine 2\n");

      reader.releaseLock();
    });

    test("Should handle errors in callback", async () => {
      const ctx = new RequestOutputContext();
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const _response = ctx.jsonStream(() => {
        throw new Error("Test error");
      });

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(consoleErrorSpy).toHaveBeenCalledWith(new Error("Test error"));

      consoleErrorSpy.mockRestore();
    });

    test("Should call onError handler when provided", async () => {
      const ctx = new RequestOutputContext();
      const onErrorMock = vi.fn();
      const testError = new Error("Test error");

      ctx.jsonStream(
        () => {
          throw testError;
        },
        {
          onError: onErrorMock,
        },
      );

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledWith(testError, expect.any(ResponseStream));
    });

    test("Should handle undefined error (canceled stream)", async () => {
      const ctx = new RequestOutputContext();
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      ctx.jsonStream(() => {
        throw undefined;
      });

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not call console.error for undefined
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    test("Should handle non-Error exceptions without onError handler", async () => {
      const ctx = new RequestOutputContext();
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      ctx.jsonStream(() => {
        throw "String error";
      });

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleErrorSpy).toHaveBeenCalledWith("String error");

      consoleErrorSpy.mockRestore();
    });

    test("Should handle async callback", async () => {
      const ctx = new RequestOutputContext();
      const testData = "Async data";

      const response = ctx.jsonStream(async (stream) => {
        await stream.sleep(1);
        await stream.writeRaw(testData);
      });

      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const decoder = new TextDecoder();
      const result = decoder.decode(value);

      expect(result).toBe(testData);

      reader.releaseLock();
    });

    test("Should handle stream abort", async () => {
      const ctx = new RequestOutputContext();
      let streamRef: ResponseStream<unknown> | undefined;

      const _response = ctx.jsonStream((stream) => {
        streamRef = stream;
        stream.onAbort(() => {
          // Abort handler
        });
      });

      // Wait for setup
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(streamRef!.aborted).toBe(false);

      streamRef!.abort();

      expect(streamRef!.aborted).toBe(true);
    });

    test("Should close stream after callback execution", async () => {
      const ctx = new RequestOutputContext();
      let streamRef: ResponseStream<unknown> | undefined;

      ctx.jsonStream((stream) => {
        streamRef = stream;
      });

      // Wait for execution and cleanup
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(streamRef!.closed).toBe(true);
    });

    test("Should handle Uint8Array data", async () => {
      const ctx = new RequestOutputContext();
      const testData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

      const response = ctx.jsonStream(async (stream) => {
        await stream.writeRaw(testData);
      });

      const reader = response.body!.getReader();
      const { value } = await reader.read();

      expect(value).toEqual(testData);

      reader.releaseLock();
    });

    test("Should be able to override the content type", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.jsonStream(() => {}, {
        headers: { "content-type": "application/octet-stream" },
      });

      expect(response.headers.get("content-type")).toBe("application/octet-stream");
    });
  });

  describe("Type inference with schema", () => {
    test("Should work with typed schema for json method", async () => {
      // This test mainly checks that TypeScript compilation works correctly
      const ctx = new RequestOutputContext(mockStringSchema);

      // With schema, the json method should expect the inferred type
      const response = ctx.json("test string");

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toBe("test string");
    });

    test("Should work without schema (unknown type)", async () => {
      const ctx = new RequestOutputContext();

      // Without schema, json method accepts any type
      const response1 = ctx.json({ any: "object" });
      const response2 = ctx.json("string");
      const response3 = ctx.json(123);
      const response4 = ctx.json([1, 2, 3]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response3.status).toBe(200);
      expect(response4.status).toBe(200);
    });
  });

  describe("Edge cases", () => {
    test("Should handle empty object in json", async () => {
      const ctx = new RequestOutputContext();
      const response = ctx.json({});

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual({});
    });

    test("Should handle complex nested object in json", async () => {
      const ctx = new RequestOutputContext();
      const data = {
        user: {
          id: 1,
          name: "John",
          preferences: {
            theme: "dark",
            notifications: true,
          },
        },
        items: [1, 2, 3],
      };
      const response = ctx.json(data);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual(data);
    });

    test("Should handle Headers object in ResponseInit", async () => {
      const ctx = new RequestOutputContext();
      const headers = new Headers();
      headers.set("X-Custom", "test-value");
      headers.set("Content-Type", "application/json");

      const init = {
        status: 201 as const,
        headers,
      };
      const response = ctx.json({ message: "test" }, init);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Custom")).toBe("test-value");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    test("Should handle Headers object merging", async () => {
      const ctx = new RequestOutputContext();
      const initHeaders = new Headers();
      initHeaders.set("X-Init", "init-value");

      const init = {
        status: 201 as const,
        headers: initHeaders,
      };
      const paramHeaders = { "X-Param": "param-value" };
      const response = ctx.json({ message: "test" }, init, paramHeaders);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Init")).toBe("init-value");
      expect(response.headers.get("X-Param")).toBe("param-value");
    });

    test("Should handle stream with immediate close", async () => {
      const ctx = new RequestOutputContext();

      const response = ctx.jsonStream((stream) => {
        stream.close();
      });

      expect(response).toBeInstanceOf(Response);
      expect(response.body).toBeInstanceOf(ReadableStream);
    });
  });
});
