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

1. **Ground.** Read `/static/codemode/page.d.ts` for the collections, their fields, and the query
   functions, and `/static/codemode/ui.d.ts` for the components. Complete when every field you plan
   to show belongs to its collection in `PageCollections`.
2. **Write the source.** Save the module with `state.writeFile`, following the example below.
   Complete when it default-exports `page.define(...)` and is pure, as the Source section defines.
3. **Check.** Run `js.check({ path })` on the source. Complete when it reports no diagnostics.
4. **Verify.** In a separate codemode call, import the source and return its preview:

   ```js
   async () => {
     const { default: definition } = await import("/workspace/reports/operations.page.js");
     // Shows the interface with empty results, which validates the spec.
     return { $ui: page.preview(definition) };
   };
   ```

   Complete when the call succeeds and its result reports no generated UI error. A builder error
   names the call and, for fields, lists the collection's fields.

5. **Hand off.** Give the user the source path. Selecting it in Files shows the live page on its
   Page tab; the page also opens at `/backoffice/pages/<scope>/<path>`, where `<scope>` is the scope
   segment of their Files URL and `<path>` is the source's path under `/workspace` without
   `.page.js`. Complete when the user has the path.

## Branches

- To change a page, edit its source, then check and verify again. The `.build` file is the system's
  cache; leave it to the system.
- When the page or the Files preview shows "Invalid page", its message is the build's error. Fix the
  source and verify again.

## Source

The module is pure: data comes from queries, time from `now`, and code from `page`, `ui`, and the
saved modules it imports. The system builds it without providers such as `state`, and caches the
result until the source changes, so step 4's codemode call, which has providers, cannot catch a
module that reads them.

```js
export default page.define(
  ({ collections, from, and, eq, gte, coalesce, count, max, bucket, now }) => {
    const day = now.minus("24 hours");
    const runs = collections.workflowInstances;

    const started = from({ run: runs })
      .where(({ run }) => gte(run.createdAt, day))
      .select(({ run }) => ({ total: count(run.id) }));

    const failing = from({ run: runs })
      .where(({ run }) => and(eq(run.status, "errored"), gte(run.createdAt, day)))
      .groupBy(({ run }) => coalesce(run.remoteWorkflowName, run.workflowName))
      .select(({ run }) => ({
        workflow: coalesce(run.remoteWorkflowName, run.workflowName),
        errored: count(run.id),
        last: max(run.createdAt),
      }))
      .orderBy(({ run }) => count(run.id), "desc");

    const hours = { every: "1 hour", since: day };
    const hourly = from({ run: runs })
      .where(({ run }) => gte(run.createdAt, day))
      .groupBy(({ run }) => bucket(run.createdAt, hours))
      .select(({ run }) => ({ hour: bucket(run.createdAt, hours), runs: count(run.id) }))
      .orderBy(({ run }) => bucket(run.createdAt, hours), "asc");

    return ui.stack({ gap: "md" }, [
      ui.metric({ label: "Runs today", value: started.value("total", "0") }),
      ui.table({
        caption: "Failing workflows",
        columns: [
          { key: "workflow", label: "Workflow" },
          { key: "errored", label: "Errored", align: "end" },
          { key: "last", label: "Last failure" },
        ],
        rows: failing,
      }),
      ui.table({
        caption: "Runs per hour",
        columns: [
          { key: "hour", label: "Hour" },
          { key: "runs", label: "Runs", align: "end" },
        ],
        rows: hourly,
      }),
    ]);
  },
);
```

Return the root element from the callback; `page.define` renders it. Write expressions inline in
each callback, as above; a helper function that takes a source's fields needs a JSDoc type to pass
`js.check`.

## Queries

- `from({ alias: collections.name })` starts a query. `join` keeps matching rows and `leftJoin`
  keeps every row; both match with `eq(field, field)`, such as `eq(run.id, step.instanceRef)`.
- `where`, `groupBy`, `having`, `select`, `orderBy`, and `limit` follow TanStack DB. Call `orderBy`
  again for ties; `limit` needs an `orderBy`.
- Joined and grouped queries `select` the fields they show.
- `count`, `sum`, `avg`, `min`, and `max` belong in `select`, `having`, and `orderBy`. Count a
  condition with `sum(caseWhen(eq(run.status, "errored"), 1, 0))`.
- Times are relative to `now`, such as `now.minus("7 days")`; the page moves `now` every minute.
- `bucket(time, { every, since })` groups times into intervals; repeat it in `groupBy`, `select`,
  and `orderBy` with one shared options object.
- JSON fields read nested values by property, such as `route.trigger.kind`.

## Binding results

- A query goes in a prop that shows rows, such as `ui.table` `rows`. Every value arrives as text:
  times as ISO 8601, JSON as JSON, and null as an empty cell. Without `select`, a row carries every
  field of its collection, and the table's columns choose which to show.
- `query.value(field, whenEmpty)` goes in a text prop, such as `ui.metric` `value`. It shows the
  field of the first row, or `whenEmpty` while the query has no rows; an aggregate over no rows has
  no row, so give counts `"0"`.

## Supported today

Pages show tables and metrics over the synchronized collections. When the user asks for charts,
links to runs, relative times such as "3 minutes ago", forms, or data the collections do not hold,
build the closest tables and metrics and tell them which part pages cannot express yet.
