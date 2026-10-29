---
name: building-pages
description:
  "Pages: artifacts that show live automation data, written as /workspace/**/<name>.page.js with
  page.define and SQL. Use when the user asks for a dashboard or an always-current view of runs,
  events, routes, connections, agents, stored values, or data a workflow syncs from another system,
  or to change one."
---

# Building pages

A page is an artifact: one source module, `<name>.page.js` anywhere under `/workspace`, that
default-exports `page.define(...)`: live SQL queries over the scope's relations, placed in a `ui`
interface. When the page is opened, the system builds the source into the mirrored path under
`/workspace/.build`, such as `/workspace/.build/reports/operations.page.json`, and rebuilds it
whenever the source changes; the page runs its queries in the browser, over the scope's data as the
browser keeps it, and re-renders as the data changes.

## Steps

1. **Ground.** Read `/static/codemode/page.d.ts` for the builder,
   `/static/codemode/page-schema.d.ts` for the relations, their columns, and the limits, and
   `/static/codemode/ui-catalog.d.ts` for the components. Read the example in
   `/static/skills/building-pages/examples/` closest to the page:
   - `home.page.js`, the scope's home page: an overview of its automations;
   - `bank-accounts.page.js`: figures projected from a synced system's versioned events;
   - `delivery-tracker.page.js`: one value a workflow keeps checking, with its history.

   Complete when every value the page shows has a column in `PageRelations` to come from. A
   connected service's data, such as bank balances or an order's status, comes from the events its
   feed fires: build the feed first with
   `/static/skills/building-automations/references/syncing-external-data.md`.

2. **Design.** Name the question the user opens the page to answer, such as "how much money do we
   have?" or "when does my order arrive?", and the states its data can be in, such as empty,
   healthy, failing, or paused. Then list the page's elements top to bottom. Complete when every
   Design rule below holds for every element in every state.
3. **Write the source.** Save the module with `state.writeFile`, following the example below.
   Complete when it default-exports `page.define(...)` and is pure, as the Source section defines.
4. **Check.** Run `js.check({ path })` on the source. Complete when it reports no diagnostics and
   the source still meets every Design rule. It checks how the interface reads each query's declared
   columns, not the SQL.
5. **Build.** Run `artifacts.buildPage({ path })`. It builds the page as Backoffice does when it
   opens, without providers, runs every query against the relations, and caches the build for
   viewers. Complete when it returns `{ status: "built" }`; a `failed` result's `message` is what
   the page would show, such as SQLite's error for a query, named by the query:
   `queries.q2: no such column: statsu`.
6. **Hand off.** Link the source path, such as `[Finance](/workspace/pages/finance.page.js)`, or,
   for a page in another scope, the path after that scope, such as
   `[Finance](/org:<orgId>/workspace/pages/finance.page.js)`. The link opens the file in Files,
   which links to the live page, and the dashboard's "+" tab lists every page. Complete when the
   user has the link.

## Branches

- To change a page, edit its source, then check and build again. The `.build` file is the system's
  cache; leave it to the system.
- When the page or the Files preview shows "Invalid page", its message is the build's or the query's
  error. Fix the source and build again.
- A page written for the older page format, which queried with `from(...)` and `collections`, fails
  its build with a message saying so. Rewrite its queries in SQL as below, keeping its interface.

## Design

People open a page with one question. A page that answers it at a glance follows these rules:

- **Answer first.** The first element answers the page's question, such as a metric of the balance.
  The domain data behind the answer, such as accounts, transactions, or estimates, fills the main
  column of `ui.grid({ columns: "main-side" })`; the machinery that produces it, such as syncs,
  schedules, and runs, goes in the side column.
- **Values, not text.** Select numbers and times as values, and let components format them:
  `ui.number` and `ui.metric` with a `format`, such as `{ currency: row.currency }`, and
  `ui.relativeTime`. Text built in SQL, such as `printf('%.2f', amount)` or a time as a string,
  shows without grouping, currency, or "3h ago".
- **People's words.** Titles and labels name what people recognize: an account, a description, an
  order, a count. Select a label beside each raw value a query compares, such as `'Balance updated'`
  for `balance.updated` or `erroredLabel` beside `errored`; some relations carry them, such as
  `displayName` and `activity`. Ids belong in a link's `to`.
- **Once.** Each fact appears in one place: a badge adds what its row's title does not say, and a
  panel leaves out what another already shows.
- **True in every state.** Every text reads true in each state the data can be in. Copy that depends
  on the state comes from the query, such as `CASE status WHEN 'waiting' THEN ... END`, or shows
  with `ui.when`.
- **Grouped.** Rows that repeat collapse into one with a count, such as consecutive runs with the
  same outcome.
- **Brief.** Text tells people what they need to act. How the page computes its data, which files a
  workflow writes, and caveats about the implementation stay in the source as comments. A panel
  holds at most one short muted note.
- **Tones are statuses.** `live` marks good, `waiting` something that needs time or attention, and
  `failed` bad, such as a loss. A figure that is merely important takes no tone.

## Source

The module is pure: data comes from queries, time from `now`, and code from `page`, `ui`, and the
saved modules it imports. The system builds it without providers such as `state`, and caches the
result until the source changes; `artifacts.buildPage` builds it the same way, so it reports a
module that reads them.

```js
export default page.define({ title: "Automations" }, ({ sql, now, intervals, bucket }) => {
  const day = now.minus("24 hours");
  const hours = intervals({ every: "1 hour", since: day });

  // Each workflow's starts today, its errored runs, its latest run, and its starts per hour.
  const health = sql`
    WITH run AS (SELECT *, coalesce(remoteWorkflowName, workflowName) AS workflow FROM runs),
    latest AS (
      SELECT workflow, workflowName, instanceId, status, updatedAt,
        row_number() OVER (PARTITION BY workflow ORDER BY updatedAt DESC, id DESC) AS recency
      FROM run
    ),
    hourly AS (
      SELECT workflow, json_group_array(json_object('hour', hour, 'runs', runs)) AS hourly
      FROM (
        SELECT workflow, ${bucket("createdAt", hours)} AS hour, count(*) AS runs
        FROM run WHERE createdAt >= ${day} GROUP BY workflow, hour
      )
      GROUP BY workflow
    )
    SELECT latest.workflow, latest.workflowName, latest.instanceId, latest.status,
      latest.updatedAt,
      (SELECT count(*) FROM run WHERE run.workflow = latest.workflow AND status = 'errored')
        AS errored,
      coalesce(hourly.hourly, '[]') AS hourly
    FROM latest LEFT JOIN hourly ON hourly.workflow = latest.workflow
    WHERE latest.recency = 1
    ORDER BY latest.updatedAt DESC
  `.columns({
    workflow: "string",
    workflowName: "string",
    instanceId: "string",
    status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
    updatedAt: "time",
    errored: "number",
    hourly: { rows: { hour: "time", runs: "number" } },
  });

  const started = sql`SELECT count(*) AS total FROM runs WHERE createdAt >= ${day}`.columns({
    total: "number",
  });

  return ui.stack({ gap: "xl" }, [
    ui.metric({ label: "Runs today", value: started.value("total", 0) }),
    ui.panelTable(
      {
        title: "Automations",
        columns: [{ label: "Runs · 24 hours" }, { label: "Last run", align: "end" }],
        empty: "No workflow has run yet.",
      },
      ui.each(health, (row) =>
        ui.panelTableRow(
          {
            title: row.workflow,
            to: { kind: "run", workflowName: row.workflowName, instanceId: row.instanceId },
          },
          [
            ui.sparkBars({
              label: "Starts per hour",
              rows: row.hourly,
              axis: { field: "hour", intervals: hours },
              value: "runs",
            }),
            ui.stack({ gap: "md", direction: "row" }, [
              ui.when(
                ui.is(row.errored, { gt: 0 }),
                ui.badge({ label: "Errored runs", tone: "failed" }),
              ),
              ui.runStatus({ status: row.status }),
              ui.relativeTime({ time: row.updatedAt }),
            ]),
          ],
        ),
      ),
    ),
  ]);
});
```

The title heads the page. Return the root element from the callback; `page.define` renders it.

## Queries

- `` sql`...` `` holds one SQLite `SELECT`, which may start with `WITH`, over the relations in
  `PageRelations`: `runs`, `steps`, `events`, `routes`, `connections`, `agents`, and the rest. They
  are the only tables a query reads.
- `${...}` binds a value as a parameter, never writing it into the SQL: a string, number, boolean,
  or null; a list for `IN (${["errored", "terminated"]})`; or a time such as
  `${now.minus("7 days")}`. It includes SQL: another query or `` sql`...` ``, such as a shared CTE
  `WITH run AS (${runs})`, and `bucket(...)`.
- `.columns({ ... })` names every column the rows show and how each reads, which makes the SQL a
  live query. Name each in the `SELECT`, such as `count(*) AS total`. Declare:
  - `"string"`, `"number"`, `"boolean"` (0 or 1 in SQL), `"time"` (milliseconds since the epoch in
    SQL, an ISO time on the page), or `"json"` (JSON text, parsed), with `?` when it may be null,
    such as `"time?"`;
  - the strings it holds, such as `["live", "failed"]`, so components that take one of them, such as
    a badge's `tone` or `ui.runStatus`, accept it; list `null` too when it may be null;
  - `{ rows: { ...columns } }` for nested rows built as
    `json_group_array(json_object('hour', hour, 'runs', runs))`, whose fields read like columns.
- Times are milliseconds since the epoch: compare them with `now`, such as
  `createdAt >= ${now.minus("24 hours")}`. The page moves `now` every minute.
- `intervals({ every, since })` names consecutive intervals; `${bucket("run.createdAt", hours)}` is
  the start of the interval a time falls in. Group by it, declare it `"time?"` (or `"time"` when the
  query keeps only times since the window's start), and pass the same intervals to a chart's `axis`
  so intervals without rows show.
- JSON columns read with `->>`, such as `route.trigger ->> '$.kind'` or
  `event.payload ->> '$.action'`; nest a JSON column in other JSON with `json(...)`.
- Components show a bounded number of rows, such as a table's 64, so order and `LIMIT` lists.
- Keep each query under about a second over the scope's data. The build runs queries on an empty
  database, so a slow query builds and then fails on the page.
- Booleans are 0 or 1, so `WHERE route.enabled = 1`, and `sum(status = 'errored')` counts rows.
- Start from the examples' queries: the latest version of each entity among versioned events in
  `bank-accounts.page.js`; consecutive runs with the same outcome as one streak, and a value's first
  reading with each change after it, in `delivery-tracker.page.js`; counts per interval in
  `home.page.js`.

## Binding results

- Values keep their declared types; times arrive as ISO 8601 strings. Each component checks its
  props as it renders and, when a value does not fit, shows what is wrong in its place. A value that
  does not fit its declared column fails the page, naming the column and row.
- A query goes in a prop that shows rows, such as `ui.table` `rows` or a chart's `rows`. A table's
  columns choose which of its declared columns to show.
- `ui.each(query, (row) => element)` is the children of `ui.rowList`, `ui.panelTable`, `ui.stack`,
  or `ui.grid`: one element per row. `row.field` reads a column, and `row.hourly` nested rows, which
  a nested `ui.each` or a chart's `rows` takes.
- `ui.when(ui.is(row.errored, { gt: 0 }), element)` shows an element while a live value matches.
- `query.value(column, whenEmpty)` goes in a single-value prop, such as `ui.metric` `value`. It
  holds the column of the first row, or `whenEmpty` while the query has no rows.

## Supported today

Pages show the synchronized relations and what Backoffice derives from them: `connections` holds
each connection's current state, `agents` each agent's activity and queue, `agent_turns` the turns
agents ended, and `workflow_waits` what waiting runs wait for and whether they ask a person. The
home page example reads all four. Data from outside Backoffice arrives through a feed, as step 1
describes. When the user asks for forms, build the closest page and tell them which part pages
cannot express yet.
