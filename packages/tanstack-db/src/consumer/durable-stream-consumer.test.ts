import { describe, expect, it, vi } from "vitest";

import type { DurableStream, JsonBatch } from "@durable-streams/client";

import { DurableStreamConsumer } from "./durable-stream-consumer";

const createStream = (batch: JsonBatch<unknown>) => {
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const stream = {
    stream: vi.fn(async () => ({
      upToDate: batch.upToDate,
      closed,
      subscribeJson(handler: (value: JsonBatch<unknown>) => Promise<void>) {
        queueMicrotask(async () => {
          try {
            await handler(batch);
            resolveClosed();
          } catch (error) {
            rejectClosed(error as Error);
          }
        });
        return () => {};
      },
    })),
  } as unknown as DurableStream;
  return stream;
};

describe("DurableStreamConsumer", () => {
  it("processes a finite response through its up-to-date batch", async () => {
    const batch: JsonBatch<unknown> = {
      items: [{ type: "item" }],
      offset: "0000000000000000000000001",
      upToDate: true,
      streamClosed: false,
    };
    const stream = createStream(batch);
    const processBatch = vi.fn(async () => {});
    const consumer = new DurableStreamConsumer(stream);

    await consumer.consume({
      offset: "-1",
      mode: false,
      signal: new AbortController().signal,
      processBatch,
    });

    expect(processBatch).toHaveBeenCalledWith(batch);
    expect(stream.stream).toHaveBeenCalledWith({
      offset: "-1",
      live: false,
      json: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("propagates batch processing failures", async () => {
    const stream = createStream({
      items: [],
      offset: "0000000000000000000000001",
      upToDate: true,
      streamClosed: false,
    });
    const consumer = new DurableStreamConsumer(stream);
    const error = new Error("invalid batch");

    await expect(
      consumer.consume({
        offset: "-1",
        mode: false,
        signal: new AbortController().signal,
        processBatch: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });
});
