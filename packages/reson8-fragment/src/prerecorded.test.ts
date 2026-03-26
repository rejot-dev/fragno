import { describe, expect, test } from "vitest";

import {
  createBinaryStream,
  createJsonResponse,
  createReson8TestContext,
  readRequestBody,
} from "./test-context";

describe("reson8 prerecorded transcription routes", () => {
  test("forwards octet-stream bodies and documented query parameters upstream", async () => {
    const ctx = createReson8TestContext();
    ctx.fetchMock.mockResolvedValue(
      createJsonResponse({
        text: "hello world",
        words: [{ text: "hello" }, { text: "world" }],
      }),
    );

    const response = await ctx.fragment.callRoute("POST", "/speech-to-text/prerecorded", {
      headers: { Authorization: "Bearer token_abc" },
      query: {
        encoding: "pcm_s16le",
        sample_rate: "44100",
        channels: "2",
        include_words: "true",
        include_confidence: "true",
      },
      body: createBinaryStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
    } as never);

    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = ctx.fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);

    expect(url).toBe(
      "https://api.reson8.dev/v1/speech-to-text/prerecorded?encoding=pcm_s16le&sample_rate=44100&channels=2&include_words=true&include_confidence=true",
    );
    expect(init?.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer token_abc");
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
    expect(Array.from(await readRequestBody(init))).toEqual([1, 2, 3, 4]);

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      text: "hello world",
      words: [{ text: "hello" }, { text: "world" }],
    });
  });

  test("validates prerecorded query parameters before calling the upstream API", async () => {
    const ctx = createReson8TestContext();

    const response = await ctx.fragment.callRoute("POST", "/speech-to-text/prerecorded", {
      query: { include_words: "sometimes" },
      body: createBinaryStream([new Uint8Array([1])]),
    } as never);

    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(response.type).toBe("error");
    if (response.type !== "error") {
      return;
    }

    expect(response.status).toBe(400);
    expect(response.error).toEqual({
      code: "INVALID_REQUEST",
      message: 'include_words must be "true" or "false".',
    });
  });

  test("maps unstructured upstream failures to INTERNAL_ERROR while preserving the upstream status", async () => {
    const ctx = createReson8TestContext();
    ctx.fetchMock.mockResolvedValue(
      new Response("upstream exploded", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    const response = await ctx.fragment.callRoute("POST", "/speech-to-text/prerecorded", {
      body: createBinaryStream([new Uint8Array([1, 2, 3])]),
    } as never);

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      return;
    }

    expect(response.status).toBe(500);
    expect(response.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "upstream exploded",
    });
  });
});
