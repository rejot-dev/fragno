---
name: building-pages
description:
  "Pages: artifacts that show live automation data, written as /workspace/**/<name>.page.js with
  page.define. Use when the user asks for a dashboard or an always-current view of runs, events,
  routes, or stored values, or to change one."
---

# Building pages

A page is an artifact: one source module, `<name>.page.js` anywhere under `/workspace`, that
default-exports `page.define(...)`: live queries over the scope's synchronized collections, written
in TanStack DB's query style and placed in a `ui` interface. When the page is opened, the system
builds the source into the mirrored path under `/workspace/.build`, such as
`/workspace/.build/reports/operations.page.json`, and rebuilds it whenever the source changes; the
page runs the queries in the browser and re-renders as the data changes.

## Steps

1. **Ground.** Read `/static/codemode/page.d.ts` for the query functions,
   `/static/codemode/page-schema.d.ts` for the collections, their fields, and the limits, and
   `/static/codemode/ui-catalog.d.ts` for the components. Complete when every field you plan to show
   belongs to its collection in `PageCollections`.
2. **Write the source.** Save the module with `state.writeFile`, following the example below.
   Complete when it default-exports `page.define(...)` and is pure, as the Source section defines.
3. **Check.** Run `js.check({ path })` on the source. Complete when it reports no diagnostics.
4. **Build.** Run `artifacts.buildPage({ path })`. It builds the page as Backoffice does when it
   opens, without providers, and caches the build for viewers. Complete when it returns
   `{ status: "built" }`; a `failed` result's `message` is what the page would show, such as an
   error that names the query and, for fields, lists the collection's fields, or a TanStack DB rule
   the query breaks.

5. **Hand off.** Give the user the source path. Selecting it in Files shows the live page on its
   Page tab; the page also opens at `/backoffice/pages/<scope>/<path>`, where `<scope>` is the scope
   segment of their Files URL and `<path>` is the source's path under `/workspace` without
   `.page.js`. Complete when the user has the path.

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
  ({
    collections,
    from,
    many,
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
        latest: many(
          from({ run: runs })
            .where(({ run }) => eq(run.workflow, workflow.workflow))
            .orderBy(({ run }) => run.updatedAt, "desc")
            .limit(1)
            .select(({ run }) => ({
              workflowName: run.workflowName,
              instanceId: run.instanceId,
              status: run.status,
              tone: caseWhen(
                eq(run.status, "errored"),
                "failed",
                eq(run.status, "complete"),
                "live",
                "waiting",
              ),
              updatedAt: run.updatedAt,
            })),
        ),
        hourly: many(
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

    return ui.stack({ gap: "md" }, [
      ui.metric({ label: "Runs today", value: started.value("total", 0) }),
      ui.stack(
        { gap: "sm" },
        ui.each(health, (row) =>
          ui.grid({ columns: 4, gap: "sm" }, [
            ui.link({
              label: row.workflow,
              to: {
                kind: "run",
                workflowName: row.latest[0].workflowName,
                instanceId: row.latest[0].instanceId,
              },
            }),
            ui.sparkBars({
              label: "Starts per hour",
              rows: row.hourly,
              axis: { field: "hour", intervals: hours },
              value: "runs",
            }),
            ui.badge({ label: row.latest[0].status, tone: row.latest[0].tone }),
            ui.relativeTime({ time: row.latest[0].updatedAt }),
            ui.when(ui.is(row.errored, { gt: 0 }), ui.text({ text: "Has errored runs" })),
          ]),
        ),
      ),
    ]);
  },
);
```

Return the root element from the callback; `page.define` renders it. Write expressions inline in
each callback, as above; a helper function that takes a source's fields needs a JSDoc type to pass
`js.check`.

## Queries

- `from({ alias: source })` starts a query; a source is a collection or another query. `join` keeps
  matching rows and `leftJoin` keeps every row; both match with `eq(field, field)`, such as
  `eq(run.id, step.instanceRef)`.
- `where`, `groupBy`, `having`, `select`, `orderBy`, and `limit` follow TanStack DB. Call `orderBy`
  again for ties; `limit` needs an `orderBy`.
- Joined and grouped queries `select` the fields they show.
- `count`, `sum`, `avg`, `min`, and `max` belong in `select`, `having`, and `orderBy`. Count a
  condition with `sum(caseWhen(eq(run.status, "errored"), 1, 0))`.
- `many(query)` is a `select` field holding the rows of `query` for each selecting row. The query
  starts with `from`, not `unionAll`, and its `where` matches the selecting row with `eq`, such as
  `eq(run.workflow, workflow.workflow)` above; its own aliases differ from the selecting row's. A
  grouped query cannot select `many`: group in a query, then read it with `from`, as `health` reads
  `workflows`.
- `unionAll(a, b, ...)` lists the rows of queries that select the same fields under distinct
  aliases, such as waiting and errored runs. Order or limit it by reading it with `from`.
- Times are relative to `now`, such as `now.minus("7 days")`; the page moves `now` every minute.
- `intervals({ every, since })` names consecutive intervals; `bucket(time, intervals)` labels each
  time with its interval's start. Repeat the bucket in `groupBy`, `select`, and `orderBy`, and pass
  the same intervals to a chart's `axis` so intervals without rows show.
- JSON fields read nested values by property, such as `route.trigger.kind`.
- `caseWhen` with a default keeps its literal values, so it can choose a tone, as `tone` does above.

## Binding results

- Values keep their types; times arrive as ISO 8601 strings. Each component checks its props as it
  renders and, when a value does not fit, shows what is wrong in its place.
- A query goes in a prop that shows rows, such as `ui.table` `rows` or a chart's `rows`. Without
  `select`, a row carries every field of its collection, and a table's columns choose which to show.
- `ui.each(query, (row) => element)` is the children of `ui.stack`, `ui.grid`, or `ui.section`: one
  element per row. `row.field` reads a field, and `row.latest[0].status` reads into nested rows. A
  nested `ui.each(row.hourly, ...)` reads only its own rows.
- `ui.when(ui.is(row.errored, { gt: 0 }), element)` shows an element while a live value matches.
- `query.value(field, whenEmpty)` goes in a single-value prop, such as `ui.metric` `value`. It holds
  the field of the first row, or `whenEmpty` while the query has no rows; an aggregate over no rows
  has no row, so give counts `0`.

## Components for live data

- `ui.link({ label, to })` opens a run (`{ kind: "run", workflowName, instanceId }`, where
  `workflowName` is the run's internal name), a route (`{ kind: "route", id }`), or a connection
  (`{ kind: "connection", id }`) in the page's scope.
- `ui.relativeTime({ time })` shows "3m ago" or "in 2h" and moves with the page.
- `ui.sparkBars` and `ui.barChart` take `rows`, an `axis` naming the field along it, and the `value`
  field to size bars by; `ui.barChart` also stacks by a `series` field.
- `ui.badge({ label, tone })` shows a status light.

## Supported today

Pages show the synchronized collections. When the user asks for forms, data the collections do not
hold, or Backoffice's own judgments, such as what a waiting run waits for, whether it awaits input,
or a connection's current state, build the closest page and tell them which part pages cannot
express yet.
