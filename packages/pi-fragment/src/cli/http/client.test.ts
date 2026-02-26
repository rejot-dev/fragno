import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpClient } from "./client";

describe("http client", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("retries on 500 responses and returns the first success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = createHttpClient({
      baseUrl: "https://example.com",
      timeoutMs: 1000,
      retries: 1,
      retryDelayMs: 0,
      fetch: fetchMock,
    });

    const response = await client.request({ method: "GET", path: "/sessions" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("retries on 429 responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const client = createHttpClient({
      baseUrl: "https://example.com",
      timeoutMs: 1000,
      retries: 2,
      retryDelayMs: 0,
      fetch: fetchMock,
    });

    const response = await client.request({ method: "GET", path: "sessions" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("times out requests", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const client = createHttpClient({
      baseUrl: "https://example.com",
      timeoutMs: 10,
      retries: 0,
      retryDelayMs: 0,
      fetch: fetchMock,
    });

    const promise = client.request({ method: "GET", path: "/sessions" });
    const assertion = expect(promise).rejects.toThrow("Request timed out after 10ms");

    await vi.advanceTimersByTimeAsync(10);

    await assertion;
  });

  it("does not retry non-retryable responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const client = createHttpClient({
      baseUrl: "https://example.com",
      timeoutMs: 1000,
      retries: 3,
      retryDelayMs: 0,
      fetch: fetchMock,
    });

    const response = await client.request({ method: "GET", path: "/sessions" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
  });
});
