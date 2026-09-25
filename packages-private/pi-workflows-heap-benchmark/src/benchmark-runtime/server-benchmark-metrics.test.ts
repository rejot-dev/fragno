import { describe, expect, it } from "vitest";

import {
  compareServerBenchmarkWorkloads,
  parseServerBenchmarkMetrics,
  type OutboxBenchmarkMetrics,
  type PiWorkflowBenchmarkMetrics,
  type ServerMemoryMetrics,
} from "./server-benchmark-metrics";

const memory: ServerMemoryMetrics = {
  baselineHeapUsedBytes: 10,
  peakHeapUsedBytes: 20,
  peakHeapDeltaBytes: 10,
  baselineRssBytes: 100,
  peakRssBytes: 140,
  peakRssDeltaBytes: 40,
  baselineExternalBytes: 5,
  peakExternalBytes: 8,
  peakExternalDeltaBytes: 3,
  postWorkloadHeapUsedBytes: 18,
  retainedHeapUsedBytes: 11,
  retainedHeapDeltaBytes: 1,
  retainedRssBytes: 110,
  timeline: [{ elapsedMs: 0, heapUsedBytes: 10, rssBytes: 100, externalBytes: 5 }],
};

const workflow: PiWorkflowBenchmarkMetrics = {
  ...memory,
  kind: "pi-workflow",
  nodeVersion: "v26.10.0",
  outboxMode: "poll",
  transport: "node-http",
  measurementScope: "server",
  provider: "recorded:openai",
  modelId: "test-model@4x",
  outboxEntriesRead: 700,
  durationMs: 20_000,
  status: { status: "waiting", runGeneration: 1 },
};

const outbox: OutboxBenchmarkMetrics = {
  ...memory,
  kind: "outbox-only",
  scenario: "live",
  nodeVersion: "v26.10.0",
  outboxMode: "stream",
  transport: "node-http",
  measurementScope: "server",
  durationMs: 12_000,
  entryCount: 1_000,
  historyEntryCount: 100,
  clientCount: 10,
  laggingClientCount: 2,
  payloadBytesPerEntry: 1_024,
  payloadBytesConsumed: 10_240_000,
  consumerDelayMs: 1,
  pageSize: 50,
  entriesPerSecond: 833.33,
  checksum: 102_000,
  slowestClientDurationMs: 11_900,
  laggingEntriesConsumed: 61,
  laggingEntriesConsumedByClient: [19, 42],
  outboxDatabaseReadCount: 22,
};

describe("server benchmark metrics", () => {
  it("validates the server process boundary and memory timeline", () => {
    expect(parseServerBenchmarkMetrics(JSON.parse(JSON.stringify(workflow)))).toEqual(workflow);
    expect(() =>
      parseServerBenchmarkMetrics({ ...workflow, measurementScope: "server-and-client" }),
    ).toThrow("invalid process memory fields");
  });

  it("matches equivalent workflow runs and rejects changed workloads", () => {
    expect(
      compareServerBenchmarkWorkloads(workflow, { ...workflow, outboxMode: "stream" }),
    ).toEqual({ status: "matched", warnings: [] });

    expect(
      compareServerBenchmarkWorkloads(workflow, {
        ...workflow,
        outboxMode: "stream",
        outboxEntriesRead: 900,
      }),
    ).toEqual({
      status: "mismatched",
      warnings: ["Outbox entries read differs by more than 5%."],
    });
  });

  it("validates multi-client outbox metrics and treats client count as workload identity", () => {
    expect(parseServerBenchmarkMetrics(JSON.parse(JSON.stringify(outbox)))).toEqual(outbox);
    expect(compareServerBenchmarkWorkloads(outbox, { ...outbox, clientCount: 2 })).toEqual({
      status: "mismatched",
      warnings: ["Outbox workload dimensions differ."],
    });
  });

  it("loads legacy single-client outbox metrics without a database-read counter", () => {
    const legacy = {
      ...outbox,
      scenario: undefined,
      historyEntryCount: undefined,
      clientCount: undefined,
      laggingClientCount: undefined,
      slowestClientDurationMs: undefined,
      laggingEntriesConsumed: undefined,
      laggingEntriesConsumedByClient: undefined,
      outboxDatabaseReadCount: undefined,
    };

    expect(parseServerBenchmarkMetrics(JSON.parse(JSON.stringify(legacy)))).toMatchObject({
      scenario: "backlog",
      historyEntryCount: 0,
      clientCount: 1,
      laggingClientCount: 0,
      slowestClientDurationMs: outbox.durationMs,
      laggingEntriesConsumed: 0,
      laggingEntriesConsumedByClient: [],
      outboxDatabaseReadCount: null,
    });
  });

  it("rejects explicit nulls for legacy-compatible outbox metrics fields", () => {
    expect(() => parseServerBenchmarkMetrics({ ...outbox, clientCount: null })).toThrow(
      "Outbox benchmark metrics contain invalid workload fields.",
    );
    expect(() => parseServerBenchmarkMetrics({ ...outbox, slowestClientDurationMs: null })).toThrow(
      "Outbox benchmark metrics contain invalid workload fields.",
    );
  });
});
