import { describe, expect, expectTypeOf, test } from "vitest";

import { z } from "zod";

import type { FragnoResponse } from "./fragno-response";
import { defineRoute } from "./route";
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

  test("infers route-specific inputs and outputs from fragment routes", async () => {
    const routes = [
      defineRoute({
        method: "GET",
        path: "/threads",
        outputSchema: z.object({
          threads: z.array(z.object({ id: z.string() })),
          hasNextPage: z.boolean(),
        }),
        handler: async (_ctx, { json }) =>
          json({ threads: [{ id: "thread-1" }], hasNextPage: false }),
      }),
      defineRoute({
        method: "GET",
        path: "/threads/:threadId/messages",
        outputSchema: z.object({
          messages: z.array(z.object({ id: z.string(), threadId: z.string() })),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        handler: async ({ pathParams, query }, { json }) =>
          json({
            messages: [{ id: "message-1", threadId: pathParams.threadId }],
            cursor: query.get("cursor") ?? undefined,
            hasNextPage: false,
          }),
      }),
      defineRoute({
        method: "POST",
        path: "/threads/:threadId/reply",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        handler: async (_ctx, { json }) => json({ ok: true }),
      }),
    ] as const;

    type FakeFragment = {
      routes: typeof routes;
    };

    const callRoute = createRouteCaller<FakeFragment>({
      baseUrl: "https://example.com/app",
      mountRoute: "/api",
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/api/threads") {
          return Response.json({
            threads: [{ id: "thread-1" }],
            hasNextPage: false,
          });
        }

        if (url.pathname === "/api/threads/thread-1/messages") {
          return Response.json({
            messages: [{ id: "message-1", threadId: "thread-1" }],
            cursor: url.searchParams.get("cursor") ?? undefined,
            hasNextPage: false,
          });
        }

        if (url.pathname === "/api/threads/thread-1/reply") {
          const body = (await request.json()) as { text: string };
          return Response.json({ ok: body.text === "hello" });
        }

        return Response.json({ message: "Not found", code: "NOT_FOUND" }, { status: 404 });
      },
    });

    const listResponse = await callRoute("GET", "/threads", {
      query: { cursor: "cursor-1" },
    });
    const messagesResponse = await callRoute("GET", "/threads/:threadId/messages", {
      pathParams: { threadId: "thread-1" },
      query: { cursor: "cursor-1" },
    });
    const replyResponse = await callRoute("POST", "/threads/:threadId/reply", {
      pathParams: { threadId: "thread-1" },
      body: { text: "hello" },
    });

    expectTypeOf<Extract<typeof listResponse, { type: "json" }>["data"]>().toEqualTypeOf<{
      threads: { id: string }[];
      hasNextPage: boolean;
    }>();
    expectTypeOf<Extract<typeof messagesResponse, { type: "json" }>["data"]>().toEqualTypeOf<{
      messages: { id: string; threadId: string }[];
      cursor?: string | undefined;
      hasNextPage: boolean;
    }>();
    expectTypeOf<Extract<typeof replyResponse, { type: "json" }>["data"]>().toEqualTypeOf<{
      ok: boolean;
    }>();
    expectTypeOf<typeof listResponse>().toExtend<FragnoResponse<unknown>>();

    expect(listResponse.type).toBe("json");
    if (listResponse.type === "json") {
      expect(listResponse.data.threads[0]?.id).toBe("thread-1");
    }

    expect(messagesResponse.type).toBe("json");
    if (messagesResponse.type === "json") {
      expect(messagesResponse.data.messages[0]?.threadId).toBe("thread-1");
      expect(messagesResponse.data.cursor).toBe("cursor-1");
    }

    expect(replyResponse.type).toBe("json");
    if (replyResponse.type === "json") {
      expect(replyResponse.data.ok).toBe(true);
    }
  });
});
