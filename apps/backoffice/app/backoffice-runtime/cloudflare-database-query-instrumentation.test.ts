import { describe, expect, test, vi } from "vitest";

import { createCloudflareDatabaseQueryInstrumentation } from "./cloudflare-database-query-instrumentation";

function queryMetrics({
  sql,
  rowsRead,
  rowsWritten,
  rowsReturned,
}: {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
  rowsReturned: number;
}) {
  return { sql, rowsRead, rowsWritten, rowsReturned };
}

describe("createCloudflareDatabaseQueryInstrumentation", () => {
  test("logs heavy query windows grouped by database and compiled SQL", () => {
    let now = Date.parse("2026-08-29T15:58:20Z");
    const logQueryMetrics = vi.fn();
    const instrumentation = createCloudflareDatabaseQueryInstrumentation({
      durableObjectId: "object-1",
      nowEpochMs: () => now,
      logQueryMetrics,
    });
    const automations = instrumentation.forDatabase({ kind: "automations", name: "primary" });
    const workflows = instrumentation.forDatabase({ kind: "workflows", name: null });

    automations.recordQuery(
      queryMetrics({
        sql: "select  *\nfrom automation_events where id = ?",
        rowsRead: 600,
        rowsWritten: 0,
        rowsReturned: 2,
      }),
    );
    now += 250;
    workflows.recordQuery(
      queryMetrics({
        sql: "insert into workflow_steps (id) values (?)",
        rowsRead: 500,
        rowsWritten: 125,
        rowsReturned: 0,
      }),
    );

    expect(logQueryMetrics.mock.calls).toEqual([
      [
        "backoffice.durable_object_sql.query_metrics",
        {
          durableObjectId: "object-1",
          windowStartedAt: "2026-08-29T15:58:20.000Z",
          windowDurationMs: 250,
          databaseKind: "workflows",
          databaseName: null,
          sql: "insert into workflow_steps (id) values (?)",
          sqlTruncated: false,
          queryCount: 1,
          rowsRead: 500,
          rowsWritten: 125,
          rowsReturned: 0,
        },
      ],
      [
        "backoffice.durable_object_sql.query_metrics",
        {
          durableObjectId: "object-1",
          windowStartedAt: "2026-08-29T15:58:20.000Z",
          windowDurationMs: 250,
          databaseKind: "automations",
          databaseName: "primary",
          sql: "select * from automation_events where id = ?",
          sqlTruncated: false,
          queryCount: 1,
          rowsRead: 600,
          rowsWritten: 0,
          rowsReturned: 2,
        },
      ],
    ]);
  });

  test("aggregates repeated statements before logging", () => {
    let now = 0;
    const logQueryMetrics = vi.fn();
    const database = createCloudflareDatabaseQueryInstrumentation({
      durableObjectId: "object-1",
      nowEpochMs: () => now,
      logQueryMetrics,
    }).forDatabase({ kind: "pi", name: null });

    for (let index = 0; index < 10; index += 1) {
      now += 100;
      database.recordQuery(
        queryMetrics({
          sql: "select * from session_events",
          rowsRead: 100,
          rowsWritten: 0,
          rowsReturned: 10,
        }),
      );
    }

    expect(logQueryMetrics).toHaveBeenCalledOnce();
    expect(logQueryMetrics.mock.calls[0]?.[1]).toMatchObject({
      queryCount: 10,
      rowsRead: 1_000,
      rowsWritten: 0,
      rowsReturned: 100,
    });
  });

  test("discards low-activity windows instead of logging idle polling", () => {
    let now = 0;
    const logQueryMetrics = vi.fn();
    const database = createCloudflareDatabaseQueryInstrumentation({
      durableObjectId: "object-1",
      nowEpochMs: () => now,
      logQueryMetrics,
    }).forDatabase({ kind: "automations", name: null });

    database.recordQuery(
      queryMetrics({ sql: "select * from outbox", rowsRead: 20, rowsWritten: 0, rowsReturned: 0 }),
    );
    now = 5_001;
    database.recordQuery(
      queryMetrics({ sql: "select 1", rowsRead: 0, rowsWritten: 0, rowsReturned: 1 }),
    );

    expect(logQueryMetrics).not.toHaveBeenCalled();
  });
});
