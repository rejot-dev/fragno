import { parseOutboxStreamFrame, type OutboxStreamFrame } from "@fragno-dev/db/outbox-stream";

import { FragnoOutboxTransportError, rethrowOutboxNetworkFailure } from "./outbox-transport-error";

/** Protocol violations are terminal: retrying cannot repair an incompatible or changed source. */
export class FragnoOutboxProtocolError extends Error {}

type FragnoOutboxStreamConsumer = {
  signal: AbortSignal;
  afterVersionstamp: string | undefined;
  onFrame(frame: OutboxStreamFrame): void | Promise<void>;
};

/** Consumes one ordered stream session; only a final rotate frame permits normal completion. */
export async function consumeNdjsonOutboxStream(
  body: ReadableStream<Uint8Array>,
  consumer: FragnoOutboxStreamConsumer,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let started = false;
  let caughtUp = false;
  let rotated = false;
  let target: string | null = null;
  let previousVersionstamp = consumer.afterVersionstamp;
  const cancelReader = () => {
    void reader.cancel(consumer.signal.reason).catch(() => {});
  };
  if (consumer.signal.aborted) {
    cancelReader();
  } else {
    consumer.signal.addEventListener("abort", cancelReader, { once: true });
  }

  async function consumeFrame(line: string): Promise<void> {
    let frame: OutboxStreamFrame;
    try {
      frame = parseOutboxStreamFrame(JSON.parse(line));
    } catch (cause) {
      throw new FragnoOutboxProtocolError("Invalid Fragno outbox stream frame.", { cause });
    }
    if (rotated || (!started && frame.type !== "started")) {
      throw new FragnoOutboxProtocolError("Invalid Fragno outbox stream frame order.");
    }
    switch (frame.type) {
      case "started":
        if (started) {
          throw new FragnoOutboxProtocolError("Duplicate Fragno outbox started frame.");
        }
        started = true;
        target = frame.catchUpTargetVersionstamp;
        break;
      case "entry":
        if (
          (previousVersionstamp !== undefined &&
            frame.entry.versionstamp <= previousVersionstamp) ||
          (!caughtUp && (target === null || frame.entry.versionstamp > target))
        ) {
          throw new FragnoOutboxProtocolError(
            "Fragno outbox stream entries are not strictly ordered around the catch-up boundary.",
          );
        }
        previousVersionstamp = frame.entry.versionstamp;
        break;
      case "caught-up":
        if (
          caughtUp ||
          frame.throughVersionstamp !== target ||
          (target !== null && previousVersionstamp !== target)
        ) {
          throw new FragnoOutboxProtocolError("Invalid Fragno outbox caught-up boundary.");
        }
        caughtUp = true;
        break;
      case "rotate":
        rotated = true;
        break;
      case "heartbeat":
        break;
    }
    await consumer.onFrame(frame);
  }

  try {
    while (!consumer.signal.aborted) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        rethrowOutboxNetworkFailure(cause, consumer.signal);
      }
      const { done, value } = result;
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while (!consumer.signal.aborted && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await consumeFrame(line);
      }
    }
    if (consumer.signal.aborted) {
      throw new DOMException("Fragno outbox streaming was aborted.", "AbortError");
    }
    buffer += decoder.decode();
    if (!rotated) {
      throw new FragnoOutboxTransportError("Fragno outbox stream closed unexpectedly.");
    }
    if (buffer.length > 0) {
      throw new FragnoOutboxProtocolError("Fragno outbox stream contains data after rotation.");
    }
  } finally {
    consumer.signal.removeEventListener("abort", cancelReader);
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
