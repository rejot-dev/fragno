---
name: building-sites
description:
  "Sites: web apps written as /workspace/**/<name>.site directories of HTML, CSS, and browser
  JavaScript, with an optional worker.js handling requests. Use when the user asks for a website,
  web app, or interactive tool made of their own HTML, to change one, or for a link to one. A view
  of automation data inside Backoffice is a page instead."
---

# Building sites

A site is an artifact: a `<name>.site` directory anywhere under `/workspace`, built into a snapshot
that Backoffice serves at `/backoffice/sites/<scope>/<path>/`, where `<path>` is the directory's
path under `/workspace`. Only people signed in to Backoffice who may read the scope's workspace
reach it. A site cannot be inside another site.

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
   answers. A site of HTML, CSS, and browser JavaScript alone needs no `worker.js`. Complete when
   every URL the site requests is either a file under `public/` or a route `worker.js` answers
   itself.
2. **Write.** Save each file with `state.writeFile`, following Serving below. Complete when every
   link between its files is relative, as Links defines.
3. **Build.** Run `artifacts.buildSite({ path })` with the site's directory, such as
   `/workspace/tools/todo.site`. Complete when it returns `{ status: "built" }`; a `failed` result's
   `message` names what to fix, such as an import of a package.
4. **Check.** Request the site's `/` and every route its pages call with
   `artifacts.requestSite({ path, url })`, such as `url: "/api/todos?page=2"`, with `method`,
   `headers`, and a text `body` for a route that takes a form or JSON. Each answer has the status
   and body a viewer would get, and `log`: what the Worker printed and threw while answering. A
   request reaches the latest build and reads the scope's data as viewers do, without their session.
   Fix what a 4xx or 5xx status, a wrong body, or an exception in `log` names, then build and check
   again. Complete when every route answers as the pages expect and no `log` has an exception.
5. **Hand off.** Give the user the site's URL: `/backoffice/sites/<scope>/<path>/` on the Backoffice
   they use, where `<scope>` is the two segments after `/files/` in their Files URL, such as
   `org/acme`, and the URL ends in `/`. Selecting the directory in Files also shows an "Open site"
   link. Complete when the user has the URL.

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
  `exceededCpu`), console lines, and exceptions with their stacks. Fix what the entries name, build
  again, and request the failing route with `artifacts.requestSite` before asking the user to
  reload.
- When `artifacts.requestSite` answers 503, the scope's data is still being copied; check
  `artifacts.siteDataStatus({})`, and request again once it is `caught-up`. When `log` is null, the
  request was answered before the Worker ran, such as a 404 for a site without a build.

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
  error. When a site answers 503 or shows old data, `artifacts.siteDataStatus({})` tells whether the
  copy is still running, how far it got, and its last error. A query that writes, holds two
  statements, names an unknown relation, or returns more than 10000 rows or 4 MB throws, with a
  message naming what to fix. Everyone who opens the site sees what the Worker returns, so it
  returns only what the site is for.

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
- **Isolation:** the Worker has no network, so `fetch` throws, and no bindings besides `ASSETS` and
  `DATA`. It never sees the viewer's cookies or `Authorization` header, and a `Set-Cookie` it
  returns is dropped.
- **Logs:** what the Worker prints with `console` and every exception it lets escape is kept with
  the request, for a day and the latest 200 requests; requests that print nothing and answer below
  500 are not. Log what helps find a mistake, such as a query's parameters, and never secrets.
- **Memory:** module-level variables last while the Worker stays loaded, and every build starts them
  empty. Treat them as a cache.
- **Browser:** scripts in `public/` run in the viewer's browser, so they may import ES modules from
  a CDN such as `https://esm.sh/`.

## Links

The site lives under a path, so every URL inside it is relative to the file that names it:
`href="app.css"`, `fetch("api/todos")`, `src="./img/logo.png"`, and `href="../"` from a
subdirectory. A URL starting with `/`, such as `/api/todos`, leaves the site for Backoffice's own
routes. A sibling site in the same directory is `../other.site/`.
