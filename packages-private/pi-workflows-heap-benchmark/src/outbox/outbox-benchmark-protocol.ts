export type OutboxBenchmarkClientConfig = {
  mode: "poll" | "stream";
  baseUrl: string;
  entryCount: number;
  payloadBytes: number;
  consumerDelayMs: number;
  pageSize: number;
  pollIntervalMs: number;
};

export type OutboxBenchmarkClientResult = {
  payloadBytesConsumed: number;
  checksum: number;
};

export type OutboxBenchmarkServerMessage =
  | { type: "start"; config: OutboxBenchmarkClientConfig }
  | { type: "close" };

export type OutboxBenchmarkClientMessage =
  | { type: "ready" }
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
  if (value["type"] !== "start" || !isRecord(value["config"])) {
    throw new Error("Outbox benchmark client received an unknown server message.");
  }

  const config = value["config"];
  if (
    (config["mode"] !== "poll" && config["mode"] !== "stream") ||
    typeof config["baseUrl"] !== "string" ||
    !isPositiveInteger(config["entryCount"]) ||
    !isPositiveInteger(config["payloadBytes"]) ||
    !isPositiveInteger(config["consumerDelayMs"]) ||
    !isPositiveInteger(config["pageSize"]) ||
    !isPositiveInteger(config["pollIntervalMs"])
  ) {
    throw new Error("Outbox benchmark client received an invalid workload configuration.");
  }

  return {
    type: "start",
    config: {
      mode: config["mode"],
      baseUrl: config["baseUrl"],
      entryCount: config["entryCount"],
      payloadBytes: config["payloadBytes"],
      consumerDelayMs: config["consumerDelayMs"],
      pageSize: config["pageSize"],
      pollIntervalMs: config["pollIntervalMs"],
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
  if (value["type"] === "failed" && typeof value["error"] === "string") {
    return { type: "failed", error: value["error"] };
  }
  if (value["type"] !== "complete" || !isRecord(value["result"])) {
    throw new Error("Outbox benchmark server received an unknown client message.");
  }

  const result = value["result"];
  if (
    !isPositiveInteger(result["payloadBytesConsumed"]) ||
    typeof result["checksum"] !== "number" ||
    !Number.isSafeInteger(result["checksum"]) ||
    result["checksum"] < 0
  ) {
    throw new Error("Outbox benchmark server received an invalid client result.");
  }

  return {
    type: "complete",
    result: {
      payloadBytesConsumed: result["payloadBytesConsumed"],
      checksum: result["checksum"],
    },
  };
}
