import { describe, expect, test, vi, assert } from "vitest";

import { createBrowserRunCaptureClient } from "./client";

describe("createBrowserRunCaptureClient", () => {
  test("returns the raw capture response", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    );
    const capture = createBrowserRunCaptureClient({
      buildUrl: (path) => `https://example.test/api/cloudflare${path}`,
      fetcher,
      defaultOptions: { headers: { authorization: "Bearer test" } },
    });

    const response = await capture({
      action: "screenshot",
      input: { html: "<h1>Hello</h1>" },
    });

    assert(response.headers.get("content-type") === "image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://example.test/api/cloudflare/browser-run/capture");
    assert(init?.method === "POST");
    assert(new Headers(init?.headers).get("authorization") === "Bearer test");
    assert(new Headers(init?.headers).get("content-type") === "application/json");
    expect(init?.body).toBe(
      JSON.stringify({ action: "screenshot", input: { html: "<h1>Hello</h1>" } }),
    );
  });
});
