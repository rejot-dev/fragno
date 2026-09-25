export type OutboxConsumptionMode = "poll" | "stream";

export type ServerMemorySample = {
  elapsedMs: number;
  heapUsedBytes: number;
  rssBytes: number;
  externalBytes: number;
};

export type ServerMemoryMetrics = {
  baselineHeapUsedBytes: number;
  peakHeapUsedBytes: number;
  peakHeapDeltaBytes: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  peakRssDeltaBytes: number;
  baselineExternalBytes: number;
  peakExternalBytes: number;
  peakExternalDeltaBytes: number;
  postWorkloadHeapUsedBytes: number;
  retainedHeapUsedBytes: number;
  retainedHeapDeltaBytes: number;
  retainedRssBytes: number;
  timeline: ServerMemorySample[];
};

type ServerBenchmarkBaseMetrics = ServerMemoryMetrics & {
  nodeVersion: string;
  outboxMode: OutboxConsumptionMode;
  transport: "node-http";
  measurementScope: "server";
  durationMs: number;
};

export type PiWorkflowBenchmarkMetrics = ServerBenchmarkBaseMetrics & {
  kind: "pi-workflow";
  provider: string;
  modelId: string;
  outboxEntriesRead: number;
  status: { status: string; runGeneration: number };
};

export type OutboxBenchmarkMetrics = ServerBenchmarkBaseMetrics & {
  kind: "outbox-only";
  scenario: "backlog" | "live";
  entryCount: number;
  historyEntryCount: number;
  clientCount: number;
  laggingClientCount: number;
  payloadBytesPerEntry: number;
  payloadBytesConsumed: number;
  consumerDelayMs: number;
  pageSize: number;
  entriesPerSecond: number;
  checksum: number;
  slowestClientDurationMs: number;
  laggingEntriesConsumed: number;
  laggingEntriesConsumedByClient: number[];
  outboxDatabaseReadCount: number | null;
};

export type ServerBenchmarkMetrics = PiWorkflowBenchmarkMetrics | OutboxBenchmarkMetrics;

export type BenchmarkWorkloadComparison = {
  status: "matched" | "mismatched" | "unverified";
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNonNegativeInteger);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseServerMemorySamples(value: unknown): ServerMemorySample[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (sample) =>
        isRecord(sample) &&
        isNonNegativeNumber(sample["elapsedMs"]) &&
        isNonNegativeNumber(sample["heapUsedBytes"]) &&
        isNonNegativeNumber(sample["rssBytes"]) &&
        isNonNegativeNumber(sample["externalBytes"]),
    )
  ) {
    throw new Error("Server benchmark metrics contain an invalid memory timeline.");
  }
  return value as ServerMemorySample[];
}

function parseServerBenchmarkBaseMetrics(
  input: Record<string, unknown>,
): ServerBenchmarkBaseMetrics {
  if (
    typeof input["nodeVersion"] !== "string" ||
    (input["outboxMode"] !== "poll" && input["outboxMode"] !== "stream") ||
    input["transport"] !== "node-http" ||
    input["measurementScope"] !== "server" ||
    !isNonNegativeNumber(input["durationMs"]) ||
    !isNonNegativeNumber(input["baselineHeapUsedBytes"]) ||
    !isNonNegativeNumber(input["peakHeapUsedBytes"]) ||
    !isNonNegativeNumber(input["peakHeapDeltaBytes"]) ||
    !isNonNegativeNumber(input["baselineRssBytes"]) ||
    !isNonNegativeNumber(input["peakRssBytes"]) ||
    !isNonNegativeNumber(input["peakRssDeltaBytes"]) ||
    !isNonNegativeNumber(input["baselineExternalBytes"]) ||
    !isNonNegativeNumber(input["peakExternalBytes"]) ||
    !isNonNegativeNumber(input["peakExternalDeltaBytes"]) ||
    !isNonNegativeNumber(input["postWorkloadHeapUsedBytes"]) ||
    !isNonNegativeNumber(input["retainedHeapUsedBytes"]) ||
    !isFiniteNumber(input["retainedHeapDeltaBytes"]) ||
    !isNonNegativeNumber(input["retainedRssBytes"])
  ) {
    throw new Error("Server benchmark metrics contain invalid process memory fields.");
  }

  return {
    nodeVersion: input["nodeVersion"],
    outboxMode: input["outboxMode"],
    transport: input["transport"],
    measurementScope: input["measurementScope"],
    durationMs: input["durationMs"],
    baselineHeapUsedBytes: input["baselineHeapUsedBytes"],
    peakHeapUsedBytes: input["peakHeapUsedBytes"],
    peakHeapDeltaBytes: input["peakHeapDeltaBytes"],
    baselineRssBytes: input["baselineRssBytes"],
    peakRssBytes: input["peakRssBytes"],
    peakRssDeltaBytes: input["peakRssDeltaBytes"],
    baselineExternalBytes: input["baselineExternalBytes"],
    peakExternalBytes: input["peakExternalBytes"],
    peakExternalDeltaBytes: input["peakExternalDeltaBytes"],
    postWorkloadHeapUsedBytes: input["postWorkloadHeapUsedBytes"],
    retainedHeapUsedBytes: input["retainedHeapUsedBytes"],
    retainedHeapDeltaBytes: input["retainedHeapDeltaBytes"],
    retainedRssBytes: input["retainedRssBytes"],
    timeline: parseServerMemorySamples(input["timeline"]),
  };
}

/** Validate a server-only benchmark metrics sidecar before profile comparison. */
export function parseServerBenchmarkMetrics(input: unknown): ServerBenchmarkMetrics {
  if (!isRecord(input)) {
    throw new Error("Server benchmark metrics must be an object.");
  }
  const base = parseServerBenchmarkBaseMetrics(input);

  if (input["kind"] === "pi-workflow") {
    const status = input["status"];
    if (
      typeof input["provider"] !== "string" ||
      typeof input["modelId"] !== "string" ||
      !isNonNegativeInteger(input["outboxEntriesRead"]) ||
      !isRecord(status) ||
      typeof status["status"] !== "string" ||
      !isNonNegativeInteger(status["runGeneration"])
    ) {
      throw new Error("Pi workflow benchmark metrics contain invalid workload fields.");
    }
    return {
      ...base,
      kind: input["kind"],
      provider: input["provider"],
      modelId: input["modelId"],
      outboxEntriesRead: input["outboxEntriesRead"],
      status: { status: status["status"], runGeneration: status["runGeneration"] },
    };
  }

  const scenario = Object.hasOwn(input, "scenario") ? input["scenario"] : "backlog";
  const historyEntryCount = Object.hasOwn(input, "historyEntryCount")
    ? input["historyEntryCount"]
    : 0;
  const clientCount = Object.hasOwn(input, "clientCount") ? input["clientCount"] : 1;
  const laggingClientCount = Object.hasOwn(input, "laggingClientCount")
    ? input["laggingClientCount"]
    : 0;
  const slowestClientDurationMs = Object.hasOwn(input, "slowestClientDurationMs")
    ? input["slowestClientDurationMs"]
    : base.durationMs;
  const laggingEntriesConsumed = Object.hasOwn(input, "laggingEntriesConsumed")
    ? input["laggingEntriesConsumed"]
    : 0;
  const laggingEntriesConsumedByClient = Object.hasOwn(input, "laggingEntriesConsumedByClient")
    ? input["laggingEntriesConsumedByClient"]
    : laggingClientCount === 0
      ? []
      : [laggingEntriesConsumed];
  const outboxDatabaseReadCount = Object.hasOwn(input, "outboxDatabaseReadCount")
    ? input["outboxDatabaseReadCount"]
    : null;
  if (
    input["kind"] !== "outbox-only" ||
    (scenario !== "backlog" && scenario !== "live") ||
    !isNonNegativeInteger(input["entryCount"]) ||
    !isNonNegativeInteger(historyEntryCount) ||
    !isNonNegativeInteger(clientCount) ||
    clientCount < 1 ||
    !isNonNegativeInteger(laggingClientCount) ||
    !isNonNegativeInteger(input["payloadBytesPerEntry"]) ||
    !isNonNegativeInteger(input["payloadBytesConsumed"]) ||
    !isNonNegativeInteger(input["consumerDelayMs"]) ||
    !isNonNegativeInteger(input["pageSize"]) ||
    !isNonNegativeNumber(input["entriesPerSecond"]) ||
    !isNonNegativeInteger(input["checksum"]) ||
    !isNonNegativeNumber(slowestClientDurationMs) ||
    !isNonNegativeInteger(laggingEntriesConsumed) ||
    !isNonNegativeIntegerArray(laggingEntriesConsumedByClient) ||
    laggingEntriesConsumedByClient.length !== laggingClientCount ||
    laggingEntriesConsumedByClient.reduce((total, count) => total + count, 0) !==
      laggingEntriesConsumed ||
    (outboxDatabaseReadCount !== null && !isNonNegativeInteger(outboxDatabaseReadCount))
  ) {
    throw new Error("Outbox benchmark metrics contain invalid workload fields.");
  }
  return {
    ...base,
    kind: input["kind"],
    scenario,
    entryCount: input["entryCount"],
    historyEntryCount,
    clientCount,
    laggingClientCount,
    payloadBytesPerEntry: input["payloadBytesPerEntry"],
    payloadBytesConsumed: input["payloadBytesConsumed"],
    consumerDelayMs: input["consumerDelayMs"],
    pageSize: input["pageSize"],
    entriesPerSecond: input["entriesPerSecond"],
    checksum: input["checksum"],
    slowestClientDurationMs,
    laggingEntriesConsumed,
    laggingEntriesConsumedByClient,
    outboxDatabaseReadCount,
  };
}

function recordRelativeDifference(
  warnings: string[],
  label: string,
  baseline: number,
  candidate: number,
  tolerance: number,
): void {
  if (baseline === 0 ? candidate !== 0 : Math.abs(candidate - baseline) / baseline > tolerance) {
    warnings.push(`${label} differs by more than ${Math.round(tolerance * 100)}%.`);
  }
}

/** Compare only workload identity; memory and throughput remain benchmark results. */
export function compareServerBenchmarkWorkloads(
  baseline: ServerBenchmarkMetrics | null,
  candidate: ServerBenchmarkMetrics | null,
): BenchmarkWorkloadComparison {
  if (!baseline || !candidate) {
    return {
      status: "unverified",
      warnings: ["Server benchmark metrics are unavailable for one or both profiles."],
    };
  }

  const warnings: string[] = [];
  if (baseline.kind !== candidate.kind) {
    return { status: "mismatched", warnings: ["Benchmark kinds differ."] };
  }
  if (baseline.nodeVersion !== candidate.nodeVersion) {
    warnings.push("Node versions differ.");
  }
  if (
    baseline.transport !== candidate.transport ||
    baseline.measurementScope !== candidate.measurementScope
  ) {
    warnings.push("Benchmark process boundaries differ.");
  }

  if (baseline.kind === "pi-workflow" && candidate.kind === "pi-workflow") {
    if (baseline.provider !== candidate.provider || baseline.modelId !== candidate.modelId) {
      warnings.push("Providers or models differ.");
    }
    if (baseline.status.status !== candidate.status.status) {
      warnings.push("Final workflow statuses differ.");
    }
    recordRelativeDifference(
      warnings,
      "Outbox entries read",
      baseline.outboxEntriesRead,
      candidate.outboxEntriesRead,
      0.05,
    );
    recordRelativeDifference(warnings, "Duration", baseline.durationMs, candidate.durationMs, 0.1);
  }

  if (baseline.kind === "outbox-only" && candidate.kind === "outbox-only") {
    if (
      baseline.scenario !== candidate.scenario ||
      baseline.entryCount !== candidate.entryCount ||
      baseline.historyEntryCount !== candidate.historyEntryCount ||
      baseline.clientCount !== candidate.clientCount ||
      baseline.laggingClientCount !== candidate.laggingClientCount ||
      baseline.payloadBytesPerEntry !== candidate.payloadBytesPerEntry ||
      baseline.consumerDelayMs !== candidate.consumerDelayMs ||
      baseline.pageSize !== candidate.pageSize
    ) {
      warnings.push("Outbox workload dimensions differ.");
    }
    if (
      baseline.payloadBytesConsumed !== candidate.payloadBytesConsumed ||
      baseline.checksum !== candidate.checksum
    ) {
      warnings.push("Outbox workload results differ.");
    }
  }

  return { status: warnings.length === 0 ? "matched" : "mismatched", warnings };
}
