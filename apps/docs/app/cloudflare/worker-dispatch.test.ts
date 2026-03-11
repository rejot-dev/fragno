import { describe, expect, test } from "vitest";
import {
  buildCloudflareWorkerDispatchPath,
  buildCloudflareWorkerDispatchRequest,
  rewriteCloudflareWorkerDispatchUrl,
} from "./worker-dispatch";

describe("rewriteCloudflareWorkerDispatchUrl", () => {
  test("rewrites the route prefix away for nested paths", () => {
    const url = rewriteCloudflareWorkerDispatchUrl(
      "http://localhost:3000/__dev/workers/org-123/wilco/api/ping?mode=test",
      "org-123",
      "wilco",
    );

    expect(url.pathname).toBe("/api/ping");
    expect(url.search).toBe("?mode=test");
  });

  test("maps the app root to slash", () => {
    const url = rewriteCloudflareWorkerDispatchUrl(
      "http://localhost:3000/__dev/workers/org-123/wilco",
      "org-123",
      "wilco",
    );

    expect(url.pathname).toBe("/");
  });
});

describe("buildCloudflareWorkerDispatchRequest", () => {
  test("preserves explicit authorization while dropping same-origin sensitive headers", async () => {
    const request = new Request("http://localhost:3000/__dev/workers/org-123/wilco/hello", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc123",
        "content-type": "application/json",
        "x-forwarded-host": "localhost:3000",
      },
      body: JSON.stringify({ ok: true }),
    });

    const forwardedRequest = buildCloudflareWorkerDispatchRequest(
      request,
      "org-123",
      "wilco",
      "fragno-org-123-wilco-worker",
    );

    expect(forwardedRequest.url).toBe("http://localhost:3000/hello");
    expect(forwardedRequest.headers.get("authorization")).toBe("Bearer secret");
    expect(forwardedRequest.headers.get("cookie")).toBeNull();
    expect(forwardedRequest.headers.get("x-forwarded-host")).toBeNull();
    expect(forwardedRequest.headers.get("content-type")).toBe("application/json");
    expect(forwardedRequest.headers.get("x-fragno-worker-org-id")).toBe("org-123");
    expect(forwardedRequest.headers.get("x-fragno-worker-app-id")).toBe("wilco");
    expect(forwardedRequest.headers.get("x-fragno-worker-script-name")).toBe(
      "fragno-org-123-wilco-worker",
    );
    expect(await forwardedRequest.text()).toBe('{"ok":true}');
  });

  test("forwards aborts from the original client signal", () => {
    const abortController = new AbortController();
    const request = new Request("http://localhost:3000/__dev/workers/org-123/wilco/hello", {
      signal: abortController.signal,
    });

    const forwardedRequest = buildCloudflareWorkerDispatchRequest(
      request,
      "org-123",
      "wilco",
      "fragno-org-123-wilco-worker",
    );

    expect(forwardedRequest.signal.aborted).toBe(false);

    abortController.abort();

    expect(forwardedRequest.signal.aborted).toBe(true);
  });

  test("builds the expected dev route prefix", () => {
    expect(buildCloudflareWorkerDispatchPath("org-123", "wilco")).toBe(
      "/__dev/workers/org-123/wilco",
    );
  });
});
