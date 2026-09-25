import { describe, expect, it, assert } from "vitest";

import { consumeAutomationOutboxStream } from "./automation-outbox-stream";

const entry = {
  versionstamp: "000000000000000000000001",
  uowId: "uow-1",
  payload: { json: { value: "你好 🧪" } },
};
const started = {
  type: "started",
  protocolVersion: 1,
  adapterIdentity: "source",
  catchUpTargetVersionstamp: entry.versionstamp,
  catchUpPageSize: 50,
};
function stream(frames: unknown[]) {
  const bytes = new TextEncoder().encode(
    frames.map((frame) => JSON.stringify(frame) + "\n").join(""),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
      controller.close();
    },
  });
}
describe("Automations CLI outbox stream", () => {
  it("prints only entries while handling control frames and fragmented UTF-8", async () => {
    const received: unknown[] = [];
    await consumeAutomationOutboxStream(
      stream([
        started,
        { type: "entry", entry },
        { type: "caught-up", throughVersionstamp: entry.versionstamp },
        { type: "heartbeat" },
        { type: "rotate", reason: "lease-expired" },
      ]),
      new AbortController().signal,
      async (value) => {
        received.push(value);
      },
    );
    expect(received).toEqual([entry]);
  });
  it("retains successful entry progress when EOF interrupts the response", async () => {
    let cursor: string | undefined;
    await expect(
      consumeAutomationOutboxStream(
        stream([started, { type: "entry", entry }]),
        new AbortController().signal,
        async (value) => {
          cursor = value.versionstamp;
        },
      ),
    ).rejects.toThrow("closed unexpectedly");
    expect(cursor).toBe(entry.versionstamp);
  });
  it("cancels an idle read on shutdown", async () => {
    let cancelled = false;
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const consuming = consumeAutomationOutboxStream(body, abort.signal, async () => {});
    abort.abort();
    await consuming;
    assert(cancelled);
    assert(!body.locked);
  });
});
