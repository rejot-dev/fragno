import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { brotliDecompressSync, createBrotliDecompress } from "node:zlib";

import { acceptsBrotli, compressStreamingResponse } from "./flushing-brotli-response";

const encoder = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

/** A body the test writes to frame by frame, as the outbox stream does. */
function writableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled: unknown = "not cancelled";
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  return {
    body,
    write: (text: string) => {
      controller.enqueue(encoder.encode(text));
    },
    close: () => {
      controller.close();
    },
    cancelled: () => cancelled,
  };
}

/** Decompresses a brotli body as it arrives, collecting the text decoded so far. */
function decodeAsItArrives(body: ReadableStream<Uint8Array>) {
  const decompressor = createBrotliDecompress();
  let text = "";
  decompressor.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const reader = body.getReader();
  const done = (async () => {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      decompressor.write(result.value);
    }
    decompressor.end();
  })();
  return { text: () => text, done, reader };
}

const frames = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    JSON.stringify({ type: "entry", index, payload: "github ".repeat(500) }),
  ).map((frame) => `${frame}\n`);

describe("flushing brotli responses", () => {
  test("compresses the whole body losslessly and marks it brotli", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const text = frames(200).join("");
    const response = compressStreamingResponse(
      new Response(text, {
        headers: { "content-type": "application/x-ndjson", "content-length": `${text.length}` },
      }),
      "test.compression",
    );

    assert.equal(response.headers.get("content-encoding"), "br");
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert(!response.headers.has("content-length"));
    const compressed = new Uint8Array(await response.arrayBuffer());
    expect(brotliDecompressSync(compressed).toString("utf8")).toBe(text);
    expect(compressed.byteLength).toBeLessThan(text.length / 50);
    expect(console.info).toHaveBeenCalledWith(
      "test.compression",
      expect.objectContaining({ outcome: "ended", inputBytes: text.length }),
    );
  });

  test("sends a frame written on its own without waiting for more", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const source = writableBody();
    const decoded = decodeAsItArrives(
      compressStreamingResponse(new Response(source.body), "test.compression").body!,
    );

    const page = frames(50);
    for (const frame of page) {
      source.write(frame);
    }
    await vi.waitFor(() => {
      expect(decoded.text()).toBe(page.join(""));
    });
    source.write('{"type":"heartbeat"}\n');
    await vi.waitFor(() => {
      expect(decoded.text()).toBe(`${page.join("")}{"type":"heartbeat"}\n`);
    });

    source.close();
    await decoded.done;
  });

  test("cancels the body when the client cancels the compressed response", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const source = writableBody();
    const response = compressStreamingResponse(new Response(source.body), "test.compression");
    source.write(frames(1)[0]!);

    await response.body!.cancel("client went away");

    await vi.waitFor(() => {
      assert.equal(source.cancelled(), "client went away");
    });
    expect(console.info).toHaveBeenCalledWith(
      "test.compression",
      expect.objectContaining({ outcome: "cancelled" }),
    );
  });

  test("reads brotli support from accept-encoding", () => {
    const request = (acceptEncoding: string) =>
      new Request("https://backoffice.test/", { headers: { "accept-encoding": acceptEncoding } });

    assert(acceptsBrotli(request("gzip, deflate, br, zstd")));
    assert(acceptsBrotli(request("br;q=1.0, gzip;q=0.8")));
    assert(!acceptsBrotli(request("gzip, deflate")));
    assert(!acceptsBrotli(new Request("https://backoffice.test/")));
  });
});
