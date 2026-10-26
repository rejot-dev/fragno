import { once } from "node:events";
import { constants, createBrotliCompress } from "node:zlib";

// Quality 4 with a 4 MiB window kept the ReJot outbox's GitHub payloads to 1/66 of their size for
// about 1.5 ms of CPU per megabyte; higher qualities cost several times more for a few percent.
const BROTLI_QUALITY = 4;
const BROTLI_WINDOW_BITS = 22;

/**
 * Compresses a streamed response with brotli, flushing whenever its body pauses, so a frame that
 * is written on its own, such as a heartbeat or a live entry, reaches the client at once instead of
 * waiting in the compressor. Workers compress a response with a `content-encoding` header
 * themselves, but hold every byte until the body ends.
 *
 * The compressed body keeps backpressure: when the client stops reading, the compressor stops
 * reading the body, so the stream behind it notices. Cancelling it cancels the body.
 */
export function compressStreamingResponse(response: Response, label: string): Response {
  if (!response.body) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "br");
  headers.delete("content-length");
  headers.append("vary", "accept-encoding");
  return new Response(response.body.pipeThrough(createFlushingBrotliStream(label)), {
    status: response.status,
    statusText: response.statusText,
    headers,
    // The body is already brotli; without this, the runtime would compress it again.
    encodeBody: "manual",
  });
}

/** Whether a request's `accept-encoding` lists brotli. */
export function acceptsBrotli(request: Request): boolean {
  return (request.headers.get("accept-encoding") ?? "")
    .split(",")
    .some((encoding) => encoding.trim().split(";")[0]?.trim().toLowerCase() === "br");
}

function createFlushingBrotliStream(label: string): TransformStream<Uint8Array, Uint8Array> {
  const compressor = createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: BROTLI_WINDOW_BITS,
    },
  });
  let inputBytes = 0;
  let outputBytes = 0;
  let flushes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let logged = false;
  const logCompression = (outcome: "ended" | "cancelled" | "failed") => {
    if (logged) {
      return;
    }
    logged = true;
    console.info(label, { outcome, inputBytes, outputBytes, flushes });
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      compressor.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      compressor.on("error", (error) => {
        clearTimeout(flushTimer);
        logCompression("failed");
        controller.error(error);
      });
    },
    async transform(chunk) {
      clearTimeout(flushTimer);
      inputBytes += chunk.byteLength;
      await new Promise<void>((resolve, reject) => {
        compressor.write(chunk, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      // Frames written together, such as a page of entries, arrive within one task; a timer runs
      // only once the body pauses, so the page is compressed as a whole and then sent.
      flushTimer = setTimeout(() => {
        flushes += 1;
        compressor.flush();
      }, 0);
    },
    async flush() {
      clearTimeout(flushTimer);
      const ended = once(compressor, "end");
      compressor.end();
      await ended;
      logCompression("ended");
    },
    cancel() {
      clearTimeout(flushTimer);
      compressor.destroy();
      logCompression("cancelled");
    },
  });
}
