import {
  lofiSqliteTableName,
  openLofiSqliteReplica,
  type LofiSqliteReplica,
} from "@fragno-dev/lofi/sqlite";

import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence";

import { automationFragmentSchema } from "../../../apps/backoffice/app/fragno/automation/schema";
import { uploadSchema } from "../../../packages/fragment-upload/src/schema";
import { backofficeViews } from "./backoffice-views";
import { instrumentDatabase, type DatabaseMeasurements } from "./instrumented-database";
import { FIXTURE_BASE_PATH, FIXTURE_INFO_PATH, type OutboxFixtureInfo } from "./outbox-fixture";

declare global {
  interface Window {
    /** The open replica, for running SQL from the browser console. */
    lofiSqliteReplica?: LofiSqliteReplica;
    /** What "Copy results JSON" copies, for `measure.ts`. */
    lofiSqliteBenchmarkResults: typeof results;
  }
}

/** The fixture's schema, from the page URL: `?schema=upload` replays an Upload outbox. */
const UPLOAD = new URLSearchParams(location.search).get("schema") === "upload";
const REGISTRATION = { schema: UPLOAD ? uploadSchema : automationFragmentSchema };
// Older outbox entries still write these tables, which the schema removed with `noOp`, and the
// replica rejects unknown tables of a registered schema.
const REMOVED_TABLES = UPLOAD ? [] : ["sandbox_instance", "marketplace_ingestion"];
// `openLofiSqliteReplica` runs its `LofiClient` with endpoint name "lofi-sqlite".
const CURSOR_META_KEY = "lofi-sqlite::outbox";
const SAMPLE_INTERVAL_MS = 500;
/** Connection settings to try, from the page URL: `?pragma=journal_mode=TRUNCATE&pragma=…`. */
const PRAGMAS = new URLSearchParams(location.search).getAll("pragma");

type Sample = {
  ms: number;
  applied: number;
  /** Latency of a read issued while the writer imports. */
  readMs: number;
};

type ImportRun = {
  /** Whether Backoffice's views were projected; each choice has its own database. */
  views: boolean;
  /** Entries the replica held before this run, e.g. after a reload. */
  startApplied: number;
  openMs: number;
  firstChangeMs: number | null;
  doneMs: number | null;
  samples: Sample[];
  tableCounts: Array<{ table: string; rows: number; ms: number }>;
  storageUsageBytes: number | null;
  /** Taken when the import is done, before the table counts. */
  database: DatabaseMeasurements | null;
};

type DownloadRun = { ms: number; bytes: number; entries: number };

const elements = {
  fixture: element("fixture"),
  views: element("views") as HTMLInputElement,
  importButton: element("import") as HTMLButtonElement,
  downloadButton: element("download") as HTMLButtonElement,
  resetButton: element("reset") as HTMLButtonElement,
  copyButton: element("copy") as HTMLButtonElement,
  stats: element("stats"),
  errors: element("errors"),
  sql: element("sql") as HTMLTextAreaElement,
  runButton: element("run") as HTMLButtonElement,
  sqlTiming: element("sql-timing"),
  sqlResult: element("sql-result"),
};

const fixture = (await (await fetch(FIXTURE_INFO_PATH)).json()) as OutboxFixtureInfo;
let replica: LofiSqliteReplica | null = null;
let importRun: ImportRun | null = null;
let downloadRun: DownloadRun | null = null;

elements.fixture.textContent = `${fixture.path}: ${fixture.versionstamps.length} entries, ${formatMb(fixture.bytes)}`;
elements.sql.value = UPLOAD
  ? `SELECT "provider", "status", count(*) AS "count" FROM "${lofiSqliteTableName(REGISTRATION, "file")}" GROUP BY 1, 2 ORDER BY 3 DESC`
  : `SELECT "source", "eventType", count(*) AS "count" FROM "${lofiSqliteTableName(REGISTRATION, "automation_event")}" GROUP BY 1, 2 ORDER BY 3 DESC`;
for (const button of [elements.importButton, elements.downloadButton, elements.resetButton]) {
  button.disabled = false;
}
renderStats();
window.lofiSqliteBenchmarkResults = results;

elements.importButton.addEventListener("click", () => {
  elements.importButton.disabled = true;
  elements.views.disabled = true;
  elements.resetButton.disabled = true;
  void runImport()
    .catch(reportError)
    .finally(() => {
      elements.resetButton.disabled = false;
    });
});
elements.downloadButton.addEventListener("click", () => {
  elements.downloadButton.disabled = true;
  void runDownload()
    .catch(reportError)
    .finally(() => {
      elements.downloadButton.disabled = false;
    });
});
elements.resetButton.addEventListener("click", () => {
  elements.resetButton.disabled = true;
  void deleteOpfsData()
    .catch(reportError)
    .finally(() => {
      elements.resetButton.disabled = false;
      elements.importButton.disabled = false;
      elements.views.disabled = false;
    });
});
elements.copyButton.addEventListener("click", () => {
  void navigator.clipboard.writeText(JSON.stringify(results(), null, 2));
});
elements.runButton.addEventListener("click", () => {
  void runSql().catch(reportError);
});

/**
 * Opens the replica, which starts streaming the fixture, and samples the persisted cursor until it
 * reaches the last entry. The end time is the last change notification, not the sample that saw it.
 */
async function runImport(): Promise<void> {
  const views = elements.views.checked;
  const local = views ? backofficeViews : { localSchemas: [], projections: [] };
  let measureDatabase: (() => Promise<DatabaseMeasurements>) | null = null;
  const startedAt = performance.now();
  const opened = await openLofiSqliteReplica(
    {
      baseUrl: FIXTURE_BASE_PATH,
      fetch: fetch.bind(globalThis),
      schemas: [REGISTRATION],
      localSchemas: local.localSchemas,
      projections: local.projections,
      ephemeralTables: REMOVED_TABLES.map((table) => ({
        schema: REGISTRATION.schema.name,
        table,
      })),
      onError: reportError,
      retryDelayMs: 5_000,
    },
    {
      openDatabase: async ({ databaseName }) => {
        const database = await openBrowserWASQLiteOPFSDatabase({ databaseName });
        for (const pragma of PRAGMAS) {
          await database.execute(`PRAGMA ${pragma}`);
        }
        const instrumented = instrumentDatabase(database);
        measureDatabase = () => instrumented.measure();
        return instrumented.database;
      },
    },
  );
  const openMs = performance.now() - startedAt;
  replica = opened;
  window.lofiSqliteReplica = opened;
  elements.runButton.disabled = false;

  let lastChangeMs: number | null = null;
  const run: ImportRun = {
    views,
    startApplied: (await readApplied(opened)).applied,
    openMs,
    firstChangeMs: null,
    doneMs: null,
    samples: [],
    tableCounts: [],
    storageUsageBytes: null,
    database: null,
  };
  importRun = run;
  opened.subscribe(() => {
    lastChangeMs = performance.now() - startedAt;
    run.firstChangeMs ??= lastChangeMs;
  });

  while (replica === opened) {
    const { applied, readMs } = await readApplied(opened);
    run.samples.push({ ms: performance.now() - startedAt, applied, readMs });
    if (applied === fixture.versionstamps.length) {
      run.doneMs = lastChangeMs ?? performance.now() - startedAt;
      break;
    }
    renderStats();
    await new Promise((resolve) => {
      setTimeout(resolve, SAMPLE_INTERVAL_MS);
    });
  }
  if (replica !== opened) {
    return;
  }
  run.database = await measureDatabase!();

  for (const registration of [REGISTRATION, ...local.localSchemas]) {
    for (const table of Object.keys(registration.schema.tables)) {
      const name = lofiSqliteTableName(registration, table);
      const countStartedAt = performance.now();
      const [row] = await opened.execute(`SELECT count(*) AS "rows" FROM "${name}"`);
      run.tableCounts.push({
        table: name,
        rows: Number(row?.["rows"]),
        ms: performance.now() - countStartedAt,
      });
    }
  }
  run.storageUsageBytes = (await navigator.storage.estimate()).usage ?? null;
  renderStats();
  elements.copyButton.disabled = false;
}

/** Entries at or before the persisted cursor, which the writer advances after each entry. */
async function readApplied(
  opened: LofiSqliteReplica,
): Promise<{ applied: number; readMs: number }> {
  const startedAt = performance.now();
  const [row] = await opened.execute(`SELECT "value" FROM "lofi_meta" WHERE "key" = ?`, [
    CURSOR_META_KEY,
  ]);
  const readMs = performance.now() - startedAt;
  const cursor = row ? String(row["value"]) : null;
  return { applied: cursor === null ? 0 : entriesThrough(cursor), readMs };
}

function entriesThrough(versionstamp: string): number {
  const versionstamps = fixture.versionstamps;
  let low = 0;
  let high = versionstamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (versionstamps[middle] <= versionstamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Baseline without SQLite: receive and parse every frame of the stream until `caught-up`. */
async function runDownload(): Promise<void> {
  const controller = new AbortController();
  const startedAt = performance.now();
  const response = await fetch(`${FIXTURE_BASE_PATH}/_internal/outbox/stream?protocol=1`, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let entries = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error("The fixture stream closed before caught-up.");
    }
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const frame = JSON.parse(line) as { type: string };
      if (frame.type === "entry") {
        entries++;
      } else if (frame.type === "caught-up") {
        controller.abort();
        downloadRun = { ms: performance.now() - startedAt, bytes, entries };
        renderStats();
        elements.copyButton.disabled = false;
        return;
      }
    }
  }
}

/** Closes the replica and removes everything this origin stored in OPFS. */
async function deleteOpfsData(): Promise<void> {
  const closing = replica;
  replica = null;
  importRun = null;
  delete window.lofiSqliteReplica;
  elements.runButton.disabled = true;
  await closing?.close();
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) {
    await root.removeEntry(name, { recursive: true });
  }
  renderStats();
}

async function runSql(): Promise<void> {
  if (!replica) {
    return;
  }
  const startedAt = performance.now();
  const rows = await replica.execute(elements.sql.value);
  elements.sqlTiming.textContent = `${rows.length} rows in ${formatMs(performance.now() - startedAt)}`;
  elements.sqlResult.textContent = JSON.stringify(
    rows.slice(0, 200),
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

function renderStats(): void {
  const total = fixture.versionstamps.length;
  const rows: Array<[string, string]> = [];
  if (downloadRun) {
    rows.push([
      "Download only",
      `${downloadRun.entries} entries, ${formatMb(downloadRun.bytes)} in ${formatMs(downloadRun.ms)} (${rate(downloadRun.entries, downloadRun.ms)} entries/s, ${formatMb((downloadRun.bytes / downloadRun.ms) * 1000)}/s)`,
    ]);
  }
  if (importRun) {
    const run = importRun;
    const last = run.samples.at(-1);
    const previous = run.samples.at(-2);
    const applied = last?.applied ?? run.startApplied;
    const elapsedMs = run.doneMs ?? last?.ms ?? run.openMs;
    const importedMs = elapsedMs - run.openMs;
    rows.push(
      ["Backoffice views", run.views ? "projected" : "not projected"],
      ["Open replica", formatMs(run.openMs)],
      ["First change", run.firstChangeMs === null ? "–" : formatMs(run.firstChangeMs)],
      [
        "Applied",
        `${applied} / ${total} (${((applied / total) * 100).toFixed(1)}%), ${run.startApplied} before this run`,
      ],
      ["Elapsed", formatMs(elapsedMs)],
      ["Average rate", `${rate(applied - run.startApplied, importedMs)} entries/s`],
    );
    if (last && previous && run.doneMs === null) {
      const recent = (last.applied - previous.applied) / ((last.ms - previous.ms) / 1000);
      rows.push(
        ["Current rate", `${Math.round(recent)} entries/s`],
        ["ETA", recent > 0 ? formatMs(((total - applied) / recent) * 1000) : "–"],
      );
    }
    if (last) {
      const reads = run.samples.map(({ readMs }) => readMs);
      rows.push([
        "Read latency during import",
        `last ${formatMs(last.readMs)}, max ${formatMs(Math.max(...reads))}`,
      ]);
    }
    rows.push(["Done", run.doneMs === null ? "no" : `in ${formatMs(run.doneMs)}`]);
    if (run.database) {
      rows.push(...databaseRows(run.database, run.doneMs! - run.openMs));
    }
    for (const { table, rows: count, ms } of run.tableCounts) {
      rows.push([table, `${count} rows (count in ${formatMs(ms)})`]);
    }
    if (run.storageUsageBytes !== null) {
      rows.push(["Origin storage usage", formatMb(run.storageUsageBytes)]);
    }
  }
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  if (memory) {
    rows.push(["Page JS heap", formatMb(memory.usedJSHeapSize)]);
  }
  elements.stats.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("tr");
      const header = document.createElement("th");
      header.textContent = label;
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(header, cell);
      return row;
    }),
  );
}

/** Where the import's time went, from the instrumented connection. */
function databaseRows(database: DatabaseMeasurements, importMs: number): Array<[string, string]> {
  const percent = (ms: number) => `${Math.round((ms / importMs) * 100)}%`;
  const commit = database.statements.find(({ statement }) => statement === "COMMIT");
  return [
    [
      "Waiting on the database",
      `${formatMs(database.busyMs)} (${percent(database.busyMs)} of the import), ${database.transactions} transactions`,
    ],
    [
      "Outside the database",
      `${formatMs(importMs - database.busyMs)} (${percent(importMs - database.busyMs)})`,
    ],
    ...database.statements
      .slice(0, 8)
      .map(({ statement, count, totalMs, maxMs }): [string, string] => [
        statement,
        `${count}×, ${formatMs(totalMs)} (${percent(totalMs)}), avg ${(totalMs / count).toFixed(2)} ms, max ${formatMs(maxMs)}`,
      ]),
    ...database.tenths.map(
      ({ avgMs, avgCommitMs, avgStatements, avgParamKb }, index): [string, string] => [
        `Transactions ${index * 10}–${(index + 1) * 10}%`,
        `avg ${avgMs.toFixed(2)} ms, commit ${avgCommitMs.toFixed(2)} ms, ${avgStatements.toFixed(1)} statements, ${avgParamKb.toFixed(1)} kB params`,
      ],
    ),
    ["Probe: SELECT 1 round trip", `${database.probes.selectOneMedianMs.toFixed(2)} ms median`],
    [
      "Probe: 200 rows",
      `${formatMs(database.probes.rowsPerTransaction1Ms)} in 200 transactions, ${formatMs(database.probes.rowsPerTransaction200Ms)} in one`,
    ],
    ["PRAGMAs", JSON.stringify(database.pragmas)],
    [
      "Commits",
      commit ? `${commit.count}, avg ${(commit.totalMs / commit.count).toFixed(2)} ms` : "–",
    ],
  ];
}

function results() {
  return {
    fixture: {
      path: fixture.path,
      bytes: fixture.bytes,
      entries: fixture.versionstamps.length,
    },
    userAgent: navigator.userAgent,
    download: downloadRun,
    import: importRun,
  };
}

function reportError(error: unknown): void {
  console.error(error);
  elements.errors.textContent += `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
}

function element(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function rate(entries: number, ms: number): number {
  return ms > 0 ? Math.round((entries / ms) * 1000) : 0;
}

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
