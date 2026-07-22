import { assert, describe, expect, it } from "vitest";

import type { FragnoOutboxEntry } from "./protocol";
import {
  createFetchFragnoOutboxStreamingTransport,
  createFragnoOutboxStreamUrl,
} from "./streaming-transport";

const entries: FragnoOutboxEntry[] = [
  {
    versionstamp: "000000000000000000000001",
    uowId: "uow-1",
    payload: { json: { version: 1, mutations: [] } },
  },
  {
    versionstamp: "000000000000000000000002",
    uowId: "uow-2",
    payload: { json: { version: 1, mutations: [] } },
  },
];

const streamResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
};

describe("Fragno streaming outbox transport", () => {
  it("consumes ordered NDJSON entries across arbitrary response chunks", async () => {
    let request: Request | undefined;
    let requestSignal: AbortSignal | null | undefined;
    const firstLine = `${JSON.stringify(entries[0])}\n`;
    const secondLine = JSON.stringify(entries[1]);
    const transport = createFetchFragnoOutboxStreamingTransport({
      internalUrl: "https://example.com/api/app/_internal?token=secret",
      fetch: async (input, init) => {
        request = new Request(input, init);
        requestSignal = init?.signal;
        return streamResponse([
          firstLine.slice(0, 17),
          firstLine.slice(17) + secondLine.slice(0, 9),
          `${secondLine.slice(9)}\n`,
        ]);
      },
    });
    const received: FragnoOutboxEntry[] = [];
    const abortController = new AbortController();

    await transport.stream({
      afterVersionstamp: "000000000000000000000000",
      limit: 25,
      signal: abortController.signal,
      onEntry: async (entry) => {
        await Promise.resolve();
        received.push(entry);
      },
    });

    expect(received).toEqual(entries);
    assert(request);
    assert(
      request.url ===
        "https://example.com/api/app/_internal/outbox/stream?token=secret&afterVersionstamp=000000000000000000000000&limit=25",
    );
    assert(requestSignal === abortController.signal);
  });

  it("cancels the response reader when the request is aborted", async () => {
    let responseCanceled = false;
    const transport = createFetchFragnoOutboxStreamingTransport({
      internalUrl: "https://example.com/_internal",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              responseCanceled = true;
            },
          }),
        ),
    });
    const abortController = new AbortController();
    const streaming = transport.stream({
      limit: 100,
      signal: abortController.signal,
      onEntry() {},
    });

    await Promise.resolve();
    abortController.abort();
    await streaming;

    assert(responseCanceled);
  });

  it("rejects malformed stream entries", async () => {
    const transport = createFetchFragnoOutboxStreamingTransport({
      internalUrl: "https://example.com/_internal",
      fetch: async () => streamResponse(['{"versionstamp":42}\n']),
    });

    await expect(
      transport.stream({
        limit: 100,
        signal: new AbortController().signal,
        onEntry() {},
      }),
    ).rejects.toThrow("Invalid Fragno outbox stream entry.");
  });

  it("reports unsuccessful stream responses", async () => {
    const transport = createFetchFragnoOutboxStreamingTransport({
      internalUrl: "https://example.com/_internal",
      fetch: async () => new Response(null, { status: 503, statusText: "Unavailable" }),
    });

    await expect(
      transport.stream({
        limit: 100,
        signal: new AbortController().signal,
        onEntry() {},
      }),
    ).rejects.toThrow("Fragno outbox stream request failed: 503 Unavailable");
  });
});

describe("Fragno streaming transport URLs", () => {
  it("derives the stream route without dropping endpoint query parameters", () => {
    assert(
      createFragnoOutboxStreamUrl("https://example.com/api/app/_internal?token=secret") ===
        "https://example.com/api/app/_internal/outbox/stream?token=secret",
    );
  });
});
