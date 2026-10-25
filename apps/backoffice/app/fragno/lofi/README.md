# Backoffice SQLite replica

Lofi's browser SQLite replica (`@fragno-dev/lofi/sqlite`) mirrors two of a scope's backends:

- **Upload** (`/api/upload-scoped/<scope>`, schema `upload`, whose outbox carries only the `file`
  table), in `../upload/lofi`. It replaced the TanStack collection there.
- **Automations** (`/api/automations-scoped/<scope>`, schemas `automations` and `workflows`), in
  `../automation/lofi`, for the dashboard's Overview tab. The same outbox also feeds the TanStack DB
  collections in `../automation/tanstack`, which every other Automations view still reads, including
  the dashboard's Events tab and the Files explorer's workflow routes.

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
- `scenario-replica-database.ts`: the scenario harness's replicas (`ctx.lofi.upload`,
  `ctx.lofi.automations`), on wa-sqlite's in-memory VFS.

## What reads the Upload replica

The Files explorer's workspace tree (`routes/backoffice/files/explorer.tsx`) and the Upload file
manager (`routes/backoffice/connections/upload/files.tsx`), through `readReadyUploadFiles`.
`upload/lofi/replica.scenario.test.ts` uploads, deletes, and lists files through it. The explorer no
longer previews pages, which render over the Automations TanStack collections; it links to them
instead.

## What reads the Automations replica

The dashboard's Overview tab (`routes/backoffice/dashboard/dashboard.tsx`), which opens no TanStack
database:

- The overview, through `readDashboardOverview` in `overview-replica.ts`: workflow health, failing
  and waiting runs, event volume, scheduled routes, connections, and agents.
  `projectBackofficeDashboard` turns what it reads into the page, as it did with the TanStack
  queries.
- The orchestration graph, through `readOrchestrationRecords` (`orchestration-graph.ts`): the
  scope's own event sources and definitions, and its unfinished runs. Its inspector reads an event
  type's latest events with `readLatestEventsOfType`, and a workflow's running Codemode runs.
- An opened run's timeline, and a page's form for a waiting run, through `readWorkflowRuns`
  (`../automation/lofi/reads.ts`), which selects runs as `workflowRunRecordsQuery` does: waiting
  runs, running Codemode runs, or one run by workflow and instance. A run's waits are derived from
  its steps with `currentWorkflowWaits`.

The project menu in the top bar reads no synchronized data: the layout's loader lists the owner's
projects through the Automations object's `GET /projects` (`../automation/project-list.server.ts`)
and streams them to the menu, so no page opens a database for it.

Those run views are shared with pages that still read the TanStack collections: the Events tab,
pages, Marketplace, Agents, and the Automations script view. They take an `AutomationReadSource`
(`../automation/read-source.ts`) naming the replica or the collections, so each page passes the
source it already holds and none opens a second copy of the scope's history for them.

What Backoffice derives from events, rather than reads off a table, is kept by local projections
(`../automation/lofi/views.ts`) in the local schema `automation_views`. They run in the writing tab,
in the same transaction as each outbox entry, and fold each new event with the functions the
TanStack collections derive the same rows with:

- `pi_agent`, `pi_agent_request`, and `pi_agent_turn`, by `applyPiAgentEvent` and
  `piAgentTurnEndedBy` (`../pi/agent/pi-agent-records.ts`). An agent's counts of running, queued,
  and steering requests change by what each event did to its request, so a request's row keeps what
  its earlier events recorded.
- `integration_connection`, by `applyIntegrationConnectionChange`
  (`../runtime-tools/families/integrations/integration-connections.ts`).

Both readers (`readPiAgentEvent`, `readIntegrationConnectionStateChange`) validate each event once,
when it arrives. Folding events as they arrive relies on nothing deleting them:
`admin.events.delete` refuses `pi` and `integrations` events, so the projections never see one go.
Workflow waits are not projected: the overview reads the waiting runs with their steps anyway, and
derives waits from them with `currentWorkflowWaits`.

`dashboard/overview.scenario.test.ts` reads the overview and the orchestration graph from the
replica, and the example home page from the TanStack collections, and asserts they agree. It also
reads every shared view's records from both sources, for each kind of run selection, and asserts
they are equal.

## Measurements (Upload)

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
  so workers of two tabs opening at once can still race. The dashboard's Overview opens only the
  Automations replica. The replica retries its open; the TanStack database does not. wa-sqlite 2.x
  ignores the `NotFoundError` there, but `@tanstack/browser-db-sqlite-persistence` (0.2.37) accepts
  only `^1.4.1`; backporting that change as a pnpm patch of 1.7.2 would fix both.
- **Returning visits show older data without saying so.** A replica that caught up before opens at
  once and replays what changed since in the background, with no indicator.
- **Failures show as text.** The download and the Files views show the writing tab's last error
  while it retries.
- **OPFS files accumulate:** one database per visited scope, and a new one whenever the adapter
  identity or the schema version changes. Nothing deletes old ones.
- **Two streams and two workers per Files tab:** the Upload replica and the Automations TanStack
  collections, each with its own `GET /_internal`, outbox stream, OPFS database, and worker.
- **Pages that mix both follow the Automations outbox twice.** Leaving the Overview for Events,
  Files, Integrations, pages, or Marketplace opens the TanStack collections next to the replica that
  stays open in the tab, each with its own stream, database, and worker.
- **The project menu refreshes on navigation, not live.** It lists projects as of the last time the
  layout's loader ran, which actions such as creating a project rerun; a project an agent creates
  shows after the next navigation. Once every page reads the Automations replica, pages outside a
  project scope already hold the scope's `project` table, so the menu can read it there and follow
  it live. Project scopes list their owner's projects, which only the owner's replica holds, so they
  would keep the server query rather than download the owner's history for the menu.
- **The Automations download is the whole history.** A first visit replays every entry of the
  scope's outbox, as the TanStack collections do. In the production fixture of Oct 23 that is 16,104
  entries and 316 MB, 91% of it the bodies of GitHub `webhook.received` events stored before
  Backoffice stopped storing them. Stripping those from the outbox is planned separately.
- **Projection changes need a schema change.** The replica's database is named by the registered
  schemas' versions, not by the projections' code, so rows a changed projection would write
  differently stay until `automation_views` gets a new operation, such as `.noOp(...)`, which opens
  a new database that replays the outbox.
- **The projections assume folded events are never deleted.** If `admin.events.delete` ever allows
  `pi` or `integrations` events, a replica would keep what deleted events did, and one that
  downloads the outbox afterwards would not, since their history goes too.
- **Ties may break differently.** Of two changes to a connection in the same millisecond, the
  projection keeps the first it applies, in outbox order; the TanStack collection keeps whichever
  its stable sort puts first.
- **Every applied entry re-reads every open view,** the overview's seven queries, the graph's three,
  and an opened run's four, because `subscribe` does not say which tables changed. Waiting runs come
  with all their steps, events, and emissions.
- **One read is not a snapshot.** The overview's queries run one after another, so an entry the
  writing tab applies between two of them shows in the later one only. The next notification reads
  again.
