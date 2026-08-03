import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { createCloudflareApiClient } from "../cloudflare-api";
import { createBrowserRunQuickActions } from "./quick-actions";

const fetchMock = vi.fn<typeof fetch>();
const quickActions = createBrowserRunQuickActions(
  createCloudflareApiClient({
    apiToken: "cf_test_token",
    fetchImplementation: fetchMock,
  }),
  "acct_test",
);

const createCloudflareResponse = (result: unknown) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

const getRequestUrl = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const getRequestBody = (init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new Error("Expected the Cloudflare SDK to send a JSON request body.");
  }

  return JSON.parse(init.body) as unknown;
};

describe("Browser Run Quick Actions", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test("runs a stateless Quick Action with the fragment account", async () => {
    fetchMock.mockResolvedValueOnce(createCloudflareResponse("<h1>Rendered</h1>"));

    const content = await quickActions.content({ url: "https://example.com" });

    expect(content).toBe("<h1>Rendered</h1>");
    expect(fetchMock).toHaveBeenCalledOnce();

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(getRequestUrl(input)).toContain("/accounts/acct_test/browser-rendering/content");
    expect(getRequestBody(init)).toEqual({ url: "https://example.com" });
  });

  test("returns the raw screenshot response instead of parsing image bytes as text", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    fetchMock.mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const screenshot = await quickActions.screenshot({ html: "<h1>Hello</h1>" });

    expect(screenshot).toBeInstanceOf(Response);
    assert(screenshot.headers.get("content-type") === "image/png");
    expect(new Uint8Array(await screenshot.arrayBuffer())).toEqual(pngBytes);
  });

  test("starts, reads, and cancels crawl jobs", async () => {
    fetchMock
      .mockResolvedValueOnce(createCloudflareResponse("crawl_job"))
      .mockResolvedValueOnce(
        createCloudflareResponse({
          id: "crawl_job",
          browserSecondsUsed: 1,
          finished: 1,
          records: [],
          skipped: 0,
          status: "completed",
          total: 1,
        }),
      )
      .mockResolvedValueOnce(
        createCloudflareResponse({ job_id: "crawl_job", message: "cancelled" }),
      );

    await expect(quickActions.startCrawl({ url: "https://example.com" })).resolves.toBe(
      "crawl_job",
    );
    await expect(quickActions.getCrawl("crawl_job")).resolves.toMatchObject({
      id: "crawl_job",
      status: "completed",
    });
    await expect(quickActions.cancelCrawl("crawl_job")).resolves.toEqual({
      job_id: "crawl_job",
      message: "cancelled",
    });

    expect(fetchMock.mock.calls.map(([input]) => getRequestUrl(input))).toEqual([
      expect.stringContaining("/accounts/acct_test/browser-rendering/crawl"),
      expect.stringContaining("/accounts/acct_test/browser-rendering/crawl/crawl_job"),
      expect.stringContaining("/accounts/acct_test/browser-rendering/crawl/crawl_job"),
    ]);
  });
});
