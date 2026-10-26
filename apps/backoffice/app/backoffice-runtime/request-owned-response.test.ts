import { assert, describe, expect, test } from "vitest";

import { forwardRequestOwnedResponse } from "./request-owned-response";

describe("request-owned response forwarding", () => {
  test("cancels the upstream response when the request is aborted", async () => {
    const requestController = new AbortController();
    let resolveCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve) => {
      resolveCancellation = resolve;
    });
    const upstreamResponse = new Response(
      new ReadableStream({
        cancel(reason) {
          resolveCancellation(reason);
        },
      }),
    );
    const request = new Request("https://backoffice.example/api/stream", {
      signal: requestController.signal,
    });

    const response = forwardRequestOwnedResponse(request, upstreamResponse);
    requestController.abort("request-disconnected");

    await expect(cancellation).resolves.toBe("request-disconnected");
    const reader = response.body?.getReader();
    assert(reader);
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });

  test("cancels the upstream response when the downstream consumer cancels", async () => {
    let resolveCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve) => {
      resolveCancellation = resolve;
    });
    const upstreamResponse = new Response(
      new ReadableStream({
        cancel(reason) {
          resolveCancellation(reason);
        },
      }),
      {
        status: 202,
        statusText: "Streaming",
        headers: { "x-stream-owner": "request" },
      },
    );
    const request = new Request("https://backoffice.example/api/stream");

    const response = forwardRequestOwnedResponse(request, upstreamResponse);
    assert(response.body);
    await response.body.cancel("consumer-closed");

    await expect(cancellation).resolves.toBe("consumer-closed");
    assert.equal(response.status, 202);
    assert.equal(response.statusText, "Streaming");
    assert.equal(response.headers.get("x-stream-owner"), "request");
  });

  test("reads ahead of the client up to its buffer", async () => {
    let pulls = 0;
    const upstreamResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(100_000));
        },
      }),
    );
    const request = new Request("https://backoffice.example/api/stream");

    const response = forwardRequestOwnedResponse(request, upstreamResponse);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // About one mebibyte of 100 kB chunks, with nothing read yet.
    expect(pulls).toBeGreaterThanOrEqual(10);
    expect(pulls).toBeLessThanOrEqual(13);
    await response.body?.cancel();
  });

  test("returns a response it already forwarded unchanged", () => {
    const request = new Request("https://backoffice.example/api/stream");
    const forwarded = forwardRequestOwnedResponse(
      request,
      new Response(new ReadableStream<Uint8Array>()),
    );

    assert.strictEqual(forwardRequestOwnedResponse(request, forwarded), forwarded);
  });

  test("returns responses without bodies unchanged", () => {
    const request = new Request("https://backoffice.example/api/empty");
    const response = new Response(null, { status: 204 });

    assert.strictEqual(forwardRequestOwnedResponse(request, response), response);
  });
});
