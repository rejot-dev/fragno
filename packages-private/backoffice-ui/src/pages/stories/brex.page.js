// Generated in production for ReJot, Inc.: Brex balances and transactions as projections of the
// events an hourly sync emits. The Brex production stories build it, so edits to it show up
// there.
export default page.define({ title: "Brex · Live finance" }, ({ sql, now }) => {
  const transactions = sql`
 WITH versioned AS (
 SELECT payload,occurredAt,id,row_number() OVER(PARTITION BY payload ->> '$.record.kind',payload ->> '$.entityId' ORDER BY CAST(payload ->> '$.version' AS INTEGER) DESC,occurredAt DESC,id DESC) AS n
 FROM events WHERE source='brex' AND eventType IN ('transaction.created','transaction.updated')
 ) SELECT payload ->> '$.entityId' AS entityId,payload ->> '$.record.kind' AS kind,payload ->> '$.record.accountId' AS accountId,
 payload ->> '$.record.date' AS date,payload ->> '$.record.description' AS description,payload ->> '$.record.amount' AS amount,
 payload ->> '$.record.currency' AS currency,payload ->> '$.record.displayAmount' AS displayAmount,payload ->> '$.record.status' AS status,
 payload ->> '$.record.statusLabel' AS label,payload ->> '$.record.tone' AS tone,
 coalesce(payload ->> '$.record.card','') AS card,coalesce(payload ->> '$.record.owner','') AS owner,
 coalesce(payload ->> '$.record.source','') AS fromName,coalesce(payload ->> '$.record.target','') AS toName
 FROM versioned WHERE n=1
 `;
  const balances = sql`
 WITH b AS (
 SELECT payload,occurredAt,id,row_number() OVER(PARTITION BY payload ->> '$.entityId' ORDER BY CAST(payload ->> '$.version' AS INTEGER) DESC,occurredAt DESC,id DESC) AS n
 FROM events WHERE source='brex' AND eventType='balance.updated'
 ), tx AS (${transactions}), changes AS (
 SELECT accountId,currency,sum(CAST(round(CAST(amount AS REAL)*100) AS INTEGER)) AS changeCents FROM tx
 WHERE kind='account' AND status='PROCESSED' AND substr(date,1,7)=strftime('%Y-%m',${now}/1000,'unixepoch') AND date <= strftime('%Y-%m-%dT%H:%M:%S',${now}/1000,'unixepoch')
 GROUP BY accountId,currency
 )
 SELECT b.payload ->> '$.entityId' AS accountId,b.payload ->> '$.record.name' AS name,
 b.payload ->> '$.record.balance' AS balance,b.payload ->> '$.record.balanceCents' AS balanceCents,
 b.payload ->> '$.record.currency' AS currency,b.payload ->> '$.record.lastFour' AS lastFour,
 coalesce(c.changeCents,0) AS changeCents,
 printf('%+.2f %s',coalesce(c.changeCents,0)/100.0,b.payload ->> '$.record.currency') AS changeLabel,
 CASE WHEN coalesce(c.changeCents,0)<0 THEN 'failed' WHEN coalesce(c.changeCents,0)>0 THEN 'live' ELSE 'muted' END AS tone
 FROM b LEFT JOIN changes c ON c.accountId=b.payload ->> '$.entityId' AND c.currency=b.payload ->> '$.record.currency' WHERE b.n=1
 `.columns({
    accountId: "string",
    name: "string",
    balance: "string",
    balanceCents: "number",
    currency: "string",
    lastFour: "string",
    changeCents: "number",
    changeLabel: "string",
    tone: ["failed", "live", "muted"],
  });
  const totals =
    sql`SELECT currency,printf('%.2f %s',sum(balanceCents)/100.0,currency) AS balance,printf('%+.2f %s',sum(changeCents)/100.0,currency) AS changeLabel FROM (${balances}) GROUP BY currency`.columns(
      { currency: "string", balance: "string", changeLabel: "string" },
    );
  const bank =
    sql`SELECT * FROM (${transactions}) WHERE kind='account' ORDER BY date DESC,entityId DESC LIMIT 20`.columns(
      {
        date: "string",
        description: "string",
        displayAmount: "string",
        label: "string",
        tone: ["live", "failed", "waiting"],
        fromName: "string",
        toName: "string",
      },
    );
  const cards =
    sql`SELECT * FROM (${transactions}) WHERE kind='card' ORDER BY date DESC,entityId DESC LIMIT 20`.columns(
      {
        date: "string",
        description: "string",
        displayAmount: "string",
        label: "string",
        tone: ["live", "failed", "waiting"],
        card: "string",
        owner: "string",
      },
    );
  const health =
    sql`SELECT value ->> '$.at' AS at,value ->> '$.records' AS records,value ->> '$.emitted' AS emitted,CASE WHEN (value ->> '$.at') < ${now.minus("2 hours")} THEN 'Sync overdue' ELSE 'Hourly sync healthy' END AS label,CASE WHEN (value ->> '$.at') < ${now.minus("2 hours")} THEN 'waiting' ELSE 'live' END AS tone FROM kv_store WHERE key='brex:sync-health'`.columns(
      {
        at: "time?",
        records: "number",
        emitted: "number",
        label: "string",
        tone: ["waiting", "live"],
      },
    );
  const schedule =
    sql`SELECT r.enabled,s.nextOccurrenceAt AS at FROM routes r LEFT JOIN route_schedules s ON s.id=r.id WHERE r.id='brex-sync-hourly'`.columns(
      { enabled: "boolean", at: "time?" },
    );
  const worker =
    sql`SELECT workflowName,instanceId,status,coalesce(errorMessage,'') AS error FROM runs WHERE instanceId='brex-sync-worker-v1' ORDER BY updatedAt DESC LIMIT 1`.columns(
      {
        workflowName: "string",
        instanceId: "string",
        status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
        error: "string",
      },
    );
  const activity =
    sql`WITH e AS (SELECT *,row_number() OVER(PARTITION BY payload ->> '$.eventKey' ORDER BY occurredAt DESC,id DESC) AS n FROM events WHERE source='brex') SELECT eventType,payload ->> '$.record.name' AS account,payload ->> '$.record.description' AS description,occurredAt AS at,CASE WHEN payload ->> '$.backfill'=1 THEN 'Initial import' ELSE 'Update' END AS label FROM e WHERE n=1 ORDER BY occurredAt DESC,id DESC LIMIT 12`.columns(
      {
        eventType: "string",
        account: "string?",
        description: "string?",
        at: "time",
        label: "string",
      },
    );
  return ui.stack({ gap: "xl" }, [
    ui.panel(
      {
        title: "ReJot, Inc. · Automated Brex sync",
        link: { label: "View hourly schedule", to: { kind: "route", id: "brex-sync-hourly" } },
      },
      [
        ui.stack({ gap: "md", direction: "row" }, [
          ui.badge({
            label: health.value("label", "Initial sync running"),
            tone: health.value("tone", "waiting"),
          }),
          ui.text({ text: "Last completed sync", tone: "muted" }),
          ui.relativeTime({ time: health.value("at", null) }),
          ui.text({ text: "Next sync", tone: "muted" }),
          ui.relativeTime({ time: schedule.value("at", null) }),
        ]),
        ui.when(
          ui.is(schedule.value("enabled", false), { eq: false }),
          ui.callout({
            title: "Schedule disabled",
            text: "Automatic refresh is paused.",
            tone: "waiting",
          }),
        ),
        ui.rowList(
          {},
          ui.each(worker, (w) =>
            ui.listRow(
              {
                title: "Sync worker",
                to: { kind: "run", workflowName: w.workflowName, instanceId: w.instanceId },
                detail: "Waiting between hourly polls is normal.",
              },
              [
                ui.runStatus({ status: w.status }),
                ui.when(ui.is(w.error), ui.text({ text: w.error })),
              ],
            ),
          ),
        ),
        ui.text({
          text: "Balances and transactions below are projections of deduplicated Brex events. Initial history is imported once; unchanged polls emit no financial events.",
          tone: "muted",
        }),
      ],
    ),
    ui.grid(
      { columns: 2, gap: "lg" },
      ui.each(totals, (t) =>
        ui.panel({ title: t.currency }, [
          ui.metric({ label: "Total available", value: t.balance, tone: "info" }),
          ui.metric({ label: "Net account movement this month", value: t.changeLabel }),
        ]),
      ),
    ),
    ui.grid(
      { columns: 3, gap: "lg" },
      ui.each(balances, (a) =>
        ui.panel({ title: a.name }, [
          ui.metric({ label: "Available balance", value: a.balance, tone: "info" }),
          ui.metric({ label: "Change this month", value: a.changeLabel, tone: a.tone }),
          ui.text({ text: a.lastFour, tone: "muted" }),
        ]),
      ),
    ),
    ui.callout({
      title: "Monthly change",
      text: "Calculated from the latest version of every completed account transaction in the current UTC month. Internal transfers affect each account but cancel in the total. Pending, scheduled and failed payments are excluded. Card purchases are not counted again alongside card repayments.",
      tone: "info",
    }),
    ui.panelTable(
      {
        title: "Recent account transactions",
        columns: [
          { label: "Date" },
          { label: "From → To" },
          { label: "Amount", align: "end" },
          { label: "Status" },
        ],
        empty: "Initial import in progress.",
      },
      ui.each(bank, (t) =>
        ui.panelTableRow({ title: t.description }, [
          ui.text({ text: t.date }),
          ui.stack({ gap: "sm" }, [
            ui.text({ text: t.fromName }),
            ui.text({ text: "→", tone: "muted" }),
            ui.text({ text: t.toName }),
          ]),
          ui.text({ text: t.displayAmount }),
          ui.badge({ label: t.label, tone: t.tone }),
        ]),
      ),
    ),
    ui.text({
      text: "Internal transfers appear as separate debit and credit entries, one per account. Account timestamps are supplied by Brex.",
      tone: "muted",
    }),
    ui.panelTable(
      {
        title: "Recent company card transactions",
        columns: [
          { label: "Date" },
          { label: "Card / holder" },
          { label: "Amount", align: "end" },
          { label: "Status" },
        ],
        empty: "Initial import in progress.",
      },
      ui.each(cards, (t) =>
        ui.panelTableRow({ title: t.description }, [
          ui.text({ text: t.date }),
          ui.stack({ gap: "sm" }, [
            ui.text({ text: t.card }),
            ui.text({ text: t.owner, tone: "muted" }),
          ]),
          ui.text({ text: t.displayAmount }),
          ui.badge({ label: t.label, tone: t.tone }),
        ]),
      ),
    ),
    ui.table({
      caption: "Recent emitted events",
      rows: activity,
      columns: [
        { key: "eventType", label: "Event" },
        { key: "account", label: "Account" },
        { key: "description", label: "Transaction" },
        { key: "label", label: "Origin" },
        { key: "at", label: "Observed" },
      ],
    }),
    ui.text({
      text: "Card transaction status is not an outstanding card balance. This page does not show amounts owed to Brex.",
      tone: "muted",
    }),
  ]);
});
