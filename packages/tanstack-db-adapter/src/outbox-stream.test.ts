import { describe, expect, it, assert } from "vitest";

import type { OutboxStreamFrame } from "@fragno-dev/db/outbox-stream";

import { consumeNdjsonOutboxStream, FragnoOutboxProtocolError } from "./outbox-stream";
import { FragnoOutboxTransportError } from "./outbox-transport-error";

const versionstamp = "000000000000000000010000";
const started: OutboxStreamFrame = {
  type: "started",
  protocolVersion: 1,
  adapterIdentity: "source",
  catchUpTargetVersionstamp: versionstamp,
  catchUpPageSize: 50,
};
const entry: OutboxStreamFrame = {
  type: "entry",
  entry: { versionstamp, uowId: "uow-1", payload: { json: { text: "你好 🧪" } } },
};
const caughtUp: OutboxStreamFrame = { type: "caught-up", throughVersionstamp: versionstamp };
const rotate: OutboxStreamFrame = { type: "rotate", reason: "lease-expired" };
function stream(frames: unknown[], fragmentBytes = false) {
  const bytes = new TextEncoder().encode(
    frames.map((frame) => JSON.stringify(frame) + "\n").join(""),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (fragmentBytes) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte));
        }
      } else {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}
function consume(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: OutboxStreamFrame) => void | Promise<void> = () => {},
) {
  return consumeNdjsonOutboxStream(body, {
    signal: new AbortController().signal,
    afterVersionstamp: undefined,
    onFrame,
  });
}

describe("framed outbox stream consumer", () => {
  it.each([false, true])(
    "preserves frame order and fragmented UTF-8 (fragmentBytes=%s)",
    async (fragmentBytes) => {
      const frames = [started, { type: "heartbeat" } as const, entry, caughtUp, rotate];
      const received: OutboxStreamFrame[] = [];
      await consume(stream(frames, fragmentBytes), async (frame) => {
        await Promise.resolve();
        received.push(frame);
      });
      expect(received).toEqual(frames);
    },
  );

  it.each([
    [entry],
    [started, started],
    [started, caughtUp],
    [started, entry, entry],
    [started, entry, { type: "caught-up", throughVersionstamp: null }],
    [started, entry, caughtUp, caughtUp],
    [started, rotate, entry],
    [{ ...started, protocolVersion: 2 }],
    [{ ...started, catchUpTargetVersionstamp: undefined }],
    [started, { type: "entry", entry: { versionstamp, uowId: "x", payload: null } }],
    [started, { type: "unknown" }],
  ])("rejects malformed frames or illegal ordering: %j", async (...frames) => {
    await expect(consume(stream(frames))).rejects.toBeInstanceOf(FragnoOutboxProtocolError);
  });

  it("does not accept an entry newer than the fixed target before caught-up", async () => {
    const newer = {
      type: "entry",
      entry: { ...entry.entry, versionstamp: "000000000000000000020000" },
    };
    await expect(consume(stream([started, entry, newer, caughtUp, rotate]))).rejects.toThrow(
      "catch-up boundary",
    );
    await expect(
      consume(stream([started, entry, caughtUp, newer, rotate])),
    ).resolves.toBeUndefined();
  });

  it("rejects EOF without rotation and does not apply a truncated final frame", async () => {
    await expect(consume(stream([started, entry, caughtUp]))).rejects.toBeInstanceOf(
      FragnoOutboxTransportError,
    );
    const received: OutboxStreamFrame[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(started) + "\n" + JSON.stringify(entry)),
        );
        controller.close();
      },
    });
    await expect(
      consume(body, (frame) => {
        received.push(frame);
      }),
    ).rejects.toBeInstanceOf(FragnoOutboxTransportError);
    expect(received).toEqual([started]);
  });

  it.each([new TypeError("terminated"), new DOMException("Connection lost", "NetworkError")])(
    "classifies reader network failures as transport: %s",
    async (cause) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(cause);
        },
      });
      const consumed = consume(body);
      await expect(consumed).rejects.toBeInstanceOf(FragnoOutboxTransportError);
      await expect(consumed).rejects.toMatchObject({ cause });
      assert(!body.locked);
    },
  );

  it("does not retry an unclassified reader failure", async () => {
    const failure = new Error("Custom response transformation failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    await expect(consume(body)).rejects.toBe(failure);
    assert(!body.locked);
  });

  it("treats trailing data after rotation as a protocol violation", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [started, rotate].map((frame) => JSON.stringify(frame) + "\n").join("") + '{"type":',
          ),
        );
        controller.close();
      },
    });
    await expect(consume(body)).rejects.toBeInstanceOf(FragnoOutboxProtocolError);
  });

  it("stops within a multi-frame chunk when the consumer aborts", async () => {
    const abort = new AbortController();
    const received: OutboxStreamFrame[] = [];
    const body = stream([started, entry, caughtUp, rotate]);
    await expect(
      consumeNdjsonOutboxStream(body, {
        signal: abort.signal,
        afterVersionstamp: undefined,
        onFrame(frame) {
          received.push(frame);
          abort.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toEqual([started]);
    assert(!body.locked);
  });

  it.each([
    new Error("apply failed"),
    new TypeError("bad decoded value"),
    new DOMException("callback abort", "AbortError"),
  ])("preserves application failures and cancels the reader: %s", async (failure) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(started) + "\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      consume(body, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    assert(cancelled);
    assert(!body.locked);
  });
});
