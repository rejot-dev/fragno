import { assert, describe, expect, test, vi } from "vitest";

import { brotliDecompressSync, createBrotliDecompress } from "node:zlib";

import { compressStreamingResponse } from "./flushing-brotli-response";

const encoder = new TextEncoder();

const frames = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `${JSON.stringify({ type: "entry", index, payload: "github ".repeat(500) })}\n`,
  );

describe("flushing brotli responses in workerd", () => {
  test("compresses the whole body losslessly", async () => {
    const text = frames(200).join("");
    const response = compressStreamingResponse(new Response(text), "test.compression");

    assert.equal(response.headers.get("content-encoding"), "br");
    // Reading the body of a manually encoded response yields the encoded bytes.
    const compressed = new Uint8Array(await response.arrayBuffer());
    expect(brotliDecompressSync(compressed).toString("utf8")).toBe(text);
    expect(compressed.byteLength).toBeLessThan(text.length / 50);
  });

  test("sends a frame written on its own without waiting for more", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const response = compressStreamingResponse(new Response(body), "test.compression");
    const decompressor = createBrotliDecompress();
    let text = "";
    decompressor.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    const reader = response.body!.getReader();
    const reading = (async () => {
      for (let result = await reader.read(); !result.done; result = await reader.read()) {
        decompressor.write(result.value);
      }
    })();

    const page = frames(50);
    for (const frame of page) {
      controller.enqueue(encoder.encode(frame));
    }
    await vi.waitFor(() => {
      expect(text).toBe(page.join(""));
    });
    controller.enqueue(encoder.encode('{"type":"heartbeat"}\n'));
    await vi.waitFor(() => {
      expect(text).toBe(`${page.join("")}{"type":"heartbeat"}\n`);
    });

    controller.close();
    await reading;
  });
});
