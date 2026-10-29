// Generated in production, with a made-up order number: an hourly workflow reads a Vodafone
// order's expected delivery and records when it changes. The Vodafone production stories build
// it, so edits to it show up there.
export default page.define({ title: "Vodafone delivery" }, ({ sql, now }) => {
  const current = sql`
 SELECT s.result ->> '$.expectedDelivery' AS estimate, s.updatedAt AS checkedAt,
 CASE WHEN s.updatedAt < ${now.minus("2 hours")} THEN 'Check overdue' ELSE 'Up to date' END AS freshness,
 CASE WHEN s.updatedAt < ${now.minus("2 hours")} THEN 'waiting' ELSE 'live' END AS tone
 FROM steps s JOIN runs r ON r.id=s.runId
 WHERE r.remoteWorkflowName='vodafone-delivery-monitor' AND s.name='compare-and-save-json'
 AND s.status='completed' AND s.result ->> '$.expectedDelivery' IS NOT NULL
 ORDER BY s.updatedAt DESC, s.id DESC LIMIT 1
 `.columns({
    estimate: "string",
    checkedAt: "time",
    freshness: "string",
    tone: ["waiting", "live"],
  });
  const schedule = sql`
 SELECT r.id, CASE WHEN r.enabled=1 THEN 'Hourly monitoring enabled' ELSE 'Monitoring paused' END AS label,
 CASE WHEN r.enabled=1 THEN 'live' ELSE 'waiting' END AS tone, s.nextOccurrenceAt AS nextAt
 FROM routes r LEFT JOIN route_schedules s ON s.id=r.id WHERE r.id='vodafone-delivery-hourly'
 `.columns({ id: "string", label: "string", tone: ["live", "waiting"], nextAt: "time?" });
  const recent = sql`
 SELECT workflowName,instanceId,status,updatedAt,coalesce(errorMessage,'') AS error
 FROM runs WHERE remoteWorkflowName='vodafone-delivery-monitor'
 ORDER BY createdAt DESC,id DESC LIMIT 8
 `.columns({
    workflowName: "string",
    instanceId: "string",
    status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
    updatedAt: "time",
    error: "string",
  });
  const changes = sql`
 SELECT s.result ->> '$.pending.from' AS previous, s.result ->> '$.pending.to' AS estimate, s.updatedAt AS at
 FROM steps s JOIN runs r ON r.id=s.runId
 WHERE r.remoteWorkflowName='vodafone-delivery-monitor' AND s.name='compare-and-save-json'
 AND s.status='completed' AND s.result ->> '$.changed'=1
 ORDER BY s.updatedAt DESC,s.id DESC LIMIT 20
 `.columns({ previous: "string", estimate: "string", at: "time" });
  return ui.stack({ gap: "xl" }, [
    ui.grid({ columns: "main-side", gap: "xl" }, [
      ui.panel({ title: "Expected delivery · Order 1048-2291" }, [
        ui.metric({
          label: "Delivery estimate",
          value: current.value("estimate", "Awaiting a successful check"),
          detail: "Latest estimate saved by the hourly Vodafone workflow.",
          tone: "info",
        }),
        ui.rowList(
          {},
          ui.each(current, (row) =>
            ui.listRow({ title: "Last successful check", icon: "clock" }, [
              ui.badge({ label: row.freshness, tone: row.tone }),
              ui.relativeTime({ time: row.checkedAt }),
            ]),
          ),
        ),
        ui.text({
          text: "Vodafone will send an SMS once the exact delivery date is known.",
          tone: "muted",
        }),
      ]),
      ui.panel(
        {
          title: "Monitoring",
          link: {
            label: "View hourly automation",
            to: { kind: "route", id: "vodafone-delivery-hourly" },
          },
        },
        [
          ui.rowList(
            { empty: "No monitoring schedule found." },
            ui.each(schedule, (row) =>
              ui.listRow({ title: row.label, detail: "Next scheduled check", icon: "clock" }, [
                ui.badge({ label: row.label, tone: row.tone }),
                ui.relativeTime({ time: row.nextAt }),
              ]),
            ),
          ),
          ui.text({
            text: "Delivery changes are sent to your linked Telegram chat via ReJot’s bot. Failed extractions retain the last known estimate.",
            tone: "muted",
          }),
          ui.text({
            text: "Saved data: /workspace/vodafone-expected-delivery.json",
            tone: "muted",
          }),
        ],
      ),
    ]),
    ui.panelTable(
      {
        title: "Delivery changes",
        columns: [{ label: "Previous estimate" }, { label: "Detected", align: "end" }],
        empty: "No delivery changes detected.",
      },
      ui.each(changes, (row) =>
        ui.panelTableRow({ title: row.estimate }, [
          ui.text({ text: row.previous }),
          ui.relativeTime({ time: row.at }),
        ]),
      ),
    ),
    ui.panelTable(
      {
        title: "Recent checks",
        columns: [{ label: "Status" }, { label: "Last activity", align: "end" }],
        empty: "No checks yet.",
      },
      ui.each(recent, (row) =>
        ui.panelTableRow(
          {
            title: row.instanceId,
            to: { kind: "run", workflowName: row.workflowName, instanceId: row.instanceId },
          },
          [
            ui.stack({ gap: "sm" }, [
              ui.runStatus({ status: row.status }),
              ui.when(ui.is(row.error), ui.text({ text: row.error, tone: "muted" })),
            ]),
            ui.relativeTime({ time: row.updatedAt }),
          ],
        ),
      ),
    ),
  ]);
});
