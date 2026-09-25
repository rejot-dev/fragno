export type OutboxBenchmarkLaggingObserver = {
  afterVersionstamp: string | null;
  pageSize: number;
};

export type OutboxBenchmarkClientWorkload =
  | { kind: "backlog" }
  | {
      kind: "live";
      afterVersionstamp: string;
      laggingObservers: OutboxBenchmarkLaggingObserver[];
    };

export type OutboxBenchmarkClientConfig = {
  mode: "poll" | "stream";
  workload: OutboxBenchmarkClientWorkload;
  baseUrl: string;
  entryCount: number;
  payloadBytes: number;
  consumerDelayMs: number;
  pageSize: number;
  pollIntervalMs: number;
  clientCount: number;
};

export type OutboxBenchmarkClientResult = {
  clientCount: number;
  payloadBytesConsumed: number;
  checksum: number;
  slowestClientDurationMs: number;
  laggingEntriesConsumedByClient: number[];
};

export type OutboxBenchmarkServerMessage =
  | { type: "start"; config: OutboxBenchmarkClientConfig }
  | { type: "run" }
  | { type: "close" };

export type OutboxBenchmarkClientMessage =
  | { type: "ready" }
  | { type: "started" }
  | { type: "complete"; result: OutboxBenchmarkClientResult }
  | { type: "failed"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate an IPC command entering the unmeasured outbox client process. */
export function parseOutboxBenchmarkServerMessage(value: unknown): OutboxBenchmarkServerMessage {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Outbox benchmark client received an invalid server message.");
  }
  if (value["type"] === "close") {
    return { type: "close" };
  }
  if (value["type"] === "run") {
    return { type: "run" };
  }
  if (value["type"] !== "start" || !isRecord(value["config"])) {
    throw new Error("Outbox benchmark client received an unknown server message.");
  }

  const config = value["config"];
  const workload = config["workload"];
  const laggingObservers = isRecord(workload) ? workload["laggingObservers"] : null;
  const validWorkload =
    isRecord(workload) &&
    (workload["kind"] === "backlog" ||
      (workload["kind"] === "live" &&
        typeof workload["afterVersionstamp"] === "string" &&
        workload["afterVersionstamp"].length > 0 &&
        Array.isArray(laggingObservers) &&
        laggingObservers.length > 0 &&
        laggingObservers.every(
          (observer) =>
            isRecord(observer) &&
            (observer["afterVersionstamp"] === null ||
              (typeof observer["afterVersionstamp"] === "string" &&
                observer["afterVersionstamp"].length > 0)) &&
            isPositiveInteger(observer["pageSize"]),
        )));
  if (
    (config["mode"] !== "poll" && config["mode"] !== "stream") ||
    !validWorkload ||
    (workload["kind"] === "live" && config["mode"] !== "stream") ||
    typeof config["baseUrl"] !== "string" ||
    !isPositiveInteger(config["entryCount"]) ||
    !isPositiveInteger(config["payloadBytes"]) ||
    !isPositiveInteger(config["consumerDelayMs"]) ||
    !isPositiveInteger(config["pageSize"]) ||
    !isPositiveInteger(config["pollIntervalMs"]) ||
    !isPositiveInteger(config["clientCount"])
  ) {
    throw new Error("Outbox benchmark client received an invalid workload configuration.");
  }

  return {
    type: "start",
    config: {
      mode: config["mode"],
      workload:
        workload["kind"] === "backlog"
          ? { kind: "backlog" }
          : {
              kind: "live",
              afterVersionstamp: workload["afterVersionstamp"] as string,
              laggingObservers: (laggingObservers as Array<Record<string, unknown>>).map(
                (observer) => ({
                  afterVersionstamp: observer["afterVersionstamp"] as string | null,
                  pageSize: observer["pageSize"] as number,
                }),
              ),
            },
      baseUrl: config["baseUrl"],
      entryCount: config["entryCount"],
      payloadBytes: config["payloadBytes"],
      consumerDelayMs: config["consumerDelayMs"],
      pageSize: config["pageSize"],
      pollIntervalMs: config["pollIntervalMs"],
      clientCount: config["clientCount"],
    },
  };
}

/** Validate an IPC result entering the measured outbox server process. */
export function parseOutboxBenchmarkClientMessage(value: unknown): OutboxBenchmarkClientMessage {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Outbox benchmark server received an invalid client message.");
  }
  if (value["type"] === "ready") {
    return { type: "ready" };
  }
  if (value["type"] === "started") {
    return { type: "started" };
  }
  if (value["type"] === "failed" && typeof value["error"] === "string") {
    return { type: "failed", error: value["error"] };
  }
  if (value["type"] !== "complete" || !isRecord(value["result"])) {
    throw new Error("Outbox benchmark server received an unknown client message.");
  }

  const result = value["result"];
  if (
    !isPositiveInteger(result["clientCount"]) ||
    !isPositiveInteger(result["payloadBytesConsumed"]) ||
    typeof result["checksum"] !== "number" ||
    !Number.isSafeInteger(result["checksum"]) ||
    result["checksum"] < 0 ||
    typeof result["slowestClientDurationMs"] !== "number" ||
    !Number.isFinite(result["slowestClientDurationMs"]) ||
    result["slowestClientDurationMs"] < 0 ||
    !Array.isArray(result["laggingEntriesConsumedByClient"]) ||
    !result["laggingEntriesConsumedByClient"].every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    throw new Error("Outbox benchmark server received an invalid client result.");
  }

  return {
    type: "complete",
    result: {
      clientCount: result["clientCount"],
      payloadBytesConsumed: result["payloadBytesConsumed"],
      checksum: result["checksum"],
      slowestClientDurationMs: result["slowestClientDurationMs"],
      laggingEntriesConsumedByClient: result["laggingEntriesConsumedByClient"],
    },
  };
}
