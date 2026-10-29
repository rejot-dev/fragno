// One value a workflow keeps checking: an hourly run reads an order's expected delivery from the
// shop, and its compare-and-save-json step saves each estimate. The estimate leads, its history
// follows, and the side column holds the schedule and recent checks, grouped into streaks. Copy it
// into /workspace as a <name>.page.js file to open it or start from it.
export default page.define({ title: "Order delivery" }, ({ sql, now }) => {
  // Every estimate a check saved, oldest first.
  const saved = sql`
    SELECT step.id, step.updatedAt AS at,
      step.result ->> '$.expectedDelivery' AS estimate,
      step.result ->> '$.changed' AS changed,
      step.result ->> '$.pending.from' AS previous,
      row_number() OVER (ORDER BY step.updatedAt, step.id) AS n
    FROM steps step JOIN runs run ON run.id = step.runId
    WHERE run.remoteWorkflowName = 'order-delivery-monitor'
      AND step.name = 'compare-and-save-json' AND step.status = 'completed'
      AND step.result ->> '$.expectedDelivery' IS NOT NULL
  `;

  const current = sql`
    SELECT estimate, at AS checkedAt,
      CASE WHEN at < ${now.minus("2 hours")} THEN 'Out of date' ELSE 'Up to date' END AS freshness,
      CASE WHEN at < ${now.minus("2 hours")} THEN 'waiting' ELSE 'live' END AS tone
    FROM (${saved}) ORDER BY at DESC, id DESC LIMIT 1
  `.columns({
    estimate: "string",
    checkedAt: "time?",
    freshness: "string",
    tone: ["waiting", "live"],
  });

  // The first estimate and every change after it, newest first.
  const history = sql`
    SELECT id, estimate, at,
      CASE WHEN n = 1 THEN 'First estimate' ELSE 'Was ' || previous END AS change
    FROM (${saved}) WHERE n = 1 OR changed = 1
    ORDER BY at DESC, id DESC LIMIT 20
  `.columns({ estimate: "string", change: "string", at: "time" });

  const schedule = sql`
    SELECT route.enabled, next.nextOccurrenceAt AS nextAt
    FROM routes route LEFT JOIN route_schedules next ON next.id = route.id
    WHERE route.id = 'order-delivery-hourly'
  `.columns({ enabled: "boolean", nextAt: "time?" });

  // Consecutive checks with the same outcome, newest first: a run's position among all checks
  // minus its position among checks with its outcome is constant along a streak.
  const streaks = sql`
    WITH check_run AS (
      SELECT id, workflowName, instanceId, status, coalesce(errorMessage, '') AS error, createdAt,
        row_number() OVER (ORDER BY createdAt DESC, id DESC)
          - row_number() OVER (
            PARTITION BY status, coalesce(errorMessage, '') ORDER BY createdAt DESC, id DESC
          ) AS streak
      FROM runs WHERE remoteWorkflowName = 'order-delivery-monitor'
    )
    -- SQLite reads the bare columns from the row max() picks: the streak's latest run.
    SELECT max(createdAt) AS latestAt, workflowName, instanceId, status, count(*) AS checks,
      CASE WHEN count(*) = 1 THEN '1 check' ELSE count(*) || ' checks' END AS title,
      CASE status
        WHEN 'complete' THEN 'Saved the estimate'
        WHEN 'active' THEN 'Reading the order page'
        ELSE coalesce(nullif(error, ''), 'Stopped')
      END AS detail
    FROM check_run
    GROUP BY status, error, streak
    ORDER BY latestAt DESC LIMIT 6
  `.columns({
    latestAt: "time",
    workflowName: "string",
    instanceId: "string",
    status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
    title: "string",
    detail: "string",
  });

  const delivery = ui.stack({ gap: "xl" }, [
    ui.panel({ title: "Order 1048-2291" }, [
      ui.stack({ gap: "md" }, [
        ui.metric({
          label: "Expected delivery",
          value: current.value("estimate", "Not known yet"),
        }),
        ui.when(
          ui.is(current.value("estimate", "")),
          ui.stack({ gap: "sm", direction: "row" }, [
            ui.badge({
              label: current.value("freshness", ""),
              tone: current.value("tone", "waiting"),
            }),
            ui.text({ text: "Read from the shop", tone: "muted" }),
            ui.relativeTime({ time: current.value("checkedAt", null) }),
          ]),
        ),
        ui.when(
          ui.is(current.value("estimate", ""), { not: true }),
          ui.text({ text: "No check has read an estimate yet.", tone: "muted" }),
        ),
        ui.text({
          text: "The shop sends a text once the exact delivery date is known.",
          tone: "muted",
        }),
      ]),
    ]),
    ui.stack({ gap: "sm" }, [
      ui.panelTable(
        {
          title: "Estimate history",
          columns: [{ label: "Change" }, { label: "Seen", align: "end" }],
          empty: "The first estimate appears after a successful check.",
        },
        ui.each(history, (row) =>
          ui.panelTableRow({ title: row.estimate }, [
            ui.text({ text: row.change, tone: "muted" }),
            ui.relativeTime({ time: row.at }),
          ]),
        ),
      ),
      ui.text({ text: "Each change is sent to your Telegram chat.", tone: "muted" }),
    ]),
  ]);

  const monitoring = ui.stack({ gap: "xl" }, [
    ui.panel(
      {
        title: "Monitoring",
        link: {
          label: "View hourly automation",
          to: { kind: "route", id: "order-delivery-hourly" },
        },
      },
      [
        ui.when(
          ui.is(schedule.value("enabled", false), { eq: false }),
          ui.callout({
            title: "Monitoring paused",
            text: "The estimate stops updating until the hourly automation is enabled again.",
            tone: "waiting",
          }),
        ),
        ui.rowList(
          {},
          ui.each(schedule, (row) =>
            ui.when(
              ui.is(row.enabled),
              ui.listRow({ title: "Checks every hour", detail: "Next check", icon: "clock" }, [
                ui.relativeTime({ time: row.nextAt }),
              ]),
            ),
          ),
        ),
      ],
    ),
    ui.panel({ title: "Recent checks" }, [
      ui.rowList(
        { empty: "No checks yet." },
        ui.each(streaks, (streak) =>
          ui.listRow(
            {
              title: streak.title,
              detail: streak.detail,
              to: { kind: "run", workflowName: streak.workflowName, instanceId: streak.instanceId },
            },
            [ui.runStatus({ status: streak.status }), ui.relativeTime({ time: streak.latestAt })],
          ),
        ),
      ),
    ]),
  ]);

  return ui.grid({ columns: "main-side", gap: "xl" }, [delivery, monitoring]);
});
