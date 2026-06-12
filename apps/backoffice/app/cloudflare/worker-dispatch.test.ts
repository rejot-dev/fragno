import { describe, expect, test, assert } from "vitest";

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

    assert(url.pathname === "/api/ping");
    assert(url.search === "?mode=test");
  });

  test("maps the app root to slash", () => {
    const url = rewriteCloudflareWorkerDispatchUrl(
      "http://localhost:3000/__dev/workers/org-123/wilco",
      "org-123",
      "wilco",
    );

    assert(url.pathname === "/");
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

    assert(forwardedRequest.url === "http://localhost:3000/hello");
    assert(forwardedRequest.headers.get("authorization") === "Bearer secret");
    expect(forwardedRequest.headers.get("cookie")).toBeNull();
    expect(forwardedRequest.headers.get("x-forwarded-host")).toBeNull();
    assert(forwardedRequest.headers.get("content-type") === "application/json");
    assert(forwardedRequest.headers.get("x-fragno-worker-org-id") === "org-123");
    assert(forwardedRequest.headers.get("x-fragno-worker-app-id") === "wilco");
    assert(
      forwardedRequest.headers.get("x-fragno-worker-script-name") === "fragno-org-123-wilco-worker",
    );
    assert((await forwardedRequest.text()) === '{"ok":true}');
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

    assert(!forwardedRequest.signal.aborted);

    abortController.abort();

    assert(forwardedRequest.signal.aborted);
  });

  test("builds the expected dev route prefix", () => {
    assert(
      buildCloudflareWorkerDispatchPath("org-123", "wilco") === "/__dev/workers/org-123/wilco",
    );
  });
});
