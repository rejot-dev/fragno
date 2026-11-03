---
name: building-sites
description:
  "Sites: web apps written as /workspace/**/<name>.site directories of HTML, CSS, and browser
  JavaScript, with an optional worker.js handling requests. Use when the user asks for a website,
  web app, or interactive tool made of their own HTML, to change one, or for a link to one. A view
  of automation data is a page instead."
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
   requests that need code on the server, which `worker.js` answers. A site of HTML, CSS, and
   browser JavaScript alone needs no `worker.js`. Complete when every URL the site requests is
   either a file under `public/` or a route `worker.js` answers itself.
2. **Write.** Save each file with `state.writeFile`, following Serving below. Complete when every
   link between its files is relative, as Links defines.
3. **Build.** Run `artifacts.buildSite({ path })` with the site's directory, such as
   `/workspace/tools/todo.site`. Complete when it returns `{ status: "built" }`; a `failed` result's
   `message` names what to fix, such as an import of a package.
4. **Hand off.** Give the user the site's URL: `/backoffice/sites/<scope>/<path>/` on the Backoffice
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

- **Imports:** `worker.js` imports saved `.js` modules by relative path, at most 1 MB of source in
  all; a package import fails the build.
- **Isolation:** the Worker has no network, so `fetch` throws, and no bindings besides `ASSETS`. It
  never sees the viewer's cookies or `Authorization` header, and a `Set-Cookie` it returns is
  dropped.
- **Memory:** module-level variables last while the Worker stays loaded, and every build starts them
  empty. Treat them as a cache.
- **Browser:** scripts in `public/` run in the viewer's browser, so they may import ES modules from
  a CDN such as `https://esm.sh/`.

## Links

The site lives under a path, so every URL inside it is relative to the file that names it:
`href="app.css"`, `fetch("api/todos")`, `src="./img/logo.png"`, and `href="../"` from a
subdirectory. A URL starting with `/`, such as `/api/todos`, leaves the site for Backoffice's own
routes. A sibling site in the same directory is `../other.site/`.
