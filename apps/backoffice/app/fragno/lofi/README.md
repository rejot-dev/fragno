# Backoffice SQLite replica

Lofi's browser SQLite replica (`@fragno-dev/lofi/sqlite`) mirrors two of a scope's backends:

- **Upload** (`/api/upload-scoped/<scope>`, schema `upload`, whose outbox carries only the `file`
  table), in `../upload/lofi`. It replaced the TanStack collection there.
- **Automations** (`/api/automations-scoped/<scope>`, schemas `automations` and `workflows`), in
  `../automation/lofi`, for the dashboard's Overview and Events tabs. The same outbox also feeds the
  TanStack DB collections in `../automation/tanstack`, which every other Automations view still
  reads, including the Files explorer's workflow routes.

Each tab starts a replica worker per backend (`../upload/lofi/replica.worker.ts`,
`../automation/lofi/replica.worker.ts`), which serves the replica with
`@fragno-dev/lofi/sqlite/worker`. The workers of a scope's tabs elect a leader, which opens the
replica and keeps every tab's views up to date as outbox entries arrive; the other tabs' workers
relay to it. The leader synchronizes with `backofficeFetch`, so an expired token refreshes there
too. A worker starts with only its name, so the page names it after the backend's URL. Pages connect
with `@fragno-dev/lofi/sqlite` and read live views:

- Upload's are ZQL views (`@fragno-dev/lofi-zql`), which the leader updates incrementally.
- Automations' are read views: named functions in `../automation/lofi/replica-host.ts` that the
  leader runs again after every batch, with the database locked, so all of a read's queries see one
  state. It sends a view's result only when it changed.

Shared pieces in this directory:

- `browser-replica.ts`: `getWorkerReplica`, one connection to a replica worker per backend instance
  and tab, cached so Suspense sees one promise, which resolves once a tab has opened the replica.
- `replica-gate.tsx`: `LofiReplicaGate` shows the download, with its percentage, until the replica
  has caught up, and only then the view. The download panel is the design system's
  `BackofficeDownloadState`. A replica that caught up in an earlier session opens caught up, so the
  download shows on a browser's first visit, or after a new backend instance or schema version opens
  a new database.
- `use-lofi-view.ts`: `useLofiView`, a replica worker's view's live result in a component, or
  loading without a view.
- `scenario-replica-database.ts`: the scenario harness's replicas (`ctx.lofi.automations`,
  `ctx.lofi.upload`), each served as its worker serves it, with a `MessageChannel` in place of the
  worker, on wa-sqlite's in-memory VFS.

## What reads the Upload replica

The Files explorer's workspace tree (`routes/backoffice/files/explorer.tsx`) and the Upload file
manager (`routes/backoffice/connections/upload/files.tsx`), through `useReadyUploadFiles`: a view of
the `file` rows whose status is `ready`, of one provider or of all. Both build their tree from the
whole list whenever it changes. `upload/lofi/replica.scenario.test.ts` uploads, deletes, and lists
files through the view. The explorer no longer previews pages, which render over the Automations
TanStack collections; it links to them instead.

## What reads the Automations replica

The dashboard's Overview and Events tabs, which open no TanStack database. Each view is one of
`automationReads` (`../automation/lofi/replica-host.ts`), which a component opens with
`useAutomationRead` (`../automation/lofi/replica.ts`). Overview
(`routes/backoffice/dashboard/dashboard.tsx`):

- The overview, through `readDashboardOverview` in `overview-replica.ts`: workflow health, failing
  and waiting runs, event volume, scheduled routes, connections, and agents.
  `projectBackofficeDashboard` turns what it reads into the page, as it did with the TanStack
  queries.
- The orchestration graph, through `readOrchestrationRecords` (`../automation/lofi/reads.ts`): the
  scope's own event sources and definitions, and its unfinished runs. Its inspector reads an event
  type's latest events with `readLatestEventsOfType`, and a workflow's running Codemode runs.
- An opened run's timeline, and a page's form for a waiting run, through `readWorkflowRuns`
  (`../automation/lofi/reads.ts`), which selects runs as `workflowRunRecordsQuery` does: waiting
  runs, running Codemode runs, or one run by workflow and instance. A run's waits are derived from
  its steps with `currentWorkflowWaits`.

Events (`routes/backoffice/dashboard/events.tsx`), through `event-traces-replica.ts`:
`readEventTraceSummaries` reads the newest 100 origin events with the events they caused, their
route dispatches, and the runs those started or sent events to, and summarizes them with
`projectEventTraceSummaries` in the worker, so the origins' payloads, which the list needs only for
headlines, do not cross to the page. `readEventTrace` reads one origin's events, dispatches, runs,
and those runs' steps and workflow events, which `projectEventTrace` turns into the trace on the
page. Both project as they did from every synchronized row.

The Files explorer (`routes/backoffice/files/explorer.tsx`) reads the routes that start each
workflow file with `readAutomationRoutes`, the overview's read of the routes, and shows them as
loading until the replica first catches up, so a download in progress does not mark a workflow as
started by nothing.

A Marketplace package's install panel
(`routes/backoffice/marketplace/installation-workflow.client.tsx`) follows its ingestion run and the
Codemode installer run it starts with `readWorkflowRuns`, one run by workflow and instance each.

Agents (`routes/backoffice/agents/`) and the agent drawer read the scope's agents, with the turns
each ended per hour of the last day, through `readPiAgentDirectory` (`agents-replica.ts`), over the
`pi_agent` and `pi_agent_turn` projections. An agent's conversation stays on the pi-manager stream;
it reads from the replica only which of the Codemode runs it started have recorded a step
(`readStartedCodemodeRuns`), to open them in its workspace, and the opened run (`readWorkflowRuns`).
These render before the replica opens, so they take it from `useCurrentAutomationReplica` instead of
suspending, and show the directory as loading until the replica first catches up.

The project menu in the top bar reads no synchronized data: the layout's loader lists the owner's
projects through the Automations object's `GET /projects` (`../automation/project-list.server.ts`)
and streams them to the menu, so no page opens a database for it.

Those run views are shared with pages that still read the TanStack collections: pages and the
Automations script view. They take an `AutomationReadSource` (`../automation/read-source.ts`) naming
the replica or the collections, so each page passes the source it already holds and none opens a
second copy of the scope's history for them.

What Backoffice derives from events, rather than reads off a table, is kept by local projections
(`../automation/lofi/views.ts`) in the local schema `automation_views`. They run in the leading
tab's worker, in the same transaction as each outbox entry, and fold each new event with the
functions the TanStack collections derive the same rows with:

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

The tests read the replica through its views, as pages do, with `readAutomationReplica`
(`../automation/lofi/testing.ts`). `dashboard/overview.scenario.test.ts` reads the overview and the
orchestration graph from the replica, and the example home page from the TanStack collections, and
asserts they agree. It also reads every shared view's records from both sources, for each kind of
run selection, and asserts they are equal. `automation/scenario-starter-router.test.ts` and
`automation/scenario-event-causation.bridge.scenario.test.ts` (run by `pnpm test:bridge`) build
traces and the trace list from the replica and from every TanStack row, and assert they are equal.
The TanStack trace queries in `event-traces.ts` remain only as that reference.

## Measurements (Upload)

These were taken while the replica still ran on the page, reaching TanStack DB's database worker
through one message per call. In its own worker, its statements run without a round trip.

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

## Measurements (Automations)

What the leader pays to run a read view, which it does for every open view after every batch,
replaying the production fixture of Oct 23 (16,104 entries) into wa-sqlite's in-memory VFS in Node,
in the median of 5 runs after catch-up:

| Read                    | Time   | Result |
| ----------------------- | ------ | ------ |
| `dashboardOverview`     | 2.8 ms | 160 KB |
| `eventTraceSummaries`   | 5.0 ms | 21 KB  |
| `orchestrationRecords`  | 0.2 ms | 15 KB  |
| `workflowRuns`, waiting | 0.3 ms | 20 KB  |

Before the list was summarized in the worker, its result was 2.4 MB, 98% of it origins' payloads,
mostly GitHub webhook bodies, and copying it took 3.8 ms each time it was sent. With reads this
cheap, maintaining the list incrementally, with a projection that keeps a summary per origin and a
ZQL view of it, would save the leader about 5 ms per batch while the Events tab is open; the
projection would need a schema change, and so a new download of the whole outbox, whenever its
summary changes.

## Risks and follow-ups

- **The explorer flashes on a first visit.** It renders the server's snapshot of the tree, then the
  download while the Upload replica catches up, then the replica's tree.
- **Workers race at startup.** Each database worker (wa-sqlite 1.7.2's `OPFSCoopSyncVFS`) deletes
  the temporary `.ahp-*` directories closed workers left in OPFS. Two workers that list the
  directory at the same time both try to delete the same one, and the second fails its open with
  `NotFoundError`; three workers running that loop against three leftover directories failed in 14
  of 30 trials. While the Automations replica opened next to the TanStack DB database, both started
  after the same `GET /_internal`, and 3 of 12 reloads showed the route's error page. Replica
  workers retry their open; the TanStack database does not. The dashboard, Files, Marketplace, and
  Agents open only replica workers, the Upload and the Automations replica's on Files: 12 of 12
  reloads of a workflow file showed its tree and its routes. Integrations and pages still open the
  TanStack database, and tabs share OPFS, so workers of two tabs opening at once can still fail
  there. wa-sqlite 2.x ignores the `NotFoundError`, but `@tanstack/browser-db-sqlite-persistence`
  (0.2.37) accepts only `^1.4.1`; backporting that change as a pnpm patch of 1.7.2 would fix it.
- **Returning visits show older data without saying so.** A replica that caught up before opens at
  once and replays what changed since in the background, with no indicator.
- **Failures show as text.** The download and the Files views show the leading tab's last error
  while it retries.
- **OPFS files accumulate:** one database per visited scope, and a new one whenever the adapter
  identity or the schema version changes. Nothing deletes old ones.
- **Whole results cross to the page.** The worker posts a view's full result whenever it changes:
  the Files tree's whole list when a file changes, and the whole overview, waiting runs with all
  their steps included, when anything in it changes. Sending the changes would let pages update in
  place.
- **A frozen leader stalls every tab's Files and dashboard views.** See the risks of the replica
  worker in lofi's README.
- **The worker path has no automated browser test.** The scenario tests run the same hosts in Node.
  It was checked by hand in Chrome: the Files explorer, and the dashboard's Overview and Events in
  two tabs, where an event fired showed in both within about 110 ms, and after the leading tab
  closed, the other took the lead and showed the next event within about 300 ms.
- **Two streams and two databases on Files:** the Upload and the Automations replica, each with its
  own `GET /_internal`, outbox stream, OPFS database, and worker, since they follow two backends.
- **Pages that mix both follow the Automations outbox twice.** Leaving the dashboard, Files, or
  Agents for Integrations or pages opens the TanStack collections next to the replica that stays
  open in the tab, each with its own stream, database, and worker.
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
  its stable sort puts first. Origins that occurred in the same millisecond list newest ID first,
  where TanStack listed them in collection order.
- **Every batch reruns every open read view,** in the leader, for every tab: the overview's ten
  queries, the graph's three, an opened run's four, and on Events the list's four and the trace's up
  to five, because the leader does not know which tables a batch changed. Waiting runs come with all
  their steps, events, and emissions. The leader then compares each result with the last it sent. On
  the production fixture that is under 10 ms per batch; see the measurements. The list still reads
  its origins' payloads to summarize them, and the overview's runs and event counts grow with the
  scope's history.
