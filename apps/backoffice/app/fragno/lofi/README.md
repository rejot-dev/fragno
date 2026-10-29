# Backoffice SQLite replica

Lofi's browser SQLite replica (`@fragno-dev/lofi/sqlite`) mirrors two of a scope's backends, and
every view of their data reads it; Backoffice no longer uses TanStack DB:

- **Upload** (`/api/upload-scoped/<scope>`, schema `upload`, whose outbox carries only the `file`
  table), in `../upload/lofi`.
- **Automations** (`/api/automations-scoped/<scope>`, schemas `automations` and `workflows`), in
  `../automation/lofi`: the dashboard, user pages, Agents, Integrations, the Files explorer's
  workflow routes, Marketplace installs, and the Automations script view. The layout's loader
  describes the scope's backend (`../automation/lofi/replica-source.server.ts`), whose identity
  names the replica.

Each tab starts a replica worker per backend (`../upload/lofi/replica.worker.ts`,
`../automation/lofi/replica.worker.ts`), which serves the replica with
`@fragno-dev/lofi/sqlite/worker`. The workers of a scope's tabs elect a leader, which opens the
replica and keeps every tab's views up to date as outbox entries arrive; the other tabs' workers
relay to it. The leader synchronizes with `backofficeFetch`, so an expired token refreshes there
too. A worker starts with only its name, so the page names it after the backend's URL and the
identity its server last reported (`worker-replica-target.ts`): a tab loaded after the backend was
replaced does not join an older tab's leader, and its replica fails to open if the backend changed
again since its server looked. Pages connect with `@fragno-dev/lofi/sqlite` and read live views:

- Backoffice's own views are read views: named functions in `../upload/lofi/replica-host.ts` and
  `../automation/lofi/replica-host.ts` that the leader runs again after a batch that wrote a table
  their last run read, with the database locked, so all of a read's queries see one state. It sends
  a view's result only when it changed. What reads derive from events, projections keep, so reads
  mostly look rows up.
- User pages' are guarded SQL views (`../automation/lofi/page-relations.ts`); see Pages below.

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
manager (`routes/backoffice/connections/upload/files.tsx`), through `useReadyUploadFiles`: a read of
the `file` rows whose status is `ready`, of one provider or of all. Both build their tree from the
whole list whenever it changes. `upload/lofi/replica.scenario.test.ts` uploads, deletes, and lists
files through the view. The explorer does not preview pages; it links to their route.

## What reads the Automations replica

The dashboard's Overview, Activity, and Map tabs. Each view is one of `automationReads`
(`../automation/lofi/replica-host.ts`), which a component opens with `useAutomationRead`
(`../automation/lofi/replica.ts`). Overview (`routes/backoffice/dashboard/dashboard.tsx`):

- The overview, through `readDashboardOverview` in `overview-replica.ts`: failing and waiting runs,
  scheduled routes, connections, and agents. `projectBackofficeDashboard` turns what it reads into
  the page.
- Its recent activity, through `readEventTraceSummaries`, as Activity reads it below.
- An opened run's timeline, a page's form for a waiting run, and the Automations script view's runs,
  through `readWorkflowRuns` (`../automation/lofi/reads.ts`): waiting runs, running Codemode runs,
  or one run by workflow and instance. A run's waits are derived from its steps with
  `currentWorkflowWaits` (`../automation/workflow-waits.ts`).

Activity (`routes/backoffice/dashboard/activity.tsx`), through `event-traces-replica.ts`:
`readEventTraceSummaries` reads the newest 100 origin events with the events they caused, their
route dispatches, and the runs those started or sent events to, and summarizes them with
`projectEventTraceSummaries` in the worker, so the origins' payloads, which the list needs only for
headlines, do not cross to the page. `readEventTrace` reads one origin's events, dispatches, runs,
and those runs' steps and workflow events, which `projectEventTrace` turns into the trace on the
page.

Map (`routes/backoffice/dashboard/map.tsx`) draws the orchestration graph, through
`readOrchestrationGraphInputs` and `readOrchestrationRecords` (`../automation/lofi/reads.ts`): the
scope's routes and last day of events, its own event sources and definitions, and its unfinished
runs. Its inspector reads an event type's latest events with `readLatestEventsOfType`, and a
workflow's running Codemode runs.

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

Integrations (`routes/backoffice/integrations/`) lists every connection, disconnected ones too, from
the `integration_connection` projection, and filters them on the page, so showing disconnected
connections opens no new read. A connection's state history reads the
`integration_connection_change` projection by connection ID. A webhook endpoint's recent deliveries
are its latest `api/webhook.received` events and those routes reclassified under the endpoint ID
(`integrations-replica.ts`), narrowed by the subject's endpoint with `json_extract`. They stay a
read of events, not a projection: `webhook.received` events can be deleted, and a deletion reaches
the replica as a truncate notification, which projections do not see.

The project menu in the top bar reads no synchronized data: the layout's loader lists the owner's
projects through the Automations object's `GET /projects` (`../automation/project-list.server.ts`)
and streams them to the menu, so no page opens a database for it.

Views shared between routes take the `LofiSqliteClient` of the replica their route opened, so no
route opens a second copy of the scope's history.

What Backoffice derives from events, rather than reads off a table, is kept by local projections
(`../automation/lofi/views.ts`) in the local schema `automation_views`. They run in the leading
tab's worker, in the same transaction as each outbox entry, and fold each new event with
Backoffice's own functions:

- `pi_agent`, `pi_agent_request`, and `pi_agent_turn`, by `applyPiAgentEvent` and
  `piAgentTurnEndedBy` (`../pi/agent/pi-agent-records.ts`). An agent's counts of running, queued,
  and steering requests change by what each event did to its request, so a request's row keeps what
  its earlier events recorded.
- `integration_connection`, by `applyIntegrationConnectionChange`
  (`../runtime-tools/families/integrations/integration-connections.ts`), and
  `integration_connection_change`, every change that led there.

Both readers (`readPiAgentEvent`, `readIntegrationConnectionStateChange`) validate each event once,
when it arrives. Folding events as they arrive relies on nothing deleting them: `deleteEventsOfType`
(`../automation/events-storage-runtime.ts`), which `admin.events.delete` calls, refuses `pi` and
`integrations` events, so the projections never see one go.

Both projections are rebuildable: they list the tables they write and replay the stored
`automation_event` rows, so `automation_views` does not name the replica's database. Changing one of
their tables, or bumping a projection's `rebuild.version` when it folds the same events differently,
rebuilds the projection from the events the browser already holds, in the order the outbox delivered
them, instead of downloading the history again. On the production fixture of Oct 23 (11,970 events),
rebuilding both took 1.6 s in Node and gave exactly the rows the stream built. The agents and
Integrations scenario tests check the same with `assertAutomationProjectionsRebuild`, which rebuilds
the scope's replica on a second connection and compares. Workflow waits are not projected: they
follow from runs and steps, which change, so the overview derives them from the waiting runs it
reads anyway, and pages from a derived relation (see Pages).

## Pages

A user page (`/workspace/**/<name>.page.js`, built by `../../artifacts/pages/build.server.ts`) holds
SQL queries, each one SELECT over the relations `../automation/lofi/page-relations.ts` gives pages,
with the columns its rows show. The route (`routes/backoffice/pages/page.tsx`) waits for the scope's
replica to catch up, then `../../artifacts/pages/view.tsx` opens each query as a guarded SQL view of
the replica worker; a query whose times move with `now` opens a new view each minute.
`@fragno-private/backoffice-ui/pages` decodes rows by their declared columns and binds them to the
page's interface.

- **Relations.** Temporary views on the leader's connection give pages the synchronized tables under
  short names, such as `runs`, `steps`, and `events`, with `id` the row's id, references as the
  referenced row's id (`steps.runId`), and `position` the replica's internal id, which orders rows
  as the backend created them; its other bookkeeping columns are left out. A run's steps from one
  tick share their `createdAt` and order by `position`. `connections` and `agent_turns` are views of
  the projections. `agents` and `workflow_waits` are derived in the worker with `readPiAgents` and
  `currentWorkflowWaits`, the functions the dashboard uses, so a page repeats none of their logic;
  they are computed again only after a batch wrote what they read. `page-schema.d.ts`, which agents
  read, is generated from the same list.
- **Guard.** A page's query only reads: it cannot write, begin or end transactions, attach
  databases, or set a pragma, and stops at 125 million operations, about a second, as the build's
  check does. A failed or interrupted write could end the leader's read transaction, which lofi's
  README explains. A page's query that cannot run shows its error in place of the page. Pages could
  read the replica's own tables, which hold nothing the page cannot already read; `page-schema.d.ts`
  describes only the relations, so pages use those.
- **Build.** The build asks the scope's Automations object to run each query once on an empty
  database with the replica's tables and the same relations, as permanent views and tables
  (`AUTOMATION_PAGE_DATABASE_SCHEMA` in `../automation/lofi/page-relations.ts`), and fails with the
  query's error, such as a misspelled column, or a declared column the query does not select
  (`../../artifacts/pages/page-queries.server.ts`). On Cloudflare the database is a facet of the
  object whose class is loaded as a Dynamic Worker (`workers/lib/facet-sql-query-checker.ts`), with
  a CPU limit of a second per query; each query creates the tables and views, runs, and rolls all of
  it back, so the facet stays empty. The object keeps the facet, and the loader the Dynamic Worker,
  while they run, so later builds reuse them until Cloudflare evicts them. Node runs each query on
  its own `node:sqlite` in-memory database. The build refuses nothing of its own: only what workerd
  or `node:sqlite` refuses fails it. Opening a built page reads the cached build and runs no check;
  a cached build is checked again when its source or the relations change.
- **Older pages.** Pages written for version 4, which queried TanStack DB's collections, fail their
  build with a message that says to rewrite their queries in SQL.

On the production fixture of Oct 23, the example home page's eleven queries take 12 ms together the
first time, deriving `agents` and `workflow_waits` included, and 4 ms after, in Node.

## Tests

The tests read the replica through its views, as pages do: `readAutomationReplica` reads one of
`automationReads`, `readAutomationPageQuery` a page's query, and `queryAutomationReplica` any SQL
over the page relations (`../automation/lofi/testing.ts`). `dashboard/overview.scenario.test.ts`
builds the example home page as its route does, reads it from the replica, and asserts it shows what
the dashboard shows; it also states what each view beside the dashboard reads.
`artifacts/pages/page.scenario.test.ts` builds pages, including the skill's example, and checks the
errors of SQL that cannot run. `automation/scenario-starter-router.test.ts` and
`automation/scenario-event-causation.bridge.scenario.test.ts` (run by `pnpm test:bridge`) check
traces as the Events tab reads them.

## Measurements (catch-up)

Replaying the recorded outboxes into the replica on wa-sqlite's in-memory VFS in Node, without
projections, in the median of 3 runs: Upload's 6,559 entries (6.9 MB) take 0.25 s, and Automations'
16,104 entries of Oct 23 take 3.4 s. In a replica worker on OPFS, in VS Code's browser, the import
benchmark (`packages-private/lofi-sqlite-import-benchmark`, `?schema=upload`) replays Upload's in
1.5 s after the replica opens, in the median of 9 runs. Sending a transaction's writes in one
statement batch, as the replica did while it ran on the page, made no difference there, and was 12%
slower in Node.

## Measurements (Automations)

What the leader pays to run a read view, which it does for every open view that reads a table a
batch wrote, replaying the production fixture of Oct 23 (16,104 entries) into wa-sqlite's in-memory
VFS in Node, in the median of 5 runs after catch-up:

| Read                    | Time   | Result |
| ----------------------- | ------ | ------ |
| `dashboardOverview`     | 2.8 ms | 160 KB |
| `eventTraceSummaries`   | 5.0 ms | 21 KB  |
| `orchestrationRecords`  | 0.2 ms | 15 KB  |
| `workflowRuns`, waiting | 0.3 ms | 20 KB  |

Before the list was summarized in the worker, its result was 2.4 MB, 98% of it origins' payloads,
mostly GitHub webhook bodies, and copying it took 3.8 ms each time it was sent. With reads this
cheap, maintaining the list incrementally, with a projection that keeps a summary per origin, which
the list reads, would save the leader about 5 ms per batch while the Events tab is open; as a
rebuildable projection, changing its summary would rebuild it from the stored events rather than
download the outbox again.

## Risks and follow-ups

- **The explorer flashes on a first visit.** It renders the server's snapshot of the tree, then the
  download while the Upload replica catches up, then the replica's tree.
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
- **A frozen leader stalls every tab's views,** of Files, the dashboard, pages, Agents, and
  Integrations. See the risks of the replica worker in lofi's README.
- **The worker path has no automated browser test.** The scenario tests run the same hosts in Node.
  It was checked by hand in Chrome: the Files explorer, and the dashboard's Overview and Events in
  two tabs, where an event fired showed in both within about 110 ms, and after the leading tab
  closed, the other took the lead and showed the next event within about 300 ms. A user page showed
  an event fired within about 400 ms.
- **Two streams and two databases on Files:** the Upload and the Automations replica, each with its
  own `GET /_internal`, outbox stream, OPFS database, and worker, since they follow two backends.
- **The project menu refreshes on navigation, not live.** It lists projects as of the last time the
  layout's loader ran, which actions such as creating a project rerun; a project an agent creates
  shows after the next navigation. Pages outside a project scope hold the scope's `project` table in
  the replica, so the menu could read it there and follow it live. Project scopes list their owner's
  projects, which only the owner's replica holds, so they would keep the server query rather than
  download the owner's history for the menu.
- **The Automations download is the whole history.** A first visit replays every entry of the
  scope's outbox. In the production fixture of Oct 23 that is 16,104 entries and 316 MB, 91% of it
  the bodies of GitHub `webhook.received` events stored before Backoffice stopped storing them.
  Stripping those from the outbox is planned separately.
- **A changed projection needs its version bumped.** A changed table rebuilds on its own, but a
  projection that folds the same events into different values, with the same tables, rebuilds only
  when its `rebuild.version` changes. Forgetting the bump keeps the old rows until it happens.
- **Rebuilding blocks the leader.** The rebuild runs in the leader's worker, in one transaction,
  when the replica opens; views wait meanwhile. It decodes every stored event, not just `pi` and
  `integrations` ones, once per stale projection: 1.6 s in Node for both on the production fixture,
  likely more in a browser. A filter on the replayed rows, such as by `source`, would skip the rest,
  but would state again which events each projection folds.
- **The projections assume folded events are never deleted.** If `deleteEventsOfType` ever allows
  `pi` or `integrations` events, a replica would keep what deleted events did, and one that
  downloads the outbox afterwards would not, since their history goes too. A rebuild would then drop
  what the deleted events did, so the same browser could show different agents before and after one.
- **Ties break by outbox order.** Of two changes to a connection in the same millisecond, the
  projection keeps the first it applies. Origins that occurred in the same millisecond list newest
  ID first. A run's steps, events, and emissions with the same `createdAt` order by the replica's
  internal id, which follows the order the backend wrote them in.
- **Busy tables rerun most views.** A batch reruns, in the leader and for every tab, each open view
  that reads a table it wrote. Most batches write `automation_event` or the workflow tables, which
  the overview's ten queries, the graph's three, an opened run's four, the Events list's four and
  trace's up to five, and most page queries read. Waiting runs come with all their steps, events,
  and emissions. On the production fixture the overview's reads are under 10 ms per batch; see the
  measurements. The list still reads its origins' payloads to summarize them, and the overview's
  runs and event counts grow with the scope's history.
- **Pages are only as fast as their SQL.** A query that scans every event to group a few runs takes
  that time after every batch that writes events, up to the 125 million operations its guard allows,
  about a second. The budget is per query, so a page of eleven slow queries can hold the leader for
  about 11 s per batch.
- **The replica has only the backend's indexes,** and pages cannot add any. Filtering `runs` by
  `status`, such as for waiting runs, scans every run, and `events` by `type` alone cannot use the
  index on `source`, `type`, and `occurredAt`. The replica's indexes are not unique, so indexes for
  what pages read could be added to the replica alone.
- **Pages reopen every view each minute.** The page keys its views on all queries' parameters, so
  when the minute moves, every query is prepared and run again, also those that do not read `now`.
  The home page's eleven take about 12 ms on the production fixture. Keying each view on its own
  query would reopen only those whose times moved.
- **Derived relations run for pages that do not read them.** While any page is open, `agents` is
  computed again after every batch that writes agent events, and `workflow_waits`, which reads every
  waiting run with all its steps, after every batch that writes runs or steps, whether or not the
  page reads either. See lofi's README.
- **Pages and the dashboard compute alike things twice.** The home page and the Overview tab read
  much the same, through separate views, and two tabs on one page get two of each.
- **The build and the browser disagree on a few queries.** The build rolls back what a query writes,
  where the browser refuses it, so a query that writes builds and then shows its error in place. The
  browser runs one statement, which a live view needs to know the tables it reads, and the build's
  workerd runs every statement and reports the last, so a query of two statements does the same;
  `node:sqlite` runs only the first. Workerd also refuses most pragmas, which the browser reads, and
  `node:sqlite` runs transaction statements and `ATTACH`, which the browser refuses.
- **The build's CPU limit is unconfirmed.** Whether Cloudflare enforces a Dynamic Worker's `cpuMs`
  on a facet is untested, and local workerd enforces none: locally, a query that never ends, such as
  an unbounded `WITH RECURSIVE`, holds the scope's Automations object until it is restarted. Facets
  are in open beta.
- **Each check creates the schema again.** The facet creates every table and view of the relations
  for each query, and rolls them back, so a page of eleven queries creates them eleven times. On an
  empty database that takes milliseconds; checking a page's queries in one call would create them
  once.
- **Saved version 4 pages stop working.** A page written for the TanStack builder fails until an
  agent rewrites its queries; nothing rewrites them on its own.
