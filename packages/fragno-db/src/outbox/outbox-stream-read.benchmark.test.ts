import { assert, describe, it } from "vitest";

// Measures what reading the outbox stream costs, stage by stage, over a production outbox
// download. It runs only when FRAGNO_OUTBOX_FIXTURE names an `outbox.jsonl` of stream frames:
//
//   FRAGNO_OUTBOX_FIXTURE=~/dev/fragno-fixtures/outbox-dl-2026-10-23/outbox.jsonl \
//     pnpm exec vitest run src/outbox/outbox-stream-read.benchmark.test.ts \
//     --coverage.enabled=false --silent=false
//
// The report is written to `<fixture>.<size>.bench.sqlite.report.txt`. The fixture's entries are stored the way the SQL adapter writes them: one outbox row per entry
// and one mutation row per operation, each with its operation's SuperJSON payload. The database
// is kept in a file next to the fixture and rebuilt when the fixture changes.
//
// Stages, each over the whole outbox in pages of FRAGNO_OUTBOX_PAGE_SIZE:
// - adapter: `streamSerializedOutboxEntries`, reading pages and turning rows into entry JSON; "of
//   which db" is the time spent inside the driver's queries.
// - route: the outbox stream route, read to its caught-up frame.
// - route+brotli: the same, compressed the way Backoffice's Automations object compresses it.
// Coverage instrumentation slows every line, so it must be off.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { constants, createBrotliCompress } from "node:zlib";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import superjson from "superjson";

import { defineFragment, instantiate } from "@fragno-dev/core";

import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { createColdKysely } from "../adapters/generic-sql/migration/cold-kysely";
import { internalSchema } from "../fragments/internal-fragment";
import { createId } from "../id";
import { createSQLSerializer } from "../query/serialize/create-sql-serializer";
import { column, idColumn, schema } from "../schema/create";
import { withDatabase } from "../with-database";
import { FRAGNO_OUTBOX_PAGE_SIZE, type OutboxOperation, type OutboxPayload } from "./outbox";

const fixturePath = process.env["FRAGNO_OUTBOX_FIXTURE"]?.replace(/^~/, process.env["HOME"] ?? "");

type FixtureEntry = {
  versionstamp: string;
  uowId: string;
  payload: { json: unknown; meta?: unknown };
  refMap?: unknown;
};

const benchSchema = schema("outbox_stream_bench", (s) =>
  s.addTable("bench_items", (t) =>
    t.addColumn("id", idColumn()).addColumn("name", column("string")),
  ),
);

function readFixtureEntries(path: string): FixtureEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; entry?: FixtureEntry })
    .flatMap((frame) => (frame.type === "entry" && frame.entry ? [frame.entry] : []));
}

async function openAdapter(databasePath: string) {
  const database = new SQLite(databasePath);
  const adapter = new SqlAdapter({
    dialect: new SqliteDialect({ database }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  return { database, adapter };
}

/** Stores the fixture as the SQL adapter's outbox writes would have. */
async function loadFixture(adapter: SqlAdapter, entries: FixtureEntry[]) {
  await adapter.prepareMigrations(internalSchema, null).executeWithDriver(adapter.driver, 0);
  const serializer = createSQLSerializer(adapter.driverConfig);
  const db = createColdKysely(adapter.driverConfig.databaseType);
  const outboxTable = internalSchema.tables.fragno_db_outbox;
  const mutationsTable = internalSchema.tables.fragno_db_outbox_mutations;
  const serializeRow = (
    table: typeof outboxTable | typeof mutationsTable,
    values: Record<string, unknown>,
  ) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const col = table.getColumnByName(key);
        return col ? [col.name, serializer.serialize(value, col)] : [key, value];
      }),
    );
  for (let start = 0; start < entries.length; start += 500) {
    await adapter.driver.transaction(async (tx) => {
      for (const entry of entries.slice(start, start + 500)) {
        const payload = superjson.deserialize(entry.payload as never) as OutboxPayload;
        for (const operation of payload.operations as OutboxOperation[]) {
          const row = serializeRow(mutationsTable, {
            id: createId(),
            entryVersionstamp: entry.versionstamp,
            mutationVersionstamp: operation.versionstamp,
            uowId: entry.uowId,
            schema: operation.schema,
            table: operation.table,
            externalId: operation.op === "truncate" ? null : operation.externalId,
            op: operation.op,
            payload: superjson.serialize(operation),
          });
          await tx.executeQuery(db.insertInto("fragno_db_outbox_mutations").values(row).compile());
        }
        const row = serializeRow(outboxTable, {
          id: createId(),
          versionstamp: entry.versionstamp,
          uowId: entry.uowId,
          payload: superjson.serialize({ version: payload.version, operations: [] }),
          refMap: entry.refMap ?? null,
        });
        await tx.executeQuery(db.insertInto("fragno_db_outbox").values(row).compile());
      }
    });
  }
}

type Measurement = { wallMs: number; cpuMs: number };

async function measure(run: () => Promise<void>): Promise<Measurement> {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  await run();
  const cpu = process.cpuUsage(cpuStart);
  return {
    wallMs: Math.round(performance.now() - wallStart),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  };
}

describe.skipIf(!fixturePath)("outbox stream read benchmark", () => {
  it("measures each stage of streaming the fixture's outbox", { timeout: 900_000 }, async () => {
    assert(fixturePath && existsSync(fixturePath), `No fixture at ${fixturePath}.`);
    const fixtureStat = statSync(fixturePath);
    const databasePath = `${fixturePath}.${fixtureStat.size}.bench.sqlite`;
    const entries = readFixtureEntries(fixturePath);

    if (!existsSync(databasePath)) {
      const { database, adapter } = await openAdapter(`${databasePath}.partial`);
      const load = await measure(() => loadFixture(adapter, entries));
      process.stdout.write(`Stored ${entries.length} entries in ${load.wallMs} ms.\n`);
      await adapter.close();
      database.close();
      await rename(`${databasePath}.partial`, databasePath);
    }

    const { database, adapter } = await openAdapter(databasePath);
    try {
      const pageSize = FRAGNO_OUTBOX_PAGE_SIZE;
      const results: Record<string, Measurement & { entries?: number; bytes?: number }> = {};

      // The adapter's page reads, over every page. Time spent inside the driver's calls is the
      // database's share; the rest turns rows into entry JSON.
      let driverMs = 0;
      const driver = adapter.driver;
      const executeQuery = driver.executeQuery.bind(driver);
      const streamQuery = driver.streamQuery.bind(driver);
      driver.executeQuery = (async (...args: Parameters<typeof executeQuery>) => {
        const startedAt = performance.now();
        try {
          return await executeQuery(...args);
        } finally {
          driverMs += performance.now() - startedAt;
        }
      }) as typeof driver.executeQuery;
      driver.streamQuery = ((...args: Parameters<typeof streamQuery>) => {
        const iterator = streamQuery(...args)[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            const startedAt = performance.now();
            try {
              return await iterator.next();
            } finally {
              driverMs += performance.now() - startedAt;
            }
          },
          async return(value?: unknown) {
            return (await iterator.return?.(value)) ?? { done: true as const, value: undefined };
          },
        };
      }) as typeof driver.streamQuery;
      {
        let count = 0;
        let bytes = 0;
        const measured = await measure(async () => {
          let after: string | undefined;
          for (;;) {
            let pageCount = 0;
            for await (const entry of adapter.streamSerializedOutboxEntries({
              limit: pageSize,
              afterVersionstamp: after,
            })) {
              bytes += entry.entryJson.length;
              pageCount += 1;
              after = entry.versionstamp;
            }
            count += pageCount;
            if (pageCount < pageSize) {
              break;
            }
          }
        });
        results["adapter"] = { ...measured, entries: count, bytes };
        results["  of which db"] = { wallMs: Math.round(driverMs), cpuMs: Number.NaN };
      }
      driver.executeQuery = executeQuery;
      driver.streamQuery = streamQuery;

      const fragment = instantiate(
        defineFragment("outbox-stream-bench").extend(withDatabase(benchSchema)).build(),
      )
        .withOptions({ databaseAdapter: adapter, mountRoute: "/bench", outbox: { enabled: true } })
        .build();

      const readStream = async (compress: boolean) => {
        const response = await fragment.handler(
          new Request(
            `http://localhost/bench/_internal/outbox/stream?protocol=1&limit=${pageSize}`,
          ),
        );
        assert(response.status === 200 && response.body);
        let body: ReadableStream<Uint8Array> = response.body;
        let compressedBytes = 0;
        if (compress) {
          const compressor = createBrotliCompress({
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 4,
              [constants.BROTLI_PARAM_LGWIN]: 22,
            },
          });
          compressor.on("data", (chunk: Buffer) => {
            compressedBytes += chunk.byteLength;
          });
          let flushTimer: ReturnType<typeof setTimeout> | undefined;
          body = body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              async transform(chunk, controller) {
                clearTimeout(flushTimer);
                await new Promise<void>((resolve) => {
                  compressor.write(chunk, () => {
                    resolve();
                  });
                });
                flushTimer = setTimeout(() => {
                  compressor.flush();
                }, 0);
                controller.enqueue(chunk);
              },
            }),
          );
        }
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let lines = 0;
        for (;;) {
          const { done, value } = await reader.read();
          assert(!done, "The stream ended before catching up.");
          bytes += value.byteLength;
          for (let index = value.indexOf(10); index >= 0; index = value.indexOf(10, index + 1)) {
            lines += 1;
          }
          const tail = decoder.decode(value.subarray(Math.max(0, value.byteLength - 120)));
          if (tail.includes('"type":"caught-up"')) {
            break;
          }
        }
        await reader.cancel();
        return { bytes, lines, compressedBytes };
      };

      for (const [name, compress] of [
        ["route", false],
        ["route+brotli", true],
      ] as const) {
        let read = { bytes: 0, lines: 0, compressedBytes: 0 };
        const measured = await measure(async () => {
          read = await readStream(compress);
        });
        results[name] = {
          ...measured,
          entries: read.lines - 2,
          bytes: compress ? read.compressedBytes : read.bytes,
        };
      }

      const report =
        `Outbox stream read benchmark (${entries.length} entries, page size ${pageSize}):\n` +
        Object.entries(results)
          .map(([stage, result]) =>
            Number.isNaN(result.cpuMs)
              ? `  ${stage.padEnd(16)} ${String(result.wallMs).padStart(6)} ms wall`
              : `  ${stage.padEnd(16)} ${String(result.wallMs).padStart(6)} ms wall  ` +
                `${String(result.cpuMs).padStart(6)} ms CPU  ${result.entries ?? ""} entries  ` +
                `${((result.bytes ?? 0) / 1e6).toFixed(1)} MB`,
          )
          .join("\n");
      // Vitest hides console output from passing tests, so the report goes to a file as well.
      writeFileSync(`${databasePath}.report.txt`, `${report}\n`);
      process.stdout.write(`\n${report}\n`);
    } finally {
      await adapter.close();
      database.close();
    }
  });
});
