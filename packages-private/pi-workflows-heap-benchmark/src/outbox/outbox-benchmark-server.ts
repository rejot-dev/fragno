import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { migrate, withDatabase } from "@fragno-dev/db";
import { toNodeHandler } from "@fragno-dev/node";

import {
  closeBenchmarkChild,
  forkBenchmarkClient,
  sendBenchmarkChildMessage,
  waitForBenchmarkChildMessage,
} from "../benchmark-runtime/benchmark-child-process";
import type { OutboxBenchmarkMetrics } from "../benchmark-runtime/server-benchmark-metrics";
import {
  forceServerGarbageCollection,
  measureRetainedServerMemory,
  startServerMemoryMeasurement,
} from "../benchmark-runtime/server-memory-measurement";
import { parseOutboxBenchmarkArguments } from "./outbox-benchmark-config";
import {
  parseOutboxBenchmarkClientMessage,
  type OutboxBenchmarkClientConfig,
  type OutboxBenchmarkClientResult,
  type OutboxBenchmarkLaggingObserver,
} from "./outbox-benchmark-protocol";

const OUTBOX_PAGE_SIZE = 50;
const OUTBOX_LAGGING_PAGE_SIZE = 1;
const OUTBOX_POLL_INTERVAL_MS = 300;
const MEMORY_SAMPLE_INTERVAL_MS = 10;
const ALLOCATION_SAMPLE_INTERVAL_BYTES = 128 * 1_024;

const outboxBenchmarkSchema = schema("outbox_benchmark", (builder) =>
  builder.addTable("benchmark_items", (table) =>
    table.addColumn("id", idColumn()).addColumn("payload", column("text")),
  ),
);
const outboxBenchmarkDefinition = defineFragment("outbox-only-benchmark")
  .extend(withDatabase(outboxBenchmarkSchema))
  .build();

function outboxVersionstamp(index: number): string {
  return BigInt(index).toString(16).padStart(20, "0") + "0000";
}

function createPayload(index: number, payloadBytes: number, filler: string): string {
  const prefix = `${index.toString().padStart(8, "0")}:`;
  return prefix + filler.slice(0, payloadBytes - prefix.length);
}

function createLaggingObservers(
  historyEntryCount: number,
  laggingClientCount: number,
): OutboxBenchmarkLaggingObserver[] {
  return Array.from({ length: laggingClientCount }, (_, clientIndex) => {
    const nextEntryIndex = Math.floor((clientIndex * historyEntryCount) / laggingClientCount);
    return {
      afterVersionstamp: nextEntryIndex === 0 ? null : outboxVersionstamp(nextEntryIndex - 1),
      pageSize: clientIndex === 0 ? OUTBOX_LAGGING_PAGE_SIZE : OUTBOX_PAGE_SIZE,
    };
  });
}

function isOutboxDatabaseReadStatement(statement: string): boolean {
  const normalized = statement.trimStart().toLowerCase();
  return normalized.startsWith("select") && normalized.includes("fragno_db_outbox");
}

function insertOutboxEntries(
  sqlite: Database.Database,
  startIndex: number,
  entryCount: number,
  payloadBytes: number,
): void {
  const insertEntry = sqlite.prepare(`
    INSERT INTO fragno_db_outbox (id, versionstamp, uowId, payload, refMap, createdAt)
    VALUES (?, ?, ?, ?, NULL, ?)
  `);
  const insertMutation = sqlite.prepare(`
    INSERT INTO fragno_db_outbox_mutations (
      id,
      entryVersionstamp,
      mutationVersionstamp,
      uowId,
      schema,
      "table",
      externalId,
      op,
      createdAt,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const filler = "0123456789abcdef".repeat(Math.ceil(payloadBytes / 16));
  const createdAt = Date.now();
  const insertAll = sqlite.transaction(() => {
    for (let offset = 0; offset < entryCount; offset += 1) {
      const index = startIndex + offset;
      const versionstamp = outboxVersionstamp(index);
      const uowId = `outbox-benchmark-uow-${index}`;
      const payload = createPayload(index, payloadBytes, filler);
      const operation = {
        op: "create",
        schema: outboxBenchmarkSchema.name,
        table: "benchmark_items",
        externalId: `benchmark-item-${index}`,
        versionstamp,
        values: { payload },
      };
      insertEntry.run(
        `outbox-benchmark-entry-${index}`,
        versionstamp,
        uowId,
        JSON.stringify({ json: { version: 2, operations: [] } }),
        createdAt + index,
      );
      insertMutation.run(
        `outbox-benchmark-mutation-${index}`,
        versionstamp,
        versionstamp,
        uowId,
        operation.schema,
        operation.table,
        operation.externalId,
        operation.op,
        createdAt + index,
        JSON.stringify({ json: operation }),
      );
    }
  });
  insertAll();
}

function instantiateOutboxBenchmarkFragment(databaseAdapter: SqlAdapter) {
  return instantiate(outboxBenchmarkDefinition)
    .withOptions({
      databaseAdapter,
      mountRoute: "/outbox-benchmark",
      outbox: { enabled: true },
    })
    .build();
}

async function startOutboxBenchmarkServer(
  fragment: ReturnType<typeof instantiateOutboxBenchmarkFragment>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(toNodeHandler((request) => fragment.handler(request)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Outbox benchmark server did not receive a TCP port.");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}${fragment.mountRoute}`,
  };
}

async function closeOutboxBenchmarkServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function closeDatabaseAdapterAfterStreamCancellation(
  databaseAdapter: SqlAdapter,
): Promise<void> {
  // A socket can close before the response lease and its bounded cursor finish. Allow the
  // server's 30-second lease to expire rather than racing teardown with a one-second retry cap.
  const deadline = performance.now() + 35_000;
  while (true) {
    try {
      await databaseAdapter.close();
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "This database connection is busy executing a query" ||
        performance.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
}

async function spawnOutboxBenchmarkClient(): Promise<ChildProcess> {
  const client = forkBenchmarkClient(
    fileURLToPath(new URL("./outbox-benchmark-client.ts", import.meta.url)),
  );
  try {
    const ready = await waitForBenchmarkChildMessage(
      client,
      parseOutboxBenchmarkClientMessage,
      "Outbox benchmark",
    );
    if (ready.type !== "ready") {
      throw new Error(
        ready.type === "failed"
          ? `Outbox benchmark client failed during startup: ${ready.error}`
          : "Outbox benchmark client completed before receiving a workload.",
      );
    }
    return client;
  } catch (error) {
    client.kill();
    throw error;
  }
}

async function prepareOutboxClientWorkload(
  client: ChildProcess,
  config: OutboxBenchmarkClientConfig,
): Promise<void> {
  const response = waitForBenchmarkChildMessage(
    client,
    parseOutboxBenchmarkClientMessage,
    "Outbox benchmark",
  );
  await sendBenchmarkChildMessage(client, { type: "start", config });
  const message = await response;
  if (message.type === "failed") {
    throw new Error(`Outbox benchmark client failed: ${message.error}`);
  }
  if (message.type !== "started") {
    throw new Error("Outbox benchmark client did not prepare the workload.");
  }
}

async function runPreparedOutboxClientWorkload(
  client: ChildProcess,
  startMeasuredWork: () => void,
): Promise<OutboxBenchmarkClientResult> {
  const response = waitForBenchmarkChildMessage(
    client,
    parseOutboxBenchmarkClientMessage,
    "Outbox benchmark",
  );
  await sendBenchmarkChildMessage(client, { type: "run" });
  startMeasuredWork();
  const message = await response;
  if (message.type === "failed") {
    throw new Error(`Outbox benchmark client failed: ${message.error}`);
  }
  if (message.type !== "complete") {
    throw new Error("Outbox benchmark client did not complete the workload.");
  }
  return message.result;
}

async function runOutboxBenchmark(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: pnpm measure:outbox -- [--stream] [--live] [--profile] [--entries COUNT] [--history-entries COUNT] [--payload-kib KIB] [--consumer-delay-ms MS] [--clients COUNT] [--lagging-clients COUNT]\nBacklog mode preloads measured entries before connecting. --live connects current clients at the tail plus divergent historical clients, then appends measured entries. Defaults: 1000 measured entries, 100 historical entries, 128 KiB payloads, 5 ms consumer delay, 1 current client, 1 lagging client.",
    );
    return;
  }

  const config = parseOutboxBenchmarkArguments(process.argv.slice(2));
  const directory = await mkdtemp(path.join(tmpdir(), "fragno-outbox-benchmark-"));
  const databasePath = path.join(directory, "outbox-benchmark.sqlite");
  let outboxDatabaseReadCount = 0;
  const sqlite = new Database(databasePath, {
    verbose: (statement) => {
      if (typeof statement === "string" && isOutboxDatabaseReadStatement(statement)) {
        outboxDatabaseReadCount += 1;
      }
    },
  });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("cache_size = -2048");
  const writerSqlite = new Database(databasePath);
  writerSqlite.pragma("journal_mode = WAL");
  writerSqlite.pragma("cache_size = -2048");
  const databaseAdapter = new SqlAdapter({
    dialect: new SqliteDialect({ database: sqlite }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  let server: Server | null = null;
  let client: ChildProcess | null = null;
  let benchmarkError: unknown;

  try {
    const fragment = instantiateOutboxBenchmarkFragment(databaseAdapter);
    await migrate(fragment);
    const initialEntryCount =
      config.scenario === "live" ? config.historyEntryCount : config.entryCount;
    insertOutboxEntries(writerSqlite, 0, initialEntryCount, config.payloadBytes);
    sqlite.pragma("shrink_memory");

    const benchmarkServer = await startOutboxBenchmarkServer(fragment);
    server = benchmarkServer.server;
    client = await spawnOutboxBenchmarkClient();
    await prepareOutboxClientWorkload(client, {
      mode: config.mode,
      workload:
        config.scenario === "live"
          ? {
              kind: "live",
              afterVersionstamp: outboxVersionstamp(config.historyEntryCount - 1),
              laggingObservers: createLaggingObservers(
                config.historyEntryCount,
                config.laggingClientCount,
              ),
            }
          : { kind: "backlog" },
      baseUrl: benchmarkServer.baseUrl,
      entryCount: config.entryCount,
      payloadBytes: config.payloadBytes,
      consumerDelayMs: config.consumerDelayMs,
      pageSize: OUTBOX_PAGE_SIZE,
      pollIntervalMs: OUTBOX_POLL_INTERVAL_MS,
      clientCount: config.clientCount,
    });
    await forceServerGarbageCollection();

    const profileFilePath = path.resolve(
      `outbox-${config.scenario}-${config.mode}-${config.clientCount}-current-${config.laggingClientCount}-lagging-${Date.now()}-${process.pid}.heapprofile`,
    );
    if (config.scenario === "backlog") {
      outboxDatabaseReadCount = 0;
    }
    const measurement = startServerMemoryMeasurement({
      profile: config.profile,
      profileFilePath,
      allocationSampleIntervalBytes: ALLOCATION_SAMPLE_INTERVAL_BYTES,
      memorySampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    });

    let consumption: OutboxBenchmarkClientResult;
    let measured: Awaited<ReturnType<typeof measurement.finish>>;
    try {
      consumption = await runPreparedOutboxClientWorkload(client, () => {
        if (config.scenario === "live") {
          outboxDatabaseReadCount = 0;
          insertOutboxEntries(
            writerSqlite,
            config.historyEntryCount,
            config.entryCount,
            config.payloadBytes,
          );
        }
      });
      measured = await measurement.finish();
    } catch (error) {
      await measurement.abort();
      throw error;
    }

    if (consumption.clientCount !== config.clientCount) {
      throw new Error(
        `Outbox benchmark completed ${consumption.clientCount} clients instead of ${config.clientCount}.`,
      );
    }
    if (
      config.scenario === "live" &&
      (consumption.laggingEntriesConsumedByClient.length !== config.laggingClientCount ||
        consumption.laggingEntriesConsumedByClient.some((count) => count < 1))
    ) {
      throw new Error("Live outbox benchmark did not keep every lagging observer active.");
    }

    await closeBenchmarkChild(client, { type: "close" });
    client = null;
    const memory = await measureRetainedServerMemory(measured);
    const metrics = {
      ...memory,
      kind: "outbox-only",
      nodeVersion: process.version,
      outboxMode: config.mode,
      transport: "node-http",
      measurementScope: "server",
      scenario: config.scenario,
      entryCount: config.entryCount,
      historyEntryCount: config.scenario === "live" ? config.historyEntryCount : 0,
      clientCount: config.clientCount,
      laggingClientCount: config.scenario === "live" ? config.laggingClientCount : 0,
      payloadBytesPerEntry: config.payloadBytes,
      payloadBytesConsumed: consumption.payloadBytesConsumed,
      consumerDelayMs: config.consumerDelayMs,
      pageSize: OUTBOX_PAGE_SIZE,
      durationMs: measured.durationMs,
      entriesPerSecond: (config.entryCount * config.clientCount) / (measured.durationMs / 1_000),
      checksum: consumption.checksum,
      controlFramesConsumed: consumption.controlFramesConsumed,
      slowestClientDurationMs: consumption.slowestClientDurationMs,
      laggingEntriesConsumed: consumption.laggingEntriesConsumedByClient.reduce(
        (total, count) => total + count,
        0,
      ),
      laggingEntriesConsumedByClient: consumption.laggingEntriesConsumedByClient,
      outboxDatabaseReadCount,
    } satisfies OutboxBenchmarkMetrics;

    if (measured.profile.kind === "written") {
      await writeFile(
        measured.profile.filePath.replace(/\.heapprofile$/, ".benchmark-metrics.json"),
        `${JSON.stringify(metrics, null, 2)}\n`,
      );
    }
    console.log(
      JSON.stringify(
        { ...metrics, timeline: undefined, timelineSamples: metrics.timeline.length },
        null,
        2,
      ),
    );
  } catch (error) {
    benchmarkError = error;
  } finally {
    if (client) {
      await closeBenchmarkChild(client, { type: "close" }).catch(() => {
        client?.kill();
      });
    }
    if (server) {
      await closeOutboxBenchmarkServer(server).catch(() => {
        server?.closeAllConnections();
      });
    }
    try {
      writerSqlite.close();
      await closeDatabaseAdapterAfterStreamCancellation(databaseAdapter);
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (benchmarkError === undefined) {
        benchmarkError = error;
      } else {
        console.error("Outbox benchmark cleanup failed after the workload error.", error);
      }
    }
  }

  if (benchmarkError !== undefined) {
    throw benchmarkError instanceof Error ? benchmarkError : new Error(String(benchmarkError));
  }
}

await runOutboxBenchmark();
