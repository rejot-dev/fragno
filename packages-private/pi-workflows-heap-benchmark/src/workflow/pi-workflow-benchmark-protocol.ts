export type PiWorkflowBenchmarkClientConfig = {
  mode: "poll" | "stream";
  piBaseUrl: string;
  workflowsBaseUrl: string;
  workflowName: string;
  sessionId: string;
  prompt: string;
  pollIntervalMs: number;
  waitTimeoutMs: number;
};

export type PiWorkflowBenchmarkClientResult = {
  outboxEntriesRead: number;
  status: { status: string; runGeneration: number };
};

export type PiWorkflowBenchmarkServerMessage =
  | { type: "prepare"; config: PiWorkflowBenchmarkClientConfig }
  | { type: "start" }
  | { type: "close" };

export type PiWorkflowBenchmarkClientMessage =
  | { type: "ready" }
  | { type: "prepared" }
  | { type: "complete"; result: PiWorkflowBenchmarkClientResult }
  | { type: "failed"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate an IPC command entering the unmeasured Pi workflow client process. */
export function parsePiWorkflowBenchmarkServerMessage(
  value: unknown,
): PiWorkflowBenchmarkServerMessage {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Pi workflow benchmark client received an invalid server message.");
  }
  if (value["type"] === "start" || value["type"] === "close") {
    return { type: value["type"] };
  }
  if (value["type"] !== "prepare" || !isRecord(value["config"])) {
    throw new Error("Pi workflow benchmark client received an unknown server message.");
  }

  const config = value["config"];
  if (
    (config["mode"] !== "poll" && config["mode"] !== "stream") ||
    typeof config["piBaseUrl"] !== "string" ||
    typeof config["workflowsBaseUrl"] !== "string" ||
    typeof config["workflowName"] !== "string" ||
    typeof config["sessionId"] !== "string" ||
    typeof config["prompt"] !== "string" ||
    !isPositiveInteger(config["pollIntervalMs"]) ||
    !isPositiveInteger(config["waitTimeoutMs"])
  ) {
    throw new Error("Pi workflow benchmark client received an invalid workload configuration.");
  }
  return {
    type: "prepare",
    config: {
      mode: config["mode"],
      piBaseUrl: config["piBaseUrl"],
      workflowsBaseUrl: config["workflowsBaseUrl"],
      workflowName: config["workflowName"],
      sessionId: config["sessionId"],
      prompt: config["prompt"],
      pollIntervalMs: config["pollIntervalMs"],
      waitTimeoutMs: config["waitTimeoutMs"],
    },
  };
}

/** Validate an IPC result entering the measured Pi workflow server process. */
export function parsePiWorkflowBenchmarkClientMessage(
  value: unknown,
): PiWorkflowBenchmarkClientMessage {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Pi workflow benchmark server received an invalid client message.");
  }
  if (value["type"] === "ready" || value["type"] === "prepared") {
    return { type: value["type"] };
  }
  if (value["type"] === "failed" && typeof value["error"] === "string") {
    return { type: "failed", error: value["error"] };
  }
  if (value["type"] !== "complete" || !isRecord(value["result"])) {
    throw new Error("Pi workflow benchmark server received an unknown client message.");
  }

  const result = value["result"];
  const status = result["status"];
  if (
    typeof result["outboxEntriesRead"] !== "number" ||
    !Number.isSafeInteger(result["outboxEntriesRead"]) ||
    result["outboxEntriesRead"] < 0 ||
    !isRecord(status) ||
    typeof status["status"] !== "string" ||
    !isPositiveInteger(status["runGeneration"])
  ) {
    throw new Error("Pi workflow benchmark server received an invalid client result.");
  }
  return {
    type: "complete",
    result: {
      outboxEntriesRead: result["outboxEntriesRead"],
      status: { status: status["status"], runGeneration: status["runGeneration"] },
    },
  };
}
