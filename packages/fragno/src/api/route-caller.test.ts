import { describe, expect, test } from "vitest";

import { createRouteCaller } from "./route-caller";

describe("createRouteCaller", () => {
  test("replaces inherited content-type with application/json for object bodies", async () => {
    let capturedRequest: Request | null = null;

    const callRoute = createRouteCaller<{
      callRoute: (
        method: "POST",
        path: "/test",
        input: { body: { hello: string } },
      ) => Promise<unknown>;
    }>({
      baseUrl: "https://example.com/app",
      baseHeaders: {
        "content-type": "application/x-www-form-urlencoded",
      },
      fetch: async (request) => {
        capturedRequest = request;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await callRoute("POST", "/test", {
      body: { hello: "world" },
    });

    if (!capturedRequest) {
      throw new Error("Expected fetch to receive a request.");
    }

    const request = capturedRequest as Request;
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe('{"hello":"world"}');
  });

  test("keeps an explicit application/octet-stream content-type for binary bodies", async () => {
    let capturedRequest: Request | null = null;

    const callRoute = createRouteCaller<{
      callRoute: (
        method: "POST",
        path: "/binary",
        input: { body: ArrayBuffer; headers: HeadersInit },
      ) => Promise<unknown>;
    }>({
      baseUrl: "https://example.com/app",
      baseHeaders: {
        "content-type": "multipart/form-data; boundary=---original",
      },
      fetch: async (request) => {
        capturedRequest = request;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await callRoute("POST", "/binary", {
      body: new Uint8Array([1, 2, 3]).buffer,
      headers: {
        "content-type": "application/octet-stream",
      },
    });

    if (!capturedRequest) {
      throw new Error("Expected fetch to receive a request.");
    }

    const request = capturedRequest as Request;
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
