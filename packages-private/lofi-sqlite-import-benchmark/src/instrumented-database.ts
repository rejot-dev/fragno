import type { LofiSqliteDatabase } from "@fragno-dev/lofi/sqlite";

type Database = LofiSqliteDatabase & { close?: () => Promise<void> | void };

/** Statements of one kind, such as `INSERT automation_event_automations` or `COMMIT`. */
export type StatementStats = { statement: string; count: number; totalMs: number; maxMs: number };

/** One `BEGIN`…`COMMIT`; the replica applies each outbox entry in one. */
type Transaction = { durationMs: number; commitMs: number; statements: number; paramBytes: number };

/** Transactions in order, split into tenths, to tell growing entries from a growing database. */
export type TransactionTenth = {
  transactions: number;
  avgMs: number;
  avgCommitMs: number;
  avgStatements: number;
  avgParamKb: number;
};

export type DatabaseMeasurements = {
  /** Time the page waited on statements; the rest of the import ran outside the database. */
  busyMs: number;
  statements: StatementStats[];
  transactions: number;
  tenths: TransactionTenth[];
  slowestTransactions: Transaction[];
  pragmas: Record<string, unknown>;
  probes: {
    /** Median round trip of `SELECT 1`, the cost of one call to the worker. */
    selectOneMedianMs: number;
    /** 200 one-row transactions against one transaction of 200 rows. */
    rowsPerTransaction1Ms: number;
    rowsPerTransaction200Ms: number;
  };
};

const PRAGMAS = ["journal_mode", "synchronous", "page_size", "cache_size", "locking_mode"];
const PROBE_ROWS = 200;
const PROBE_TABLE = "benchmark_probe";

/**
 * Times every statement the replica sends to the OPFS worker. Times are round trips seen from the
 * page, so they include messaging to the worker; Chrome rounds `performance.now()` to 0.1 ms on
 * pages that are not cross-origin isolated, so only sums and averages are meaningful.
 */
export function instrumentDatabase(database: Database): {
  database: Database;
  measure(): Promise<DatabaseMeasurements>;
} {
  const statements = new Map<string, StatementStats>();
  const transactions: Transaction[] = [];
  let current: Transaction | null = null;
  let currentStartedAt = 0;
  let busyMs = 0;

  const instrumented: Database = {
    async execute(sql, params = []) {
      const kind = statementKind(sql);
      if (kind === "BEGIN") {
        current = { durationMs: 0, commitMs: 0, statements: 0, paramBytes: 0 };
        currentStartedAt = performance.now();
      }
      const startedAt = performance.now();
      try {
        return await database.execute(sql, params);
      } finally {
        const ms = performance.now() - startedAt;
        busyMs += ms;
        const stats = statements.get(kind) ?? { statement: kind, count: 0, totalMs: 0, maxMs: 0 };
        stats.count++;
        stats.totalMs += ms;
        stats.maxMs = Math.max(stats.maxMs, ms);
        statements.set(kind, stats);
        if (current) {
          current.statements++;
          current.paramBytes += paramBytes(params);
          if (kind === "COMMIT" || kind === "ROLLBACK") {
            current.commitMs = ms;
            current.durationMs = performance.now() - currentStartedAt;
            transactions.push(current);
            current = null;
          }
        }
      }
    },
    close: database.close?.bind(database),
  };

  return {
    database: instrumented,
    async measure() {
      // Read the underlying connection, so the probes do not count as the replica's statements.
      const pragmas: Record<string, unknown> = {};
      for (const pragma of PRAGMAS) {
        const [row] = await database.execute(`PRAGMA ${pragma}`);
        pragmas[pragma] = row ? Object.values(row)[0] : null;
      }
      return {
        busyMs,
        statements: [...statements.values()].sort((left, right) => right.totalMs - left.totalMs),
        transactions: transactions.length,
        tenths: splitIntoTenths(transactions),
        slowestTransactions: [...transactions]
          .sort((left, right) => right.durationMs - left.durationMs)
          .slice(0, 10),
        pragmas,
        probes: await probe(database),
      };
    },
  };
}

/** The verb and, for reads and writes, the table: `INSERT automation_event_automations`. */
function statementKind(sql: string): string {
  const words = sql.trim().replaceAll('"', "").split(/\s+/u);
  const verb = words[0].toUpperCase();
  const tableAfter = (keyword: string) => {
    const index = words.findIndex((word) => word.toUpperCase() === keyword);
    return index === -1 ? null : words[index + 1].split("(")[0];
  };
  const table =
    verb === "INSERT"
      ? tableAfter("INTO")
      : verb === "UPDATE"
        ? (words[1] ?? null)
        : verb === "DELETE" || verb === "SELECT"
          ? tableAfter("FROM")
          : null;
  return table ? `${verb} ${table}` : verb;
}

function paramBytes(params: ReadonlyArray<unknown>): number {
  return params.reduce<number>(
    (bytes, param) =>
      bytes +
      (typeof param === "string"
        ? param.length
        : param instanceof Uint8Array
          ? param.byteLength
          : 8),
    0,
  );
}

function splitIntoTenths(transactions: Transaction[]): TransactionTenth[] {
  const size = Math.ceil(transactions.length / 10);
  return Array.from({ length: 10 }, (_, tenth) =>
    transactions.slice(tenth * size, (tenth + 1) * size),
  )
    .filter((slice) => slice.length > 0)
    .map((slice) => {
      const average = (value: (transaction: Transaction) => number) =>
        slice.reduce((sum, transaction) => sum + value(transaction), 0) / slice.length;
      return {
        transactions: slice.length,
        avgMs: average(({ durationMs }) => durationMs),
        avgCommitMs: average(({ commitMs }) => commitMs),
        avgStatements: average(({ statements: count }) => count),
        avgParamKb: average(({ paramBytes: bytes }) => bytes) / 1000,
      };
    });
}

/** Runs after the import, while nothing else writes, on a table it drops again. */
async function probe(database: Database): Promise<DatabaseMeasurements["probes"]> {
  const selectOne: number[] = [];
  for (let index = 0; index < PROBE_ROWS; index++) {
    const startedAt = performance.now();
    await database.execute("SELECT 1");
    selectOne.push(performance.now() - startedAt);
  }
  selectOne.sort((left, right) => left - right);

  await database.execute(`CREATE TABLE ${PROBE_TABLE} ("id" INTEGER PRIMARY KEY, "value" TEXT)`);
  const value = "x".repeat(200);
  const oneRowEach = performance.now();
  for (let index = 0; index < PROBE_ROWS; index++) {
    await database.execute("BEGIN IMMEDIATE");
    await database.execute(`INSERT INTO ${PROBE_TABLE} ("value") VALUES (?)`, [value]);
    await database.execute("COMMIT");
  }
  const rowsPerTransaction1Ms = performance.now() - oneRowEach;
  const allRows = performance.now();
  await database.execute("BEGIN IMMEDIATE");
  for (let index = 0; index < PROBE_ROWS; index++) {
    await database.execute(`INSERT INTO ${PROBE_TABLE} ("value") VALUES (?)`, [value]);
  }
  await database.execute("COMMIT");
  const rowsPerTransaction200Ms = performance.now() - allRows;
  await database.execute(`DROP TABLE ${PROBE_TABLE}`);

  return {
    selectOneMedianMs: selectOne[Math.floor(selectOne.length / 2)],
    rowsPerTransaction1Ms,
    rowsPerTransaction200Ms,
  };
}
