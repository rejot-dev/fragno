import { assert, describe, expect, test } from "vitest";

import { forwardRequestOwnedResponse } from "./request-owned-response";

const encoder = new TextEncoder();

function upstreamBody(chunks: string[], onCancel?: (reason: unknown) => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

describe("request-owned response forwarding in workerd", () => {
  test("forwards the whole body in order", async () => {
    const chunks = Array.from({ length: 200 }, (_, index) => `${index}:${"x".repeat(10_000)}\n`);
    const response = forwardRequestOwnedResponse(
      new Request("https://backoffice.example/api/stream"),
      new Response(upstreamBody(chunks), { headers: { "content-type": "application/x-ndjson" } }),
    );

    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    expect(await response.text()).toBe(chunks.join(""));
  });

  test("cancels the upstream body when the request is aborted", async () => {
    const requestController = new AbortController();
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const response = forwardRequestOwnedResponse(
      new Request("https://backoffice.example/api/stream", { signal: requestController.signal }),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled();
          },
        }),
      ),
    );

    requestController.abort("request-disconnected");

    await cancellation;
    const reader = response.body?.getReader();
    assert(reader);
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test("cancels the upstream body when the client cancels", async () => {
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const response = forwardRequestOwnedResponse(
      new Request("https://backoffice.example/api/stream"),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled();
          },
        }),
      ),
    );

    assert(response.body);
    await response.body.cancel("consumer-closed");
    await cancellation;
  });

  test("reports an upstream failure as an error, not as the end of the body", async () => {
    const response = forwardRequestOwnedResponse(
      new Request("https://backoffice.example/api/stream"),
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial"));
            controller.error(new Error("upstream failed"));
          },
        }),
      ),
    );

    await expect(response.text()).rejects.toThrow();
  });
});
