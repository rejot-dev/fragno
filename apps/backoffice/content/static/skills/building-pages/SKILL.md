---
name: building-pages
description:
  "Pages: artifacts that show live automation data, written as /workspace/**/<name>.page.js with
  page.define and SQL. Use when the user asks for a dashboard or an always-current view of runs,
  events, routes, connections, agents, or stored values, or to change one."
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
   `/static/codemode/page-schema.d.ts` for the relations, their columns, the functions queries call,
   and the limits, and `/static/codemode/ui-catalog.d.ts` for the components. For a dashboard, read
   `/static/skills/building-pages/examples/home.page.js`, which rebuilds the scope's home page.
   Complete when every column you plan to read belongs to its relation in `PageRelations`.
2. **Write the source.** Save the module with `state.writeFile`, following the example below.
   Complete when it default-exports `page.define(...)` and is pure, as the Source section defines.
3. **Check.** Run `js.check({ path })` on the source. Complete when it reports no diagnostics. It
   checks how the interface reads each query's declared columns, not the SQL.
4. **Build.** Run `artifacts.buildPage({ path })`. It builds the page as Backoffice does when it
   opens, without providers, runs every query against the relations, and caches the build for
   viewers. Complete when it returns `{ status: "built" }`; a `failed` result's `message` is what
   the page would show, such as SQLite's error for a query, named by the query:
   `queries.q2: no such column: statsu`.
5. **Hand off.** Give the user the source path. Selecting it in Files links to the live page; the
   dashboard's "+" tab lists every page, and a page opens as a dashboard tab at
   `/backoffice/dashboard/<scope>/pages/<path>`, where `<scope>` is the scope segment of their Files
   URL and `<path>` is the source's path under `/workspace` without `.page.js`. Complete when the
   user has the path.

## Branches

- To change a page, edit its source, then check and build again. The `.build` file is the system's
  cache; leave it to the system.
- When the page or the Files preview shows "Invalid page", its message is the build's or the query's
  error. Fix the source and build again.
- A page written for the older page format, which queried with `from(...)` and `collections`, fails
  its build with a message saying so. Rewrite its queries in SQL as below, keeping its interface.

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
  are the only tables a query reads, and `page-schema.d.ts` lists the only functions it calls, such
  as `count`, `coalesce`, `row_number`, `json_group_array`, and `strftime`. Queries cannot write.
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
- A query shows at most `PageLimits["rowsPerQuery"]` rows and drops the rest, so order and `LIMIT`
  lists. Queries that take too long or return too much fail with a message saying so.
- Booleans are 0 or 1, so `WHERE route.enabled = 1`, and `sum(status = 'errored')` counts rows.

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

## Components for live data

- Lay a page out as panels, as the home page does: `ui.panel({ title, link })` titles a region and
  may close with a link, such as
  `{ label: "Show more on the Integrations page", to: { kind: "integrations" } }`. Space panels with
  `gap: "xl"`.
- `ui.rowList({ empty }, ui.each(query, (row) => ui.listRow(...)))` lists rows divided by rules and
  shows `empty` while the query has no rows. `ui.listRow({ title, to, detail, icon, tone }, [...])`
  shows a title and a muted detail line, ends with its children, such as a badge and a time, and
  links as a whole when `to` is set. A `tone` sets the icon on a tile, for rows that ask for
  something. Row lists in one panel read as one list, so a panel can list several queries.
- A row opens to show more when given `expanded: [elements]`; `expandLabel` names its toggle, such
  as "Respond". The home page's runs awaiting input open to `ui.workflowResponse(...)`.
- `ui.panelTable({ title, columns, empty }, ui.each(query, (row) => ui.panelTableRow(...)))` shows
  rows that share columns; `ui.panelTableRow({ title, to }, [...])` holds one child per column.
- Select labels people read beside the raw values queries compare, such as `erroredLabel` beside
  `errored`; some relations carry them, such as `displayName` and `activity`.
- `ui.link({ label, to })` opens a run (`{ kind: "run", workflowName, instanceId }`, where
  `workflowName` is the run's internal name), a route (`{ kind: "route", id }`), a connection
  (`{ kind: "connection", id }`), or the scope's integrations or agents (`{ kind: "integrations" }`,
  `{ kind: "agents" }`).
- `ui.relativeTime({ time })` shows "3m ago" or "in 2h" and moves with the page.
- `ui.number({ value, format })` rounds as it shows, so a query can return the exact value. A
  `percent` takes a ratio, such as `1.0 * completed / finished`, and null shows a dash.
- `ui.stack({ gap: "md", direction: "row" }, [...])` sets children side by side, such as a badge
  beside a time in a table cell.
- `ui.grid({ columns: "main-side", gap: "xl" }, [main, side])` sets panels beside a narrow column,
  as the home page does.
- `ui.sparkBars` and `ui.barChart` take `rows`, an `axis` naming the field along it, and the `value`
  field to size bars by; `ui.barChart` also stacks by a `series` field.
- `ui.runStatus({ status })` shows a run's status as the dashboard does, such as "Running" or
  "Errored"; pass the run's `status` as it is.
- `ui.badge({ label, tone })` shows any other status light.

## Backoffice widgets

Backoffice draws these parts from more than a page's queries, with the viewer's authority; pages
place them.

- `ui.orchestration({})` shows the scope's orchestration graph with the selected item's details, as
  the dashboard does. Put it in a `ui.panel`.
- `ui.workflowResponse({ workflowName, instanceId })` shows the form a waiting run asks a person to
  answer, and nothing while the run does not ask. Put it in a row's `expanded`.

## Supported today

Pages show the synchronized relations and what Backoffice derives from them: `connections` holds
each connection's current state, `agents` each agent's activity and queue, `agent_turns` the turns
agents ended, and `workflow_waits` what waiting runs wait for and whether they ask a person. The
home page example reads all four. When the user asks for forms, data the relations do not hold, or
the orchestration graph, build the closest page and tell them which part pages cannot express yet.
