import { parseOutboxStreamFrame, type OutboxStreamEntry } from "@fragno-dev/db/outbox-stream";

/** Emits only entries; callers retain each successful cursor even if a later frame fails. */
export async function consumeAutomationOutboxStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEntry: (entry: OutboxStreamEntry) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let started = false;
  let rotated = false;
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  if (signal.aborted) {
    cancelReader();
  } else {
    signal.addEventListener("abort", cancelReader, { once: true });
  }
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while (!signal.aborted && (newline = buffer.indexOf("\n")) !== -1) {
        const frame = parseOutboxStreamFrame(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        if (rotated || (!started && frame.type !== "started")) {
          throw new Error("Invalid Automations outbox stream frame order.");
        }
        if (frame.type === "started") {
          if (started) {
            throw new Error("Duplicate Automations outbox started frame.");
          }
          started = true;
        } else if (frame.type === "entry") {
          await onEntry(frame.entry);
        } else if (frame.type === "rotate") {
          rotated = true;
        }
      }
    }
    buffer += decoder.decode();
    if (!signal.aborted && (!rotated || buffer.length > 0)) {
      throw new Error("Automations outbox stream closed unexpectedly.");
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!completed) {
      await reader.cancel(signal.reason).catch(() => {});
    }
    reader.releaseLock();
  }
}
