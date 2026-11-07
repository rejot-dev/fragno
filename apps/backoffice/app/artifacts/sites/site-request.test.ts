import { assert, test } from "vitest";

import { siteProbeResponse } from "./site-request";

const KEPT = 64 * 1024;

/**
 * A body that sends `chunk` for as long as it is read, a task at a time as a network would, and
 * records whether it was cancelled.
 */
function endless(chunk: Uint8Array) {
  const stream = { cancelled: false, sent: 0 };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      stream.sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      stream.cancelled = true;
    },
  });
  return { body, stream };
}

test("a body that never ends is read only past what is kept, then cancelled", async () => {
  const { body, stream } = endless(new TextEncoder().encode("data: tick\n\n".repeat(100)));
  // The deadline only ends the test should the read not stop by itself.
  const answer = await siteProbeResponse(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    AbortSignal.timeout(2000),
  );
  assert.deepInclude(answer.body, { truncated: true });
  assert.equal((answer.body as { text: string }).text.length, KEPT);
  assert.isTrue(stream.cancelled);
  assert.isBelow(stream.sent, KEPT + 1200);
});

test("a body that stops sending is cut when the deadline passes", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const answer = await siteProbeResponse(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    AbortSignal.timeout(20),
  );
  assert.deepEqual(answer.body, { text: "data: first\n\n", truncated: true });
  assert.isNull(answer.bodyError);
  assert.isTrue(cancelled);
});

test("a binary body gives its size, or its declared size when it is too long to read", async () => {
  const binary = { "content-type": "application/octet-stream" };
  const signal = new AbortController().signal;
  assert.deepEqual(
    (await siteProbeResponse(new Response(new Uint8Array(10), { headers: binary }), signal)).body,
    { omitted: { type: "application/octet-stream", bytes: 10 } },
  );
  const long = endless(new Uint8Array(4096));
  assert.deepEqual(
    (await siteProbeResponse(new Response(long.body, { headers: binary }), signal)).body,
    { omitted: { type: "application/octet-stream", bytes: null } },
  );
  const declared = endless(new Uint8Array(4096));
  assert.deepEqual(
    (
      await siteProbeResponse(
        new Response(declared.body, { headers: { ...binary, "content-length": "5000000" } }),
        signal,
      )
    ).body,
    { omitted: { type: "application/octet-stream", bytes: 5_000_000 } },
  );
});

test("a body that breaks off keeps the status and headers, what arrived, and why", async () => {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new Error("The upstream connection reset."));
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode("<h1>Hal"));
    },
  });
  const answer = await siteProbeResponse(
    new Response(body, { headers: { "content-type": "text/html" } }),
    new AbortController().signal,
  );
  assert.deepEqual(answer, {
    status: 200,
    headers: { "content-type": "text/html" },
    body: { text: "<h1>Hal", truncated: true },
    bodyError: "The upstream connection reset.",
  });
});
