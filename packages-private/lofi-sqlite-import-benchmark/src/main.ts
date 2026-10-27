import {
  connectLofiSqlite,
  lofiSqliteReadViews,
  lofiSqliteTableName,
  type LofiSqliteClient,
  type LofiSqliteView,
} from "@fragno-dev/lofi/sqlite";

import { IMPORT_READS, importReplica, type ImportTarget, type importReads } from "./import-replica";
import { FIXTURE_BASE_PATH, FIXTURE_INFO_PATH, type OutboxFixtureInfo } from "./outbox-fixture";

declare global {
  interface Window {
    /** What "Copy results JSON" copies, for `measure.ts`. */
    lofiSqliteBenchmarkResults: typeof results;
  }
}

/** The fixture's schema, from the page URL: `?schema=upload` replays an Upload outbox. */
const UPLOAD = new URLSearchParams(location.search).get("schema") === "upload";
const SAMPLE_INTERVAL_MS = 500;
const readView = lofiSqliteReadViews<typeof importReads>(IMPORT_READS);

type Sample = {
  ms: number;
  applied: number;
  /**
   * How long a read view took to answer while the worker imports. The leading worker runs views
   * between the batches it applies.
   */
  readMs: number;
};

type ImportRun = {
  /** Whether Backoffice's views were projected; each choice has its own database. */
  views: boolean;
  /** Entries the replica held before this run, e.g. after a reload. */
  startApplied: number;
  /** Until a worker opened the replica. */
  openMs: number;
  doneMs: number | null;
  samples: Sample[];
  tableCounts: Array<{ table: string; rows: number }>;
  storageUsageBytes: number | null;
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
let importing: { worker: Worker; client: LofiSqliteClient } | null = null;
let importRun: ImportRun | null = null;
let downloadRun: DownloadRun | null = null;

const [registration] = importReplica({ upload: UPLOAD, views: false }).schemas;
elements.fixture.textContent = `${fixture.path}: ${fixture.versionstamps.length} entries, ${formatMb(fixture.bytes)}`;
elements.sql.value = UPLOAD
  ? `SELECT "provider", "status", count(*) AS "count" FROM "${lofiSqliteTableName(registration, "file")}" GROUP BY 1, 2 ORDER BY 3 DESC`
  : `SELECT "source", "eventType", count(*) AS "count" FROM "${lofiSqliteTableName(registration, "automation_event")}" GROUP BY 1, 2 ORDER BY 3 DESC`;
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
    .catch((error: unknown) => {
      reportError(error);
      elements.importButton.disabled = false;
      elements.views.disabled = false;
    })
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
 * Starts a replica worker, which opens the replica and streams the fixture, and samples the
 * replica's cursor until it reaches the last entry. On an empty database, the end time is when the
 * replica reported it caught up, not the sample that saw it. Stops the worker at the replica's
 * first error.
 */
async function runImport(): Promise<void> {
  const target: ImportTarget = { upload: UPLOAD, views: elements.views.checked };
  const startedAt = performance.now();
  const worker = new Worker(new URL("./import.worker.ts", import.meta.url), {
    type: "module",
    name: JSON.stringify(target),
  });
  try {
    await importWith(worker, target, startedAt);
  } catch (error) {
    worker.terminate();
    if (importing?.worker === worker) {
      importing = null;
      elements.runButton.disabled = true;
    }
    throw error;
  }
}

async function importWith(worker: Worker, target: ImportTarget, startedAt: number): Promise<void> {
  const replica = importReplica(target);
  const client = await connectLofiSqlite({
    port: worker,
    schemas: [...replica.schemas, ...replica.localSchemas],
  });
  const current = { worker, client };
  importing = current;
  elements.runButton.disabled = false;

  // The worker keeps retrying a replica it cannot open, or a stream that failed, while views wait
  // for it; an error also spoils the timing, so the run stops instead.
  const failed = new Promise<never>((_resolve, reject) => {
    const rejectOnError = () => {
      const { error } = client.getStatus();
      if (error !== null) {
        reject(new Error(error));
      }
    };
    rejectOnError();
    client.subscribeStatus(rejectOnError);
  });
  const unlessFailed = <T>(promise: Promise<T>) => Promise.race([promise, failed]);

  let caughtUpMs: number | null = null;
  const wasCatchingUp = client.getStatus().phase === "catching-up";
  client.subscribeStatus(() => {
    if (client.getStatus().phase === "caught-up" && wasCatchingUp) {
      caughtUpMs ??= performance.now() - startedAt;
    }
  });

  const run: ImportRun = {
    views: target.views,
    startApplied: (await unlessFailed(readApplied(client))).applied,
    openMs: performance.now() - startedAt,
    doneMs: null,
    samples: [],
    tableCounts: [],
    storageUsageBytes: null,
  };
  importRun = run;

  while (importing === current) {
    const { applied, readMs } = await unlessFailed(readApplied(client));
    const ms = performance.now() - startedAt;
    run.samples.push({ ms, applied, readMs });
    if (applied === fixture.versionstamps.length) {
      run.doneMs = caughtUpMs ?? ms;
      break;
    }
    renderStats();
    await unlessFailed(
      new Promise((resolve) => {
        setTimeout(resolve, SAMPLE_INTERVAL_MS);
      }),
    );
  }
  if (importing !== current) {
    return;
  }
  run.tableCounts = await unlessFailed(readOnce(readView(client, "tableCounts", target)));
  run.storageUsageBytes = (await navigator.storage.estimate()).usage ?? null;
  renderStats();
  elements.copyButton.disabled = false;
}

/** Entries at or before the replica's cursor, which the worker advances after each batch. */
async function readApplied(client: LofiSqliteClient): Promise<{ applied: number; readMs: number }> {
  const startedAt = performance.now();
  const cursor = await readOnce(readView(client, "cursor", undefined));
  const readMs = performance.now() - startedAt;
  return { applied: cursor === null ? 0 : entriesThrough(cursor), readMs };
}

/** A view's first data, after which the view closes. */
function readOnce<TData>(view: LofiSqliteView<TData>): Promise<TData> {
  return new Promise((resolve, reject) => {
    const unlisten = view.listen((result) => {
      if (result.status === "loading") {
        return;
      }
      unlisten();
      if (result.status === "ready") {
        resolve(result.data);
      } else {
        reject(new Error(result.message));
      }
    });
  });
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

/** Stops the replica's worker and removes everything this origin stored in OPFS. */
async function deleteOpfsData(): Promise<void> {
  importing?.worker.terminate();
  importing = null;
  importRun = null;
  elements.runButton.disabled = true;
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) {
    await root.removeEntry(name, { recursive: true });
  }
  renderStats();
}

async function runSql(): Promise<void> {
  if (!importing) {
    return;
  }
  const startedAt = performance.now();
  // A raw SQL view: its rows as SQLite returns them.
  const rows = await readOnce(
    importing.client.view<Array<Record<string, unknown>>>("sql", {
      sql: elements.sql.value,
      params: [],
    }),
  );
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
    for (const { table, rows: count } of run.tableCounts) {
      rows.push([table, `${count} rows`]);
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
