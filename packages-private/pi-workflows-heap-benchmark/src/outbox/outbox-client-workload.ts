import type {
  OutboxBenchmarkClientConfig,
  OutboxBenchmarkClientResult,
} from "./outbox-benchmark-protocol";

type OutboxSingleClientResult = {
  payloadBytesConsumed: number;
  checksum: number;
};

type OpenOutboxSingleClientWorkload = {
  result: OutboxSingleClientResult;
  close: () => Promise<void>;
};

type OpenOutboxClientWorkloads = {
  result: OutboxBenchmarkClientResult;
  close: () => Promise<void>;
};

type PreparedLiveOutboxClientWorkloads = {
  result: Promise<OutboxBenchmarkClientResult>;
  close: () => Promise<void>;
};

type OutboxStreamConnection = {
  readFrame: () => Promise<string>;
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

function outboxUrl(
  baseUrl: string,
  route: "outbox" | "outbox/stream",
  pageSize: number,
  afterVersionstamp: string | undefined,
): URL {
  const url = new URL(`${baseUrl}/_internal/${route}`);
  url.searchParams.set("limit", String(pageSize));
  if (afterVersionstamp !== undefined) {
    url.searchParams.set("afterVersionstamp", afterVersionstamp);
  }
  return url;
}

async function openOutboxStreamConnection(
  config: OutboxBenchmarkClientConfig,
  pageSize: number,
  afterVersionstamp: string | undefined,
): Promise<OutboxStreamConnection> {
  const abortController = new AbortController();
  const response = await fetch(
    outboxUrl(config.baseUrl, "outbox/stream", pageSize, afterVersionstamp),
    { signal: abortController.signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Outbox-only stream failed with status ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  return {
    readFrame: async () => {
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const frame = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          return frame;
        }

        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          throw new Error("Outbox-only stream ended before the workload completed.");
        }
        if (!(value instanceof Uint8Array)) {
          throw new Error("Outbox-only stream returned a non-byte chunk.");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
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

async function consumeStreamingEntries(
  connection: OutboxStreamConnection,
  config: OutboxBenchmarkClientConfig,
): Promise<OutboxSingleClientResult> {
  let entriesConsumed = 0;
  let payloadBytesConsumed = 0;
  let checksum = 0;
  while (entriesConsumed < config.entryCount) {
    const frame = await connection.readFrame();
    if (!/\S/u.test(frame)) {
      continue;
    }
    const entry = consumeOutboxBenchmarkEntry(JSON.parse(frame), config.payloadBytes);
    payloadBytesConsumed += entry.payloadBytes;
    checksum = (checksum + entry.checksum) >>> 0;
    entriesConsumed += 1;
    await sleep(config.consumerDelayMs);
  }
  return { payloadBytesConsumed, checksum };
}

async function openPolledOutboxWorkload(
  config: OutboxBenchmarkClientConfig,
): Promise<OpenOutboxSingleClientWorkload> {
  const url = outboxUrl(config.baseUrl, "outbox", config.pageSize, undefined);
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
): Promise<OpenOutboxSingleClientWorkload> {
  const connection = await openOutboxStreamConnection(config, config.pageSize, undefined);
  try {
    const result = await consumeStreamingEntries(connection, config);
    return { result, close: connection.close };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

function openOutboxClientWorkload(
  config: OutboxBenchmarkClientConfig,
): Promise<OpenOutboxSingleClientWorkload> {
  return config.mode === "stream"
    ? openStreamingOutboxWorkload(config)
    : openPolledOutboxWorkload(config);
}

function aggregateClientResults(
  completed: Array<{ workload: OpenOutboxSingleClientWorkload; durationMs: number }>,
  laggingEntriesConsumedByClient: number[],
): OutboxBenchmarkClientResult {
  const first = completed[0];
  if (!first) {
    throw new Error("Outbox benchmark did not complete any client workloads.");
  }
  for (const { workload } of completed) {
    if (
      workload.result.payloadBytesConsumed !== first.workload.result.payloadBytesConsumed ||
      workload.result.checksum !== first.workload.result.checksum
    ) {
      throw new Error("Outbox benchmark clients consumed different payloads.");
    }
  }

  const payloadBytesConsumed = completed.reduce(
    (total, { workload }) => total + workload.result.payloadBytesConsumed,
    0,
  );
  if (!Number.isSafeInteger(payloadBytesConsumed)) {
    throw new Error("Outbox benchmark aggregate payload bytes exceed the safe integer range.");
  }

  return {
    clientCount: completed.length,
    payloadBytesConsumed,
    checksum: first.workload.result.checksum,
    slowestClientDurationMs: Math.max(...completed.map(({ durationMs }) => durationMs)),
    laggingEntriesConsumedByClient: [...laggingEntriesConsumedByClient],
  };
}

/** Runs concurrent backlog clients while leaving their teardown under server-process control. */
export async function openOutboxClientWorkloads(
  config: OutboxBenchmarkClientConfig,
): Promise<OpenOutboxClientWorkloads> {
  const attempts = await Promise.allSettled(
    Array.from({ length: config.clientCount }, async () => {
      const startedAt = performance.now();
      const workload = await openOutboxClientWorkload(config);
      return { workload, durationMs: performance.now() - startedAt };
    }),
  );
  const completed = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );
  const failed = attempts.find((attempt) => attempt.status === "rejected");
  if (failed?.status === "rejected") {
    await Promise.all(completed.map(({ workload }) => workload.close()));
    throw failed.reason;
  }
  if (completed.length !== config.clientCount) {
    throw new Error("Outbox benchmark did not complete every configured client workload.");
  }

  try {
    return {
      result: aggregateClientResults(completed, []),
      close: async () => {
        await Promise.all(completed.map(({ workload }) => workload.close()));
      },
    };
  } catch (error) {
    await Promise.all(completed.map(({ workload }) => workload.close()));
    throw error;
  }
}

/** Connects current clients at the live tail while divergent observers remain in catch-up. */
export async function prepareLiveOutboxClientWorkloads(
  config: OutboxBenchmarkClientConfig,
): Promise<PreparedLiveOutboxClientWorkloads> {
  if (config.workload.kind !== "live") {
    throw new Error("Live outbox workload preparation requires live workload configuration.");
  }
  const workload = config.workload;
  const currentConnections: OutboxStreamConnection[] = [];
  const laggingConnections: Array<{ connection: OutboxStreamConnection; clientIndex: number }> = [];
  const laggingEntriesConsumedByClient = workload.laggingObservers.map(() => 0);

  try {
    await Promise.all(
      Array.from({ length: config.clientCount }, async () => {
        const connection = await openOutboxStreamConnection(
          config,
          config.pageSize,
          workload.afterVersionstamp,
        );
        currentConnections.push(connection);
        const initialFrame = await connection.readFrame();
        if (/\S/u.test(initialFrame)) {
          throw new Error("Live outbox benchmark current client received catch-up data.");
        }
      }),
    );

    await Promise.all(
      workload.laggingObservers.map(async (observer, clientIndex) => {
        const connection = await openOutboxStreamConnection(
          config,
          observer.pageSize,
          observer.afterVersionstamp ?? undefined,
        );
        laggingConnections.push({ connection, clientIndex });
        const firstFrame = await connection.readFrame();
        if (!/\S/u.test(firstFrame)) {
          throw new Error("Live outbox benchmark lagging client did not receive historical data.");
        }
        consumeOutboxBenchmarkEntry(JSON.parse(firstFrame), config.payloadBytes);
        laggingEntriesConsumedByClient[clientIndex] = 1;
      }),
    );
  } catch (error) {
    await Promise.all([
      ...currentConnections.map((connection) => connection.close()),
      ...laggingConnections.map(({ connection }) => connection.close()),
    ]);
    throw error;
  }

  let closing = false;
  const laggingTask = Promise.all(
    laggingConnections.map(async ({ connection, clientIndex }) => {
      while (!closing) {
        const frame = await connection.readFrame();
        if (!/\S/u.test(frame)) {
          continue;
        }
        consumeOutboxBenchmarkEntry(JSON.parse(frame), config.payloadBytes);
        laggingEntriesConsumedByClient[clientIndex] += 1;
        await sleep(config.consumerDelayMs);
      }
    }),
  );

  const result = Promise.race([
    Promise.all(
      currentConnections.map(async (connection) => {
        const startedAt = performance.now();
        const workloadResult = await consumeStreamingEntries(connection, config);
        return {
          workload: { result: workloadResult, close: connection.close },
          durationMs: performance.now() - startedAt,
        };
      }),
    ).then((completed) => aggregateClientResults(completed, laggingEntriesConsumedByClient)),
    laggingTask.then<OutboxBenchmarkClientResult>(() => {
      throw new Error("Live outbox benchmark lagging clients stopped unexpectedly.");
    }),
  ]);

  return {
    result,
    close: async () => {
      if (closing) {
        return;
      }
      closing = true;
      await Promise.all([
        ...currentConnections.map((connection) => connection.close()),
        ...laggingConnections.map(({ connection }) => connection.close()),
      ]);
      await laggingTask.catch(() => {});
    },
  };
}
