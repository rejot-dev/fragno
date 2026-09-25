import { assert, describe, expect, it } from "vitest";

import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

import { consumeNdjsonOutboxStream } from "../outbox-stream";
import { FragnoOutboxTransportError } from "../outbox-transport-error";
import { FragnoInternalFetcher } from "./fragno-internal-fetcher";

const baseUrl = "http://outbox-fetcher.test/fragment";

describe("outbox stream fetch failure classification", () => {
  it("classifies real HTTP disconnects both before and after response headers", async () => {
    const streamingResponse = Promise.withResolvers<ServerResponse>();
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/disconnect")) {
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        JSON.stringify({
          type: "started",
          protocolVersion: 1,
          adapterIdentity: "http-test",
          catchUpTargetVersionstamp: null,
          catchUpPageSize: 50,
        }) + "\n",
      );
      streamingResponse.resolve(response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const httpBaseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const disconnected = new FragnoInternalFetcher({
        baseUrl: `${httpBaseUrl}/disconnect`,
        fetch: globalThis.fetch,
      });
      await expect(disconnected.openOutboxStream({})).rejects.toBeInstanceOf(
        FragnoOutboxTransportError,
      );
      const fetcher = new FragnoInternalFetcher({ baseUrl: httpBaseUrl, fetch: globalThis.fetch });
      const body = await fetcher.openOutboxStream({});
      const response = await streamingResponse.promise;
      await expect(
        consumeNdjsonOutboxStream(body, {
          signal: new AbortController().signal,
          afterVersionstamp: undefined,
          onFrame() {
            response.destroy();
          },
        }),
      ).rejects.toBeInstanceOf(FragnoOutboxTransportError);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it.each([new TypeError("fetch failed"), new DOMException("Offline", "NetworkError")])(
    "classifies a Fetch network rejection as transport: %s",
    async (cause) => {
      const fetcher = new FragnoInternalFetcher({
        baseUrl,
        fetch: async () => {
          throw cause;
        },
      });
      const opened = fetcher.openOutboxStream({});
      await expect(opened).rejects.toBeInstanceOf(FragnoOutboxTransportError);
      await expect(opened).rejects.toMatchObject({ cause });
    },
  );

  it.each([new Error("Fetch wrapper failed"), new DOMException("Unexpected abort", "AbortError")])(
    "preserves an unclassified failure: %s",
    async (failure) => {
      const fetcher = new FragnoInternalFetcher({
        baseUrl,
        fetch: async () => {
          throw failure;
        },
      });
      await expect(fetcher.openOutboxStream({})).rejects.toBe(failure);
    },
  );

  it("does not classify cancellation as a network interruption", async () => {
    const abort = new AbortController();
    const failure = new TypeError("fetch failed");
    const fetcher = new FragnoInternalFetcher({
      baseUrl,
      fetch: async () => {
        abort.abort();
        throw failure;
      },
    });
    await expect(fetcher.openOutboxStream({ signal: abort.signal })).rejects.toBe(failure);
  });

  it("rejects invalid requests before invoking Fetch", async () => {
    let requests = 0;
    const fetcher = new FragnoInternalFetcher({
      baseUrl: "http://user:password@outbox-fetcher.test/fragment",
      fetch: async () => {
        requests++;
        return new Response();
      },
    });
    const opened = fetcher.openOutboxStream({});
    await expect(opened).rejects.toBeInstanceOf(TypeError);
    await expect(opened).rejects.not.toBeInstanceOf(FragnoOutboxTransportError);
    assert(requests === 0);
    expect(
      () => new FragnoInternalFetcher({ baseUrl: "file:///outbox", fetch: globalThis.fetch }),
    ).toThrow("HTTP(S)");
  });

  it("treats an HTTP success without a stream body as terminal", async () => {
    const fetcher = new FragnoInternalFetcher({
      baseUrl,
      fetch: async () => new Response(null, { status: 204 }),
    });
    const opened = fetcher.openOutboxStream({});
    await expect(opened).rejects.toThrow("has no body");
    await expect(opened).rejects.not.toBeInstanceOf(FragnoOutboxTransportError);
  });
});
