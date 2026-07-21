import { describe, expect, it, assert } from "vitest";

import type { FragnoOutboxEntry } from "./protocol";
import {
  createFetchFragnoOutboxTransport,
  createFragnoOutboxRequestUrl,
  createFragnoOutboxUrl,
} from "./transport";

const entry: FragnoOutboxEntry = {
  versionstamp: "000000000000000000000001",
  uowId: "uow-1",
  payload: { json: { version: 1, mutations: [] } },
};

describe("Fragno fetch outbox transport", () => {
  it("retrieves the adapter identity from the internal describe route", async () => {
    let request: Request | undefined;
    let requestSignal: AbortSignal | null | undefined;
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      requestSignal = init?.signal;
      return Response.json({ adapterIdentity: "adapter-1" });
    };
    const transport = createFetchFragnoOutboxTransport({
      internalUrl: "https://example.com/api/app/_internal?token=secret",
      fetch: fetcher,
    });
    const abortController = new AbortController();

    await expect(transport.getAdapterIdentity({ signal: abortController.signal })).resolves.toBe(
      "adapter-1",
    );
    assert(request);
    assert(request.url === "https://example.com/api/app/_internal?token=secret");
    expect(requestSignal).toBe(abortController.signal);
  });

  it("rejects malformed internal describe responses", async () => {
    const transport = createFetchFragnoOutboxTransport({
      internalUrl: "https://example.com/_internal",
      fetch: async () => Response.json({ adapterIdentity: 42 }),
    });

    await expect(
      transport.getAdapterIdentity({ signal: new AbortController().signal }),
    ).rejects.toThrow("Invalid Fragno internal describe response.");
  });

  it("retrieves typed outbox entries from the internal outbox route", async () => {
    let request: Request | undefined;
    let requestSignal: AbortSignal | null | undefined;
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      requestSignal = init?.signal;
      return Response.json([entry]);
    };
    const transport = createFetchFragnoOutboxTransport({
      internalUrl: "https://example.com/api/app/_internal?token=secret",
      fetch: fetcher,
    });
    const abortController = new AbortController();

    await expect(
      transport.list({
        afterVersionstamp: "000000000000000000000000",
        limit: 100,
        signal: abortController.signal,
      }),
    ).resolves.toEqual([entry]);
    assert(request);
    assert(
      request.url ===
        "https://example.com/api/app/_internal/outbox?token=secret&afterVersionstamp=000000000000000000000000&limit=100",
    );
    expect(requestSignal).toBe(abortController.signal);
  });

  it("reports unsuccessful outbox responses", async () => {
    const transport = createFetchFragnoOutboxTransport({
      internalUrl: "https://example.com/_internal",
      fetch: async () => new Response(null, { status: 503, statusText: "Unavailable" }),
    });

    await expect(
      transport.list({ limit: 100, signal: new AbortController().signal }),
    ).rejects.toThrow("Fragno outbox request failed: 503 Unavailable");
  });
});

describe("Fragno transport URLs", () => {
  it("derives the outbox route without dropping endpoint query parameters", () => {
    assert(
      createFragnoOutboxUrl("https://example.com/api/app/_internal?token=secret") ===
        "https://example.com/api/app/_internal/outbox?token=secret",
    );
  });

  it("sets cursor pagination without discarding existing query parameters", () => {
    assert(
      createFragnoOutboxRequestUrl("https://example.com/_internal/outbox?token=secret", {
        afterVersionstamp: "000000000000000000000001",
        limit: 500,
      }) ===
        "https://example.com/_internal/outbox?token=secret&afterVersionstamp=000000000000000000000001&limit=500",
    );
  });
});
