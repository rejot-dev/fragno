import type {
  DurableObjectQueryInstrumentation,
  DurableObjectQueryMetrics,
} from "@fragno-dev/db/dialects/durable-object";

import type { BackofficeDatabaseAdapterKind } from "./database-adapters";

const DATABASE_QUERY_METRICS_WINDOW_MS = 5_000;
const DATABASE_QUERY_ROWS_READ_THRESHOLD = 1_000;
const DATABASE_QUERY_ROWS_WRITTEN_THRESHOLD = 100;
const DATABASE_QUERY_SQL_LOG_LIMIT = 1_000;
const DATABASE_QUERY_METRICS_EVENT = "backoffice.durable_object_sql.query_metrics";

type DatabaseQueryMetricsBucket = {
  databaseKind: BackofficeDatabaseAdapterKind;
  databaseName: string | null;
  sql: string;
  sqlTruncated: boolean;
  queryCount: number;
  rowsRead: number;
  rowsWritten: number;
  rowsReturned: number;
};

function formatDatabaseQuerySql(sql: string): { sql: string; sqlTruncated: boolean } {
  const compactSql = sql.replace(/\s+/g, " ").trim();
  if (compactSql.length <= DATABASE_QUERY_SQL_LOG_LIMIT) {
    return { sql: compactSql, sqlTruncated: false };
  }

  return {
    sql: `${compactSql.slice(0, DATABASE_QUERY_SQL_LOG_LIMIT - 3)}...`,
    sqlTruncated: true,
  };
}

/** Aggregates Durable Object SQLite row counters by compiled SQL before writing structured logs. */
export function createCloudflareDatabaseQueryInstrumentation({
  durableObjectId,
  nowEpochMs,
  logQueryMetrics,
}: {
  durableObjectId: string;
  nowEpochMs: () => number;
  logQueryMetrics: (
    event: typeof DATABASE_QUERY_METRICS_EVENT,
    fields: DatabaseQueryMetricsBucket & {
      durableObjectId: string;
      windowStartedAt: string;
      windowDurationMs: number;
    },
  ) => undefined;
}) {
  let windowStartedAtEpochMs = nowEpochMs();
  let windowRowsRead = 0;
  let windowRowsWritten = 0;
  const buckets = new Map<string, DatabaseQueryMetricsBucket>();

  const resetWindow = (now: number) => {
    buckets.clear();
    windowStartedAtEpochMs = now;
    windowRowsRead = 0;
    windowRowsWritten = 0;
  };

  const flushWindow = (now: number) => {
    const exceedsLoggingThreshold =
      windowRowsRead >= DATABASE_QUERY_ROWS_READ_THRESHOLD ||
      windowRowsWritten >= DATABASE_QUERY_ROWS_WRITTEN_THRESHOLD;

    if (exceedsLoggingThreshold) {
      const windowStartedAt = new Date(windowStartedAtEpochMs).toISOString();
      const windowDurationMs = Math.max(0, now - windowStartedAtEpochMs);
      const orderedBuckets = [...buckets.values()].sort(
        (left, right) =>
          right.rowsWritten - left.rowsWritten ||
          right.rowsRead - left.rowsRead ||
          right.queryCount - left.queryCount,
      );

      for (const bucket of orderedBuckets) {
        logQueryMetrics(DATABASE_QUERY_METRICS_EVENT, {
          durableObjectId,
          windowStartedAt,
          windowDurationMs,
          ...bucket,
        });
      }
    }

    resetWindow(now);
  };

  const recordDatabaseQuery = (
    database: { kind: BackofficeDatabaseAdapterKind; name: string | null },
    metrics: DurableObjectQueryMetrics,
  ) => {
    const now = nowEpochMs();
    if (now - windowStartedAtEpochMs >= DATABASE_QUERY_METRICS_WINDOW_MS) {
      flushWindow(now);
    }

    if (metrics.rowsRead === 0 && metrics.rowsWritten === 0) {
      return;
    }

    const key = `${database.kind}\u0000${database.name ?? ""}\u0000${metrics.sql}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.queryCount += 1;
      existing.rowsRead += metrics.rowsRead;
      existing.rowsWritten += metrics.rowsWritten;
      existing.rowsReturned += metrics.rowsReturned;
    } else {
      buckets.set(key, {
        databaseKind: database.kind,
        databaseName: database.name,
        ...formatDatabaseQuerySql(metrics.sql),
        queryCount: 1,
        rowsRead: metrics.rowsRead,
        rowsWritten: metrics.rowsWritten,
        rowsReturned: metrics.rowsReturned,
      });
    }

    windowRowsRead += metrics.rowsRead;
    windowRowsWritten += metrics.rowsWritten;
    if (
      windowRowsRead >= DATABASE_QUERY_ROWS_READ_THRESHOLD ||
      windowRowsWritten >= DATABASE_QUERY_ROWS_WRITTEN_THRESHOLD
    ) {
      flushWindow(now);
    }
  };

  return {
    forDatabase(database: {
      kind: BackofficeDatabaseAdapterKind;
      name: string | null;
    }): DurableObjectQueryInstrumentation {
      return {
        recordQuery(metrics) {
          recordDatabaseQuery(database, metrics);
          return undefined;
        },
      };
    },
  };
}
