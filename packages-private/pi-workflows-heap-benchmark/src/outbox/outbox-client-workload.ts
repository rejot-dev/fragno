import type {
  OutboxBenchmarkClientConfig,
  OutboxBenchmarkClientResult,
} from "./outbox-benchmark-protocol";

type OpenOutboxClientWorkload = {
  result: OutboxBenchmarkClientResult;
  close: () => Promise<void>;
};

type OutboxBenchmarkEntry = {
  versionstamp: string;
  payload: {
    json: {
      operations: Array<{
        op: string;
        values: { payload: string };
      }>;
    };
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function consumeOutboxBenchmarkEntry(
  input: unknown,
  expectedPayloadBytes: number,
): { versionstamp: string; payloadBytes: number; checksum: number } {
  if (!input || typeof input !== "object") {
    throw new Error("Outbox-only benchmark received a non-object entry.");
  }
  const entry = input as Partial<OutboxBenchmarkEntry>;
  const operation = entry.payload?.json.operations?.[0];
  if (
    typeof entry.versionstamp !== "string" ||
    operation?.op !== "create" ||
    typeof operation.values?.payload !== "string"
  ) {
    throw new Error("Outbox-only benchmark received an invalid entry payload.");
  }

  const payload = operation.values.payload;
  if (payload.length !== expectedPayloadBytes) {
    throw new Error(
      `Outbox-only benchmark payload length mismatch: expected ${expectedPayloadBytes}, received ${payload.length}.`,
    );
  }
  return {
    versionstamp: entry.versionstamp,
    payloadBytes: payload.length,
    checksum: payload.charCodeAt(0) + payload.charCodeAt(payload.length - 1),
  };
}

function outboxUrl(baseUrl: string, route: "outbox" | "outbox/stream", pageSize: number): URL {
  const url = new URL(`${baseUrl}/_internal/${route}`);
  url.searchParams.set("limit", String(pageSize));
  return url;
}

async function openPolledOutboxWorkload(
  config: OutboxBenchmarkClientConfig,
): Promise<OpenOutboxClientWorkload> {
  const url = outboxUrl(config.baseUrl, "outbox", config.pageSize);
  let afterVersionstamp: string | undefined;
  let entriesConsumed = 0;
  let payloadBytesConsumed = 0;
  let checksum = 0;

  while (entriesConsumed < config.entryCount) {
    if (afterVersionstamp) {
      url.searchParams.set("afterVersionstamp", afterVersionstamp);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Outbox-only poll failed with status ${response.status}.`);
    }
    const entries: unknown = await response.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`Outbox-only poll ended after ${entriesConsumed} entries.`);
    }

    for (const input of entries) {
      const entry = consumeOutboxBenchmarkEntry(input, config.payloadBytes);
      afterVersionstamp = entry.versionstamp;
      payloadBytesConsumed += entry.payloadBytes;
      checksum = (checksum + entry.checksum) >>> 0;
      entriesConsumed += 1;
      await sleep(config.consumerDelayMs);
    }
    if (entriesConsumed < config.entryCount) {
      await sleep(config.pollIntervalMs);
    }
  }

  return {
    result: { payloadBytesConsumed, checksum },
    close: async () => {},
  };
}

async function openStreamingOutboxWorkload(
  config: OutboxBenchmarkClientConfig,
): Promise<OpenOutboxClientWorkload> {
  const abortController = new AbortController();
  const response = await fetch(outboxUrl(config.baseUrl, "outbox/stream", config.pageSize), {
    signal: abortController.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Outbox-only stream failed with status ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let entriesConsumed = 0;
  let payloadBytesConsumed = 0;
  let checksum = 0;
  let closed = false;

  try {
    while (entriesConsumed < config.entryCount) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`Outbox-only stream ended after ${entriesConsumed} entries.`);
      }

      if (!(value instanceof Uint8Array)) {
        throw new Error("Outbox-only stream returned a non-byte chunk.");
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1 && entriesConsumed < config.entryCount) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (/\S/u.test(line)) {
          const entry = consumeOutboxBenchmarkEntry(JSON.parse(line), config.payloadBytes);
          payloadBytesConsumed += entry.payloadBytes;
          checksum = (checksum + entry.checksum) >>> 0;
          entriesConsumed += 1;
          await sleep(config.consumerDelayMs);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    abortController.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }

  return {
    result: { payloadBytesConsumed, checksum },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      abortController.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    },
  };
}

/** Runs the network client while leaving stream teardown under the server process's control. */
export function openOutboxClientWorkload(
  config: OutboxBenchmarkClientConfig,
): Promise<OpenOutboxClientWorkload> {
  return config.mode === "stream"
    ? openStreamingOutboxWorkload(config)
    : openPolledOutboxWorkload(config);
}
