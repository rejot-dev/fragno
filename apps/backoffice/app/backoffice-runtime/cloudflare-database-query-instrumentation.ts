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
const DATABASE_WINDOW_METRICS_EVENT = "backoffice.durable_object_sql.window_metrics";

type DatabaseQueryMetricsBucket = {
  databaseKind: BackofficeDatabaseAdapterKind;
  databaseName: string | null;
  sql: string;
  sqlTruncated: boolean;
  queryCount: number;
  rowsRead: number;
  rowsWritten: number;
  rowsReturned: number;
  executionMs: number;
};

type DatabaseWindowMetricsBucket = Omit<DatabaseQueryMetricsBucket, "sql" | "sqlTruncated">;

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
    event: typeof DATABASE_QUERY_METRICS_EVENT | typeof DATABASE_WINDOW_METRICS_EVENT,
    fields: (DatabaseQueryMetricsBucket | DatabaseWindowMetricsBucket) & {
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
  const windowBuckets = new Map<string, DatabaseWindowMetricsBucket>();

  const resetWindow = (now: number) => {
    buckets.clear();
    windowBuckets.clear();
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
      for (const bucket of windowBuckets.values()) {
        logQueryMetrics(DATABASE_WINDOW_METRICS_EVENT, {
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

    const databaseKey = `${database.kind}\u0000${database.name ?? ""}`;
    const windowBucket = windowBuckets.get(databaseKey);
    if (windowBucket) {
      windowBucket.queryCount += 1;
      windowBucket.rowsRead += metrics.rowsRead;
      windowBucket.rowsWritten += metrics.rowsWritten;
      windowBucket.rowsReturned += metrics.rowsReturned;
      windowBucket.executionMs += metrics.executionMs;
    } else {
      windowBuckets.set(databaseKey, {
        databaseKind: database.kind,
        databaseName: database.name,
        queryCount: 1,
        rowsRead: metrics.rowsRead,
        rowsWritten: metrics.rowsWritten,
        rowsReturned: metrics.rowsReturned,
        executionMs: metrics.executionMs,
      });
    }

    if (metrics.rowsRead === 0 && metrics.rowsWritten === 0) {
      return;
    }

    const key = `${databaseKey}\u0000${metrics.sql}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.queryCount += 1;
      existing.rowsRead += metrics.rowsRead;
      existing.rowsWritten += metrics.rowsWritten;
      existing.rowsReturned += metrics.rowsReturned;
      existing.executionMs += metrics.executionMs;
    } else {
      buckets.set(key, {
        databaseKind: database.kind,
        databaseName: database.name,
        ...formatDatabaseQuerySql(metrics.sql),
        queryCount: 1,
        rowsRead: metrics.rowsRead,
        rowsWritten: metrics.rowsWritten,
        rowsReturned: metrics.rowsReturned,
        executionMs: metrics.executionMs,
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
