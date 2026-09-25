import type { OutboxStreamEntry, OutboxStreamFrame } from "@fragno-dev/db/outbox-stream";

/** Creates a finite protocol session with planned rotation or an interrupted EOF. */
export function createOutboxTestStream(
  entries: readonly OutboxStreamEntry[],
  liveEntries: readonly OutboxStreamEntry[] = [],
  completion: "rotate" | "interrupt" = "rotate",
): ReadableStream<Uint8Array> {
  const target = entries.at(-1)?.versionstamp ?? null;
  const frames: OutboxStreamFrame[] = [
    {
      type: "started",
      protocolVersion: 1,
      adapterIdentity: "test-adapter",
      catchUpTargetVersionstamp: target,
      catchUpPageSize: 50,
    },
    ...entries.map((entry): OutboxStreamFrame => ({ type: "entry", entry })),
    { type: "caught-up", throughVersionstamp: target },
    ...liveEntries.map((entry): OutboxStreamFrame => ({ type: "entry", entry })),
    ...(completion === "rotate" ? [{ type: "rotate", reason: "lease-expired" } as const] : []),
  ];
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
      }
      controller.close();
    },
  });
}
