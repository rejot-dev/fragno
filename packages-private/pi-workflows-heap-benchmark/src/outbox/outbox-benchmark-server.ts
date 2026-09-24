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
} from "./outbox-benchmark-protocol";

const OUTBOX_PAGE_SIZE = 50;
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

function preloadOutboxBacklog(
  sqlite: Database.Database,
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
    for (let index = 0; index < entryCount; index += 1) {
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

async function runOutboxClientWorkload(
  client: ChildProcess,
  config: OutboxBenchmarkClientConfig,
): Promise<OutboxBenchmarkClientResult> {
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
  if (message.type !== "complete") {
    throw new Error("Outbox benchmark client sent a duplicate ready message.");
  }
  return message.result;
}

async function runOutboxBenchmark(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: pnpm measure:outbox -- [--stream] [--profile] [--entries COUNT] [--payload-kib KIB] [--consumer-delay-ms MS]\nPreloads a fixed outbox backlog, then consumes it through the buffered poll route or item-wise stream route over localhost HTTP. Defaults: 1000 entries, 128 KiB payloads, 5 ms consumer delay.",
    );
    return;
  }

  const config = parseOutboxBenchmarkArguments(process.argv.slice(2));
  const directory = await mkdtemp(path.join(tmpdir(), "fragno-outbox-benchmark-"));
  const sqlite = new Database(path.join(directory, "outbox-benchmark.sqlite"));
  sqlite.pragma("cache_size = -2048");
  const databaseAdapter = new SqlAdapter({
    dialect: new SqliteDialect({ database: sqlite }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  let server: Server | null = null;
  let client: ChildProcess | null = null;

  try {
    const fragment = instantiateOutboxBenchmarkFragment(databaseAdapter);
    await migrate(fragment);
    preloadOutboxBacklog(sqlite, config.entryCount, config.payloadBytes);
    sqlite.pragma("shrink_memory");

    const benchmarkServer = await startOutboxBenchmarkServer(fragment);
    server = benchmarkServer.server;
    client = await spawnOutboxBenchmarkClient();
    await forceServerGarbageCollection();

    const profileFilePath = path.resolve(
      `outbox-${config.mode}-${Date.now()}-${process.pid}.heapprofile`,
    );
    const measurement = startServerMemoryMeasurement({
      profile: config.profile,
      profileFilePath,
      allocationSampleIntervalBytes: ALLOCATION_SAMPLE_INTERVAL_BYTES,
      memorySampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    });

    let consumption: OutboxBenchmarkClientResult;
    let measured: Awaited<ReturnType<typeof measurement.finish>>;
    try {
      consumption = await runOutboxClientWorkload(client, {
        mode: config.mode,
        baseUrl: benchmarkServer.baseUrl,
        entryCount: config.entryCount,
        payloadBytes: config.payloadBytes,
        consumerDelayMs: config.consumerDelayMs,
        pageSize: OUTBOX_PAGE_SIZE,
        pollIntervalMs: OUTBOX_POLL_INTERVAL_MS,
      });
      measured = await measurement.finish();
    } catch (error) {
      await measurement.abort();
      throw error;
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
      entryCount: config.entryCount,
      payloadBytesPerEntry: config.payloadBytes,
      payloadBytesConsumed: consumption.payloadBytesConsumed,
      consumerDelayMs: config.consumerDelayMs,
      pageSize: OUTBOX_PAGE_SIZE,
      durationMs: measured.durationMs,
      entriesPerSecond: config.entryCount / (measured.durationMs / 1_000),
      checksum: consumption.checksum,
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
    await databaseAdapter.close();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await runOutboxBenchmark();
