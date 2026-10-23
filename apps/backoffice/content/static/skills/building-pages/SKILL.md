---
name: building-pages
description:
  "Pages: artifacts that show live automation data, written as /workspace/**/<name>.page.js with
  page.define. Use when the user asks for a dashboard or an always-current view of runs, events,
  routes, or stored values, or to change one."
---

# Building pages

A page is an artifact: one source module, `<name>.page.js` anywhere under `/workspace`, that
default-exports `page.define(...)`: live queries over the scope's collections, written in TanStack
DB's query style and placed in a `ui` interface. When the page is opened, the system builds the
source into the mirrored path under `/workspace/.build`, such as
`/workspace/.build/reports/operations.page.json`, and rebuilds it whenever the source changes; the
page runs the queries in the browser and re-renders as the data changes.

## Steps

1. **Ground.** Read `/static/codemode/page.d.ts` for the query functions,
   `/static/codemode/page-schema.d.ts` for the collections, their fields, and the limits, and
   `/static/codemode/ui-catalog.d.ts` for the components. For a dashboard, read
   `/static/skills/building-pages/examples/home.page.js`, which rebuilds the scope's home page.
   Complete when every field you plan to show belongs to its collection in `PageCollections`.
2. **Write the source.** Save the module with `state.writeFile`, following the example below.
   Complete when it default-exports `page.define(...)` and is pure, as the Source section defines.
3. **Check.** Run `js.check({ path })` on the source. Complete when it reports no diagnostics.
4. **Build.** Run `artifacts.buildPage({ path })`. It builds the page as Backoffice does when it
   opens, without providers, and caches the build for viewers. Complete when it returns
   `{ status: "built" }`; a `failed` result's `message` is what the page would show, such as an
   error that names the query and, for fields, lists the collection's fields, or a TanStack DB rule
   the query breaks.

5. **Hand off.** Give the user the source path. Selecting it in Files shows the live page on its
   Page tab; the dashboard's "+" tab lists every page, and a page opens as a dashboard tab at
   `/backoffice/dashboard/<scope>/pages/<path>`, where `<scope>` is the scope segment of their Files
   URL and `<path>` is the source's path under `/workspace` without `.page.js`. Complete when the
   user has the path.

## Branches

- To change a page, edit its source, then check and build again. The `.build` file is the system's
  cache; leave it to the system.
- When the page or the Files preview shows "Invalid page", its message is the build's error. Fix the
  source and build again.

## Source

The module is pure: data comes from queries, time from `now`, and code from `page`, `ui`, and the
saved modules it imports. The system builds it without providers such as `state`, and caches the
result until the source changes; `artifacts.buildPage` builds it the same way, so it reports a
module that reads them.

```js
export default page.define(
  { title: "Automations" },
  ({
    collections,
    from,
    toArray,
    eq,
    gte,
    coalesce,
    count,
    sum,
    max,
    caseWhen,
    intervals,
    bucket,
    now,
  }) => {
    const day = now.minus("24 hours");
    const hours = intervals({ every: "1 hour", since: day });

    // One row per run with the name people know it by, read below as a source.
    const runs = from({ run: collections.workflowInstances }).select(({ run }) => ({
      id: run.id,
      workflow: coalesce(run.remoteWorkflowName, run.workflowName),
      workflowName: run.workflowName,
      instanceId: run.instanceId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));

    const workflows = from({ run: runs })
      .groupBy(({ run }) => run.workflow)
      .select(({ run }) => ({
        workflow: run.workflow,
        started: count(run.id),
        errored: sum(caseWhen(eq(run.status, "errored"), 1, 0)),
        last: max(run.updatedAt),
      }));

    const health = from({ workflow: workflows })
      .orderBy(({ workflow }) => workflow.last, "desc")
      .select(({ workflow }) => ({
        workflow: workflow.workflow,
        errored: workflow.errored,
        latest: toArray(
          from({ run: runs })
            .where(({ run }) => eq(run.workflow, workflow.workflow))
            .orderBy(({ run }) => run.updatedAt, "desc")
            .limit(1)
            .select(({ run }) => ({
              workflowName: run.workflowName,
              instanceId: run.instanceId,
              status: run.status,
              updatedAt: run.updatedAt,
            })),
        ),
        hourly: toArray(
          from({ run: runs })
            .where(({ run }) => eq(run.workflow, workflow.workflow))
            .where(({ run }) => gte(run.createdAt, day))
            .groupBy(({ run }) => bucket(run.createdAt, hours))
            .select(({ run }) => ({ hour: bucket(run.createdAt, hours), runs: count(run.id) })),
        ),
      }));

    const started = from({ run: runs })
      .where(({ run }) => gte(run.createdAt, day))
      .select(({ run }) => ({ total: count(run.id) }));

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
              to: {
                kind: "run",
                workflowName: row.latest[0].workflowName,
                instanceId: row.latest[0].instanceId,
              },
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
                ui.runStatus({ status: row.latest[0].status }),
                ui.relativeTime({ time: row.latest[0].updatedAt }),
              ]),
            ],
          ),
        ),
      ),
    ]);
  },
);
```

The title heads the page. Return the root element from the callback; `page.define` renders it. Write
expressions inline in each callback, as above; a helper function that takes a source's fields needs
a JSDoc type to pass `js.check`.

## Queries

- `from({ alias: source })` starts a query; a source is a collection or another query. `join` keeps
  matching rows and `leftJoin` keeps every row; both match with `eq(left, right)`, where one side
  reads the sources before the join and the other the joined source, such as
  `eq(run.id, step.instanceRef)`.
- `where`, `groupBy`, `having`, `select`, `orderBy`, and `limit` follow TanStack DB. Call `orderBy`
  again for ties; `limit` needs an `orderBy`.
- Joined and grouped queries `select` the fields they show.
- `count`, `sum`, `avg`, `min`, and `max` belong in `select`, `having`, and `orderBy`. Count a
  condition with `sum(caseWhen(eq(run.status, "errored"), 1, 0))`.
- `toArray(query)` is a `select` field holding the rows of `query` for each selecting row. The query
  starts with `from`, not `unionAll`, and its `where` matches the selecting row with `eq`, such as
  `eq(run.workflow, workflow.workflow)` above; its own aliases differ from the selecting row's. A
  grouped query cannot select `toArray`: group in a query, then read it with `from`, as `health`
  reads `workflows`.
- `unionAll(a, b, ...)` lists the rows of queries that select the same fields under distinct
  aliases, such as waiting and errored runs. Order or limit it by reading it with `from`.
- Times are relative to `now`, such as `now.minus("7 days")`; the page moves `now` every minute.
- `intervals({ every, since })` names consecutive intervals; `bucket(time, intervals)` labels each
  time with its interval's start. Repeat the bucket in `groupBy`, `select`, and `orderBy`, and pass
  the same intervals to a chart's `axis` so intervals without rows show.
- JSON fields read nested values by property, such as `route.trigger.kind`.
- `caseWhen` with a default keeps its literal values, so it can choose a tone or a label.

## Binding results

- Values keep their types; times arrive as ISO 8601 strings. Each component checks its props as it
  renders and, when a value does not fit, shows what is wrong in its place.
- A query goes in a prop that shows rows, such as `ui.table` `rows` or a chart's `rows`. Without
  `select`, a row carries every field of its collection, and a table's columns choose which to show.
- `ui.each(query, (row) => element)` is the children of `ui.rowList`, `ui.panelTable`, `ui.stack`,
  or `ui.grid`: one element per row. `row.field` reads a field, and `row.latest[0].status` reads
  into nested rows. A nested `ui.each(row.hourly, ...)` reads only its own rows.
- `ui.when(ui.is(row.errored, { gt: 0 }), element)` shows an element while a live value matches.
- `query.value(field, whenEmpty)` goes in a single-value prop, such as `ui.metric` `value`. It holds
  the field of the first row, or `whenEmpty` while the query has no rows; an aggregate over no rows
  has no row, so give counts `0`.

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
  `errored`; derived collections carry some, such as `displayName`.
- `ui.link({ label, to })` opens a run (`{ kind: "run", workflowName, instanceId }`, where
  `workflowName` is the run's internal name), a route (`{ kind: "route", id }`), a connection
  (`{ kind: "connection", id }`), or the scope's integrations or agents (`{ kind: "integrations" }`,
  `{ kind: "agents" }`).
- `ui.relativeTime({ time })` shows "3m ago" or "in 2h" and moves with the page.
- `ui.number({ value, format })` rounds as it shows; queries cannot round. A `percent` takes a
  ratio, such as `divide(workflow.completed, workflow.finished)`, and null shows a dash.
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

Pages show the synchronized collections and what Backoffice derives from them: `connections` holds
each connection's current state, `agents` each agent's activity and queue, `agentTurns` the turns
agents ended, and `workflowWaits` what waiting runs wait for and whether they ask a person. The home
page example reads all four. When the user asks for forms, data the collections do not hold, or the
orchestration graph, build the closest page and tell them which part pages cannot express yet.
