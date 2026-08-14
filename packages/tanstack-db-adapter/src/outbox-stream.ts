import type { FragnoOutboxEntry } from "./protocol";

type FragnoOutboxStreamConsumer = {
  signal: AbortSignal;
  onEntry(entry: FragnoOutboxEntry): void | Promise<void>;
};

export async function consumeNdjsonOutboxStream(
  body: ReadableStream<Uint8Array>,
  consumer: FragnoOutboxStreamConsumer,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onEntry = (entry: FragnoOutboxEntry) => consumer.onEntry(entry);
  let buffer = "";
  let completed = false;
  const cancelReader = () => {
    void reader.cancel(consumer.signal.reason).catch(() => {});
  };
  if (consumer.signal.aborted) {
    cancelReader();
  } else {
    consumer.signal.addEventListener("abort", cancelReader, { once: true });
  }

  try {
    while (!consumer.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await consumeOutboxLine(line, onEntry);
      }
    }

    if (!consumer.signal.aborted) {
      buffer += decoder.decode();
      await consumeOutboxLine(buffer, onEntry);
    }
  } finally {
    consumer.signal.removeEventListener("abort", cancelReader);
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

async function consumeOutboxLine(
  line: string,
  onEntry: FragnoOutboxStreamConsumer["onEntry"],
): Promise<void> {
  if (!line.trim()) {
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Invalid JSON in Fragno outbox stream.", { cause: error });
  }

  if (!isFragnoOutboxEntry(value)) {
    throw new Error("Invalid Fragno outbox stream entry.");
  }

  await onEntry(value);
}

function isFragnoOutboxEntry(value: unknown): value is FragnoOutboxEntry {
  return (
    isRecord(value) &&
    typeof value["versionstamp"] === "string" &&
    typeof value["uowId"] === "string" &&
    "payload" in value &&
    (value["refMap"] === undefined || isRecord(value["refMap"]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
