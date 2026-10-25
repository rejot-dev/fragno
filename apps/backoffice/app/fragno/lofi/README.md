# Backoffice SQLite replica

Lofi's browser SQLite replica (`@fragno-dev/lofi/sqlite`) mirrors a scope's **Upload** backend
(`/api/upload-scoped/<scope>`, schema `upload`, whose outbox carries only the `file` table), in
`../upload/lofi`. It replaced the TanStack collection there. Everything else, including the
dashboard and the Files explorer's workflow routes, still reads the Automations TanStack DB
collections in `../automation/tanstack`.

Shared pieces in this directory:

- `browser-replica.ts`: `getBrowserReplica`, one replica per backend instance and tab, cached so
  Suspense sees one promise.
- `replica-gate.tsx`: `LofiReplicaGate` shows the download, with its percentage, until the replica
  has caught up, and only then the view. The download panel is the design system's
  `BackofficeDownloadState`. A replica that caught up in an earlier session opens caught up, so the
  download shows on a browser's first visit, or after a new backend instance or schema version opens
  a new database.
- `use-lofi-sqlite-read.ts`: `useLofiSqliteRead`, which reads a replica again whenever any tab
  applies outbox entries.
- `scenario-replica-database.ts`: the scenario harness's replicas (`ctx.lofi.upload`), on
  wa-sqlite's in-memory VFS.

## What reads the Upload replica

The Files explorer's workspace tree (`routes/backoffice/files/explorer.tsx`) and the Upload file
manager (`routes/backoffice/connections/upload/files.tsx`), through `readReadyUploadFiles`.
`upload/lofi/replica.scenario.test.ts` uploads, deletes, and lists files through it. The explorer no
longer previews pages, which render over the Automations TanStack collections; it links to them
instead.

## Measurements

A scope with 50 files rewritten 120 times has 6,559 outbox entries (6.9 MB of stream). In Chrome, in
a background tab, with only the Upload replica empty:

- The server sends the whole stream in 0.35–0.45 s.
- With one call to the database worker per statement, the download showed for 3.1–4.1 s: 7,253 calls
  at 0.35–0.45 ms each, about 4× what the same calls cost on the benchmark page in the same tab.
- With a batch's statements in two calls, it shows for 0.8–1.5 s: 270 calls, of which the 130 that
  carry a batch's writes take about 8 ms each. The panel appears 1.3–2 s after navigation; the
  server's tree shows until then.
- The replay benchmark (`packages-private/lofi-sqlite-import-benchmark`, `?schema=upload`) imports
  the same stream in 0.49 s in headless Chrome with two calls per batch, from 0.72 s before.

## Risks and follow-ups

- **The explorer flashes on a first visit.** It renders the server's snapshot of the tree, then the
  download while the Upload replica catches up, then the replica's tree.
- **Workers race at startup.** Each database worker (wa-sqlite 1.7.2's `OPFSCoopSyncVFS`) deletes
  the temporary `.ahp-*` directories closed workers left in OPFS. Two workers that list the
  directory at the same time both try to delete the same one, and the second fails its open with
  `NotFoundError`; three workers running that loop against three leftover directories failed in 14
  of 30 trials. While the Automations replica opened next to the TanStack DB database, both started
  after the same `GET /_internal`, and 3 of 12 reloads showed the route's error page. Files pages
  now start the TanStack database at 260–440 ms and the Upload replica at 790–1,580 ms, after its
  own `GET /_internal`, so their cleanups do not overlap: 20 of 20 reloads opened. Tabs share OPFS,
  so workers of two tabs opening at once can still race. The replica retries its open; the TanStack
  database does not. wa-sqlite 2.x ignores the `NotFoundError` there, but
  `@tanstack/browser-db-sqlite-persistence` (0.2.37) accepts only `^1.4.1`; backporting that change
  as a pnpm patch of 1.7.2 would fix both.
- **Returning visits show older data without saying so.** A replica that caught up before opens at
  once and replays what changed since in the background, with no indicator.
- **Failures show as text.** The download and the Files views show the writing tab's last error
  while it retries.
- **OPFS files accumulate:** one database per visited scope, and a new one whenever the adapter
  identity or the schema version changes. Nothing deletes old ones.
- **Two streams and two workers per Files tab:** the Upload replica and the Automations TanStack
  collections, each with its own `GET /_internal`, outbox stream, OPFS database, and worker.
- **The project menu refreshes on navigation, not live.** It lists projects as of the last time the
  layout's loader ran, which actions such as creating a project rerun; a project an agent creates
  shows after the next navigation. Once every page reads the Automations replica, pages outside a
  project scope already hold the scope's `project` table, so the menu can read it there and follow
  it live. Project scopes list their owner's projects, which only the owner's replica holds, so they
  would keep the server query rather than download the owner's history for the menu.
