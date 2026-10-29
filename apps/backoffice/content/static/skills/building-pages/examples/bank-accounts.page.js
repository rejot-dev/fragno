// Bank accounts kept current by a sync: an hourly workflow emits each record it reads from the
// bank as a versioned event, and the page shows the latest version of each. Totals lead, then
// accounts and transactions; the sync's health and activity sit in the side column. Copy it into
// /workspace as a <name>.page.js file to open it or start from it.
export default page.define({ title: "Bank accounts" }, ({ sql, now }) => {
  // The latest version of every transaction, account and card alike.
  const transactions = sql`
    WITH versioned AS (
      SELECT payload, occurredAt, id,
        row_number() OVER (
          PARTITION BY payload ->> '$.record.kind', payload ->> '$.entityId'
          ORDER BY CAST(payload ->> '$.version' AS INTEGER) DESC, occurredAt DESC, id DESC
        ) AS n
      FROM events
      WHERE source = 'bank' AND eventType IN ('transaction.created', 'transaction.updated')
    )
    SELECT payload ->> '$.entityId' AS entityId,
      payload ->> '$.record.kind' AS kind,
      payload ->> '$.record.accountId' AS accountId,
      payload ->> '$.record.date' AS date,
      -- The bank's dates are calendar days; as times, ui.relativeTime shows them.
      CAST(strftime('%s', payload ->> '$.record.date') AS INTEGER) * 1000 AS dateAt,
      payload ->> '$.record.description' AS description,
      CAST(payload ->> '$.record.amount' AS REAL) AS amount,
      payload ->> '$.record.currency' AS currency,
      payload ->> '$.record.status' AS status,
      payload ->> '$.record.statusLabel' AS label,
      payload ->> '$.record.tone' AS tone,
      -- Completed and posted transactions are the norm, so only other statuses show a badge.
      payload ->> '$.record.status' NOT IN ('PROCESSED', 'POSTED') AS unsettled,
      coalesce(payload ->> '$.record.card', '') AS card,
      coalesce(payload ->> '$.record.owner', '') AS owner,
      coalesce(payload ->> '$.record.source', '') AS fromName,
      coalesce(payload ->> '$.record.target', '') AS toName
    FROM versioned WHERE n = 1
  `;

  // Each account's latest balance and its completed movement this UTC month.
  const accounts = sql`
    WITH balance AS (
      SELECT payload,
        row_number() OVER (
          PARTITION BY payload ->> '$.entityId'
          ORDER BY CAST(payload ->> '$.version' AS INTEGER) DESC, occurredAt DESC, id DESC
        ) AS n
      FROM events WHERE source = 'bank' AND eventType = 'balance.updated'
    ),
    tx AS (${transactions}),
    movement AS (
      SELECT accountId, currency, sum(CAST(round(amount * 100) AS INTEGER)) AS cents FROM tx
      WHERE kind = 'account' AND status = 'PROCESSED'
        AND substr(date, 1, 7) = strftime('%Y-%m', ${now} / 1000, 'unixepoch')
        AND date <= strftime('%Y-%m-%dT%H:%M:%S', ${now} / 1000, 'unixepoch')
      GROUP BY accountId, currency
    )
    SELECT balance.payload ->> '$.entityId' AS accountId,
      balance.payload ->> '$.record.name' AS name,
      '••' || (balance.payload ->> '$.record.lastFour') AS lastFour,
      balance.payload ->> '$.record.currency' AS currency,
      CAST(balance.payload ->> '$.record.balanceCents' AS INTEGER) AS balanceCents,
      coalesce(movement.cents, 0) AS changeCents,
      (balance.payload ->> '$.record.balanceCents') / 100.0 AS balance,
      coalesce(movement.cents, 0) / 100.0 AS change,
      CASE WHEN movement.cents < 0 THEN 'failed' WHEN movement.cents > 0 THEN 'live' ELSE 'muted' END
        AS changeTone
    FROM balance
    LEFT JOIN movement ON movement.accountId = balance.payload ->> '$.entityId'
      AND movement.currency = balance.payload ->> '$.record.currency'
    WHERE balance.n = 1
    ORDER BY currency DESC, balanceCents DESC
  `.columns({
    name: "string",
    lastFour: "string",
    currency: "string",
    balance: "number",
    change: "number",
    changeTone: ["failed", "live", "muted"],
  });

  const totals = sql`
    SELECT currency,
      currency || ' available' AS availableLabel,
      currency || ' this month' AS changeLabel,
      sum(balanceCents) / 100.0 AS balance,
      sum(changeCents) / 100.0 AS change,
      CASE WHEN sum(changeCents) < 0 THEN 'failed' WHEN sum(changeCents) > 0 THEN 'live' ELSE 'muted' END
        AS changeTone
    FROM (${accounts})
    GROUP BY currency
    ORDER BY currency DESC
  `.columns({
    currency: "string",
    availableLabel: "string",
    changeLabel: "string",
    balance: "number",
    change: "number",
    changeTone: ["failed", "live", "muted"],
  });

  const accountTransactions = sql`
    SELECT * FROM (${transactions}) WHERE kind = 'account'
    ORDER BY date DESC, entityId DESC LIMIT 20
  `.columns({
    dateAt: "time",
    description: "string",
    amount: "number",
    currency: "string",
    unsettled: "boolean",
    label: "string",
    tone: ["live", "failed", "waiting"],
    fromName: "string",
    toName: "string",
  });
  const cardTransactions = sql`
    SELECT * FROM (${transactions}) WHERE kind = 'card'
    ORDER BY date DESC, entityId DESC LIMIT 20
  `.columns({
    dateAt: "time",
    description: "string",
    amount: "number",
    currency: "string",
    unsettled: "boolean",
    label: "string",
    tone: ["live", "failed", "waiting"],
    card: "string",
    owner: "string",
  });

  const health = sql`
    SELECT value ->> '$.at' AS at,
      CASE WHEN (value ->> '$.at') < ${now.minus("2 hours")} THEN 'Sync overdue' ELSE 'Syncing hourly' END
        AS label,
      CASE WHEN (value ->> '$.at') < ${now.minus("2 hours")} THEN 'waiting' ELSE 'live' END AS tone,
      CASE WHEN (value ->> '$.at') < ${now.minus("2 hours")} THEN 'alert-triangle' ELSE 'check' END
        AS icon
    FROM kv_store WHERE key = 'bank:sync-health'
  `.columns({
    at: "time?",
    label: "string",
    tone: ["waiting", "live"],
    // clock is the icon before the first sync records its health.
    icon: ["alert-triangle", "check", "clock"],
  });
  const schedule = sql`
    SELECT route.enabled, next.nextOccurrenceAt AS at
    FROM routes route LEFT JOIN route_schedules next ON next.id = route.id
    WHERE route.id = 'bank-sync-hourly'
  `.columns({ enabled: "boolean", at: "time?" });
  const worker = sql`
    SELECT workflowName, instanceId, status,
      CASE status
        WHEN 'waiting' THEN 'Waiting for the next hourly poll'
        WHEN 'active' THEN 'Polling the bank now'
        ELSE coalesce(errorMessage, 'Stopped')
      END AS detail
    FROM runs WHERE instanceId = 'bank-sync-worker'
    ORDER BY updatedAt DESC LIMIT 1
  `.columns({
    workflowName: "string",
    instanceId: "string",
    status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
    detail: "string",
  });
  const activity = sql`
    WITH e AS (
      SELECT *, row_number() OVER (PARTITION BY payload ->> '$.eventKey' ORDER BY occurredAt DESC, id DESC) AS n
      FROM events WHERE source = 'bank'
    )
    SELECT id,
      coalesce(payload ->> '$.record.description', payload ->> '$.record.name') AS title,
      CASE eventType
        WHEN 'transaction.created' THEN 'New transaction'
        WHEN 'transaction.updated' THEN 'Transaction updated'
        WHEN 'balance.updated' THEN 'Balance updated'
        ELSE eventType
      END || CASE WHEN payload ->> '$.backfill' = 1 THEN ' · initial import' ELSE '' END AS detail,
      occurredAt AS at
    FROM e WHERE n = 1
    ORDER BY occurredAt DESC, id DESC LIMIT 8
  `.columns({ title: "string", detail: "string", at: "time" });

  const finances = ui.stack({ gap: "xl" }, [
    // One row per currency, so a row holds at most two figures.
    ui.stack(
      { gap: "lg" },
      ui.each(totals, (total) =>
        ui.grid({ columns: 2, gap: "lg" }, [
          ui.metric({
            label: total.availableLabel,
            value: total.balance,
            format: { currency: total.currency },
          }),
          ui.metric({
            label: total.changeLabel,
            value: total.change,
            format: { currency: total.currency },
            signed: true,
            tone: total.changeTone,
          }),
        ]),
      ),
    ),
    ui.stack({ gap: "sm" }, [
      ui.panelTable(
        {
          title: "Accounts",
          columns: [
            { label: "Account" },
            { label: "Balance", align: "end" },
            { label: "This month", align: "end" },
          ],
          empty: "Balances appear after the first sync.",
        },
        ui.each(accounts, (account) =>
          ui.panelTableRow({ title: account.name }, [
            ui.text({ text: account.lastFour, tone: "muted" }),
            ui.number({ value: account.balance, format: { currency: account.currency } }),
            ui.number({
              value: account.change,
              format: { currency: account.currency },
              signed: true,
              tone: account.changeTone,
            }),
          ]),
        ),
      ),
      ui.text({
        text: "This month counts completed account transactions in the current UTC month. Transfers between accounts cancel out in the totals; pending, scheduled, and failed payments are not counted.",
        tone: "muted",
      }),
    ]),
    ui.panelTable(
      {
        title: "Account transactions",
        columns: [
          { label: "Date" },
          { label: "From → To" },
          { label: "Amount", align: "end" },
          { label: "Status" },
        ],
        empty: "Transactions appear after the first sync.",
      },
      ui.each(accountTransactions, (row) =>
        ui.panelTableRow({ title: row.description }, [
          ui.relativeTime({ time: row.dateAt }),
          ui.stack({ gap: "sm", direction: "row" }, [
            ui.text({ text: row.fromName }),
            ui.text({ text: "→", tone: "muted" }),
            ui.text({ text: row.toName }),
          ]),
          ui.number({ value: row.amount, format: { currency: row.currency }, signed: true }),
          ui.when(ui.is(row.unsettled), ui.badge({ label: row.label, tone: row.tone })),
        ]),
      ),
    ),
    ui.panelTable(
      {
        title: "Card transactions",
        columns: [
          { label: "Date" },
          { label: "Card" },
          { label: "Holder" },
          { label: "Amount", align: "end" },
          { label: "Status" },
        ],
        empty: "Card transactions appear after the first sync.",
      },
      ui.each(cardTransactions, (row) =>
        ui.panelTableRow({ title: row.description }, [
          ui.relativeTime({ time: row.dateAt }),
          ui.text({ text: row.card }),
          ui.text({ text: row.owner, tone: "muted" }),
          ui.number({ value: row.amount, format: { currency: row.currency }, signed: true }),
          ui.when(ui.is(row.unsettled), ui.badge({ label: row.label, tone: row.tone })),
        ]),
      ),
    ),
  ]);

  const sync = ui.stack({ gap: "xl" }, [
    ui.panel(
      {
        title: "Sync",
        link: { label: "View hourly schedule", to: { kind: "route", id: "bank-sync-hourly" } },
      },
      [
        ui.when(
          ui.is(schedule.value("enabled", true), { eq: false }),
          ui.callout({
            title: "Schedule paused",
            text: "Balances stop updating until the hourly schedule is enabled again.",
            tone: "waiting",
          }),
        ),
        ui.rowList({}, [
          ui.listRow(
            {
              title: health.value("label", "First sync running"),
              detail: "Last completed sync",
              icon: health.value("icon", "clock"),
              tone: health.value("tone", "waiting"),
            },
            [ui.relativeTime({ time: health.value("at", null) })],
          ),
          ui.listRow({ title: "Next sync", icon: "clock" }, [
            ui.relativeTime({ time: schedule.value("at", null) }),
          ]),
        ]),
        ui.rowList(
          {},
          ui.each(worker, (run) =>
            ui.listRow(
              {
                title: "Sync worker",
                detail: run.detail,
                icon: "zap",
                to: { kind: "run", workflowName: run.workflowName, instanceId: run.instanceId },
              },
              [ui.runStatus({ status: run.status })],
            ),
          ),
        ),
      ],
    ),
    ui.panel({ title: "Recent sync activity" }, [
      ui.rowList(
        { empty: "Nothing synced yet." },
        ui.each(activity, (event) =>
          ui.listRow({ title: event.title, detail: event.detail }, [
            ui.relativeTime({ time: event.at }),
          ]),
        ),
      ),
      ui.text({
        text: "Card transactions are spending, not the card balance owed.",
        tone: "muted",
      }),
    ]),
  ]);

  return ui.grid({ columns: "main-side", gap: "xl" }, [finances, sync]);
});
