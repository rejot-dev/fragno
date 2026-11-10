---
name: building-sites
description:
  "Sites: web apps at an address of their own, built from /workspace/**/<name>.site directories. Use
  when the user asks for a website or web app, to change or fix one, or for a link to one. A view of
  automation data inside Backoffice is a page instead."
---

# Building sites

A site is an artifact: a `<name>.site` directory anywhere under `/workspace`, built into a snapshot
served at its scope's own address, at the directory's path under `/workspace`, such as
`https://quiet-amber-falcon.ley.run/tools/todo.site/`. Only people signed in to Backoffice who may
read the scope's workspace open it. A site cannot be inside another site.

```text
/workspace/tools/todo.site/
  public/index.html   the file at …/tools/todo.site/
  public/app.js       the file at …/tools/todo.site/app.js
  worker.js           handles every request, such as …/tools/todo.site/api/todos
  lib/todos.js        a saved module worker.js imports
```

## Steps

1. **Plan.** Split the site into files the browser loads as they are, which go under `public/`, and
   requests that need code on the server, such as reads of automation data, which `worker.js`
   answers. A site of HTML, CSS, and browser JavaScript alone needs no `worker.js`. What viewers add
   or change, such as TODOs, is kept as Writing data describes. The site serves the people who send
   and read; what the scope's own people do with what was sent, such as accepting or denying a
   request, happens in the workflow its event starts, as Starting workflows describes. Complete when
   every URL the site requests is either a file under `public/` or a route `worker.js` answers
   itself, every change a viewer makes has its event and the read that shows it, and every decision
   on what viewers send waits in a workflow.
2. **Write.** Save each file with `state.writeFile`, following Serving below. Complete when every
   link between its files is relative, as Links defines.
3. **Build.** Run `artifacts.buildSite({ path })` with the site's directory, such as
   `/workspace/tools/todo.site`. Complete when it returns `{ status: "built", url }`; a `failed`
   result's `message` names what to fix, such as an import of a package.
4. **Check.** Request the site's `/` and every route its pages call with
   `artifacts.requestSite({ path, url })`, such as `url: "/api/todos?page=2"`, adding `method`,
   `headers`, and a text `body` for a route that takes a form or JSON, and `viewer` for a route that
   reads who is viewing, as Viewers defines. Each answer has the status, headers, and body a viewer
   would get from the latest build; `log`: what the Worker printed and threw while answering, or
   null when the host answered before the Worker ran, such as a 404 for a site without a build; and
   `events`: what the Worker fired, kept instead of fired unless the request sets `fire: true`, as
   Writing data describes. Fix what a 4xx or 5xx status, a wrong body, an exception in `log`, or a
   missing event names, then build and check again. Complete when every route answers as the pages
   expect and fires what it should, and no `log` has an exception.
5. **Hand off.** Give the user the `url` the build returned; selecting the directory in Files also
   shows an "Open site" link. Where `url` is null, tell them the site is built and checked, but this
   Backoffice cannot show it to people. Complete when the user has the URL, or knows why there is
   none.

## Branches

- To change a site, edit its files, then build again. Viewers see the previous build until the new
  one succeeds, and the new one within a second after; a failed build keeps the previous one
  serving. The system keeps builds, under `/workspace/.build` or in storage of its own; leave them
  to it.
- When the build fails with "This deployment does not serve sites", tell the user this Backoffice
  does not serve sites; a page may serve the need instead.
- When a site fails or answers wrongly for the user, read what its Worker logged and threw with
  `artifacts.siteLogs({ path, errorsOnly: true })` before changing its code; pass
  `since: <ISO time of the last build>` to leave out requests the previous build handled. Each entry
  is one request: its path, status, outcome (`exception` when it threw, or a limit such as
  `exceededCpu`), console lines, and exceptions with their stacks. Logs keep the last day and the
  latest 200 requests, without those that printed nothing and answered below 500. Fix what the
  entries name, build again, and request the failing route with `artifacts.requestSite` before
  asking the user to reload.
- When building a site with `worker.js`, requesting it, or reading its logs fails as not granted a
  permission such as `store.read`, tell the user: a Worker reads all of the scope's automation data,
  so these need the read permissions of all of it. Give the agent those permissions, or build a site
  of files only.
- When a site answers 503 or shows old data, check `artifacts.siteDataStatus({})`: whether the copy
  of the scope's data for sites is still running, how far it got, and its last error. Request again
  once it is `caught-up`.

## Serving

- **Worker:** `worker.js` default-exports `{ async fetch(request, env) { ... } }` and receives every
  request to the site. `new URL(request.url).pathname` is the path within the site, such as
  `/api/todos`. A site without `worker.js` serves its files and nothing else.
- **Files:** `env.ASSETS.fetch(request)` answers a `GET` or `HEAD` with the file under `public/` at
  the request's path, with a content type from its extension: a path ending in `/` gets that
  directory's `index.html`, and anything else is 404. Each file holds at most 1.9 MB, and `public/`
  at most 1000 files and 50 MB in all; a build over either fails and names it.

  ```js
  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/api/time") {
        return Response.json({ now: new Date().toISOString() });
      }
      const file = await env.ASSETS.fetch(request);
      // A single-page app answers its own routes with its page.
      return file.status === 404 ? env.ASSETS.fetch(new Request(new URL("/", url))) : file;
    },
  };
  ```

- **Data:** `env.DATA.sql` reads the scope's automation data with the SQL pages read it with: one
  SELECT, which may start with `WITH`, over the relations `PageRelations` declares in
  `/static/codemode/page-schema.d.ts`, such as `runs`, `events`, `kv_store`, and `agents`. It is a
  tagged template: each `${value}` binds as a parameter, a list reads as `IN (${list})`, a `Date` as
  milliseconds since the epoch, and another `sql` query nests as its SQL. Awaiting a query returns
  its rows as objects by column, with values as SQL holds them: times as milliseconds since the
  epoch, booleans as 0 or 1, and JSON as text, read with `->>`. Reads follow changes within moments.
  The data is copied for sites from the site's first build; until that copy is done, a request that
  reads it gets 503, "unavailable while its data is copied", whatever the Worker does with the
  error. A query that writes, holds two statements, names an unknown relation, or returns more than
  10000 rows or 4 MB throws, with a message naming what to fix. Everyone who opens the site sees
  what the Worker returns, so it returns only what the site is for.

  ```js
  export default {
    async fetch(request, env) {
      const { sql } = env.DATA;
      const url = new URL(request.url);
      if (url.pathname === "/api/runs") {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const statuses = url.searchParams.getAll("status");
        return Response.json(
          await sql`SELECT workflowName, status, createdAt FROM runs
            WHERE createdAt >= ${since} AND status IN (${statuses})
            ORDER BY createdAt DESC LIMIT 50`,
        );
      }
      return env.ASSETS.fetch(request);
    },
  };
  ```

- **Imports:** `worker.js` imports saved `.js` modules by relative path, at most 1 MB of source in
  all; a package import fails the build.
- **Viewers:** each request carries `ley-viewer-id` and `ley-viewer-email` headers naming who is
  viewing, which only the host sets. `artifacts.requestSite` sets them from its
  `viewer: { id, email }`, and refuses `ley-` headers of its own.
- **Isolation:** the Worker has no network, so `fetch` throws, and no bindings besides `ASSETS` and
  `DATA`. It receives the cookies the scope's sites set; a cookie it sets for the whole domain is
  dropped. The scope's sites share one address, and with it cookies and browser storage, so name
  cookies and storage keys after the site.
- **Host headers:** every answer carries headers the site can add to but not loosen: no other site
  may frame its pages, forms post only to its own address, and camera, microphone, location, and
  payments are off. Requests other than GET, HEAD, and OPTIONS from other sites' pages are refused.
  A service worker controls at most its site's directory: `Service-Worker-Allowed` is dropped.
- **Logs:** what the Worker prints with `console` and every exception it lets escape is kept with
  the request, for `artifacts.siteLogs`. Log what helps find a mistake, such as a query's
  parameters, and keep secrets out.
- **Memory:** module-level variables last while the Worker stays loaded, and every build starts them
  empty. Treat them as a cache.
- **Browser:** scripts in `public/` run in the viewer's browser, so they may import ES modules from
  a CDN such as `https://esm.sh/`.

## Writing data

A site writes nothing itself: the Worker fires an **event** for each thing a viewer adds or changes,
and reads the events back with `env.DATA.sql` from the `events` relation. The events are the site's
data, kept in the order they were fired.

- **Fire:** `await env.DATA.fire({ type, payload, viewer })` fires an event into the scope's
  automations from the source `site:<path>`, such as `site:/workspace/tools/todo.site`, and returns
  `{ eventId }`, which is null when `artifacts.requestSite` keeps the event. Give each kind of thing
  one type, such as `todos.changed`, and put in `payload` everything the site shows, such as the
  viewer's email from `ley-viewer-email`: an object of at most 64 KB, as JSON reads it. `viewer`,
  such as `request.headers.get("ley-viewer-id")`, names whom the event concerns, as its subject. A
  viewer fires at most 60 events every 10 seconds on a site, and events naming no viewer share one
  count; past it, `fire` throws.
- **Permission:** a Worker fires only when whoever built it may emit events, which the build's
  `firesEvents` reports. When it is false for a site that fires, tell the user firing needs
  `events.emit`.
- **Read back:** select the site's events by `source` and `eventType`, reading the payload with
  `->>`. Where data only grows, such as a guestbook's notes, each event is an item. Where items
  change, such as TODOs marked done or deleted, fire the whole item with each change, and keep each
  item's latest event, leaving out deletions, as below. A fired event reaches reads within moments,
  so the page shows a change at once from what it sent, then reads again every second until it
  appears. The source is the site's path: a moved site reads none of the events it fired before.
- **Check:** `artifacts.requestSite` keeps the events its request fires, with their payloads, and
  fires none, so checking adds no data. With `fire: true` it fires them as a viewer's request does
  and gives each its `eventId`: a real change, which the site then shows like any other, so fire
  only what the user expects, such as a request marked as a test.

```js
const SOURCE = "site:/workspace/tools/todo.site";

export default {
  async fetch(request, env) {
    const { sql, fire } = env.DATA;
    const url = new URL(request.url);
    if (url.pathname === "/api/todos" && request.method === "GET") {
      // Each TODO's latest change, newest first, without the deleted ones.
      const rows = await sql`SELECT todo FROM (
          SELECT payload ->> '$.action' AS action, payload ->> '$.todo' AS todo, position,
            row_number() OVER (PARTITION BY payload ->> '$.todo.id' ORDER BY position DESC) AS n
          FROM events WHERE source = ${SOURCE} AND eventType = 'todos.changed')
        WHERE n = 1 AND action != 'delete' ORDER BY position DESC`;
      return Response.json(rows.map((row) => JSON.parse(row.todo)));
    }
    if (url.pathname === "/api/todos" && request.method === "POST") {
      // { action: "save" or "delete", todo: { id, text, done } }
      const { action, todo } = await request.json();
      const viewer = request.headers.get("ley-viewer-id");
      await fire({ type: "todos.changed", payload: { action, todo }, viewer });
      return Response.json(todo, { status: 202 });
    }
    return env.ASSETS.fetch(request);
  },
};
```

### Starting workflows

When what a viewer sends needs work beyond keeping it, such as someone accepting or denying a
support request, its event starts a workflow, and the work happens there. Build the route and the
workflow with `/static/skills/building-automations/SKILL.md`.

- **Route:** triggered by the site's source and the event's type, with the action `start_workflow`,
  `organization-automation` authority granted only what the workflow does, and an
  `instanceIdTemplate` such as `support-${event.id}`. The event acts for nobody, so routes with
  other authority fail on it.
- **Decisions:** the workflow shows what the viewer sent and collects the decision with a form, then
  waits for it, as Collecting workflow input in `/static/skills/generating-backoffice-uis/SKILL.md`
  describes. Whoever decides acts on the run in Backoffice; `workflow.showInstance({ instanceId })`
  shows it to the user.
- **Progress:** the Worker names the run from the `eventId` that `fire` returned, and reads its
  `status` and `output` from `runs`, such as
  `` sql`SELECT status, output FROM runs WHERE instanceId = ${"support-" + eventId}` ``, so the page
  tells the viewer whether their request waits or was decided.
- **Check:** request the route that fires with `fire: true`, then follow the hand-off: the run's id
  comes from the `eventId` in the answer's `events`, as the route's `instanceIdTemplate` names it;
  read it with `workflow.getInstance({ instanceId })` once the route started it, and send it the
  decisions it waits for with `workflow.sendEvent`, as its form would. Complete when the run reached
  its end, and the Worker's progress read shows it. Tell the user about the test request it made.

### Through the store

Keep the current state in the store instead when data must be erased for good, such as personal data
an event would keep; when a change must be checked against what is there, or call a connected
service; or when a type's history grows past a few thousand events. The event starts a workflow, as
Starting workflows describes, that writes one `kv_store` key per item, such as `todo/<id>`, with the
item as JSON, granted only `store.modify`; the Worker reads `kv_store` by key prefix.

## Links

The site lives under a path, so every URL inside it is relative to the file that names it:
`href="app.css"`, `fetch("api/todos")`, `src="./img/logo.png"`, and `href="../"` from a
subdirectory. A URL starting with `/`, such as `/api/todos`, leaves the site. A sibling site in the
same directory is `../other.site/`.
