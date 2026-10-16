# Production latency: Durable Object cold activations dominate slow requests

Status: open

Created: October 16, 2026

Source: Cloudflare Workers Observability (traces + invocation logs), 2026-10-09 → 2026-10-16,
workers `rejot-backoffice-web` (web) and `rejot-backoffice` (objects). Head sampling is 1.0 for logs
and traces. Volumes reported by the observability API come in multiples of 10; read them as
relative.

Out of scope: the integrations loader (`getAdminConfig` / `ensureAdminConfig` chains), which is
being fixed separately.

## Summary

User-visible slowness is almost entirely **time spent waiting for an evicted Durable Object to come
back**, not query or handler work. On every slow request examined, one or more web → DO hops show a
**0.7–1.8 s gap** between the web worker issuing the call and the DO handler starting. The DO
handler then finishes in 0–5 ms. Warm hops take 5–40 ms.

Backoffice has low traffic and one DO per fragment per scope, so most page loads touch at least one
DO that has been evicted. Each page also puts several DO hops on its critical path. The fixes that
matter are:

1. Make DO activation cheaper (bundle size, top-level evaluation, constructor work).
2. Remove DO hops from the critical path of every page.
3. Don't let one cold DO block a whole page.

## Evidence

### Slowest user-facing routes (web worker, wall time)

Streams (`*/outbox/stream`, `*/view-stream`) are excluded because they are long-lived by design.

| Route                                                 | p50     | p95   | max  | CPU p50/p95   |
| ----------------------------------------------------- | ------- | ----- | ---- | ------------- |
| `GET /backoffice/dashboard/org/:org` (document)       | 6084 ms | 6084  | 6084 | 87 / 87       |
| `GET /backoffice` (document)                          | 848     | 2497  | 2497 | 15 / 18       |
| `GET /backoffice/dashboard/org/:org.data`             | 1712    | 2015  | 2015 | 56 / 127      |
| `GET /backoffice/sessions/.../sessions.data`          | 75–1085 | ≤1938 | 6918 | 7–20 / ≤31    |
| `POST /api/github/webhooks`                           | 221     | 1868  | 2292 | 17 / 41       |
| `POST /api/auth/backoffice-token`                     | **783** | 1257  | 1467 | 13 / 46       |
| `GET /backoffice/sessions/org/:org/sessions/:id.data` | 358     | 672   | 1322 | **102 / 239** |

Across all web → DO `fetch` spans (non-stream): p50 46 ms, p75 133 ms, p90 237 ms, **p95 618 ms**.
About 5% exceed 500 ms.

### Representative traces: gap = web call start → DO handler start

| Trace (route)                  | Hop                                      | Gap                    | DO handler |
| ------------------------------ | ---------------------------------------- | ---------------------- | ---------- |
| `backoffice-token` `8e48f9e3…` | Auth `POST /api/auth/backoffice-token`   | 1190 ms                | 4 ms       |
| `backoffice-token` `cabf317a…` | same                                     | 1091 ms                | —          |
| session detail `b454a623…`     | Auth `getBackofficeMe` (middleware)      | 935 ms                 | 0 ms       |
| `/backoffice` `5dd2d637…`      | Automations `/_internal` (layout loader) | 746 ms                 | 1 ms       |
| dashboard `.data` `430c708e…`  | Automations `/_internal`                 | 860 ms                 | 1 ms       |
|                                | PiManager `/sessions`                    | 1294 ms                | 2 ms       |
|                                | Api `/connections`                       | 798 ms                 | 1 ms       |
| dashboard `.data` `2db59fc8…`  | PiManager `/sessions`                    | 1618 ms                | —          |
| sessions list `712590eb…`      | PiManager `/sessions` + `/models`        | 1805 ms                | 1 ms       |
| GitHub webhook `01ea339d…`     | GitHubWebhookRouter, then GitHub DO      | 868 + ~820 ms (serial) | 24 ms      |

Dashboard document `bb73c022…` (6031 ms): the dashboard loader makes about 10 DO hops, partly in
sequence. Most are cold: 733, 1288, 1091, 698 (+787), 718, 1075, 660 ms.

Inside DOs, storage and Fragno DB spans report 0 ms. The Workers clock only advances on I/O, so DO
CPU work never shows up as span duration. It does show up in the gaps above.

PiManager is consistently the slowest to activate (1.3–1.8 s). Automations, Auth, Api, and GitHub
take 0.7–1.2 s. All classes share one script, so the difference points to per-class constructor and
initialization work on top of the shared isolate startup.

### Object worker bundle and startup

Measured locally with `wrangler check startup` on `dist/rejot_backoffice` (recipe below):

- Bundle **15.6 MB raw / 3.0 MB gzip**. The entry `index.js` alone is 8.7 MB.
- Local startup: **208 ms active CPU** (26 ms GC). Cloudflare's production CPUs are slower than a
  laptop.
- Self time by chunk: `zod` **91 ms**, `tool-context` 27 ms, `execute` 17 ms (56 ms including
  callees), `index.js` 17 ms. The zod time is top-level schema construction called from
  `execute-*.js` (34 ms) and `index.js` (26 ms).
- Everything below is evaluated on **every** activation of **any** of the 23 DO classes:
  - `cloudflare@7.0.0` SDK: ~990 modules (only the Cloudflare fragment needs it).
  - **Two typebox versions** (1.1.38: 527 modules, 1.3.27: 493 modules).
  - **Two zod versions** (4.6.7 and 4.5.4, the second via `better-call` and `@json-render/core`).
  - `@mixmark-io/domino` (a DOM implementation), `diff`, `minimatch`, and `@cfworker/json-schema` in
    the codemode `execute` chunk.
  - better-auth + oauth-provider, jose, react-email, postal-mime, yaml, pi-ai / pi-durable.

The web worker (`build/server`) is 13.6 MB / 2.9 MB gzip with ~109 ms active startup locally.

This data doesn't show how the 0.7–1.8 s splits between isolate startup, constructor and
`blockConcurrencyWhile` initialization, and DO placement/storage open. See "Verify" below.

### Constructor work on every activation

- `workers/auth.do.ts`: the constructor's `blockConcurrencyWhile` builds a Better Auth instance and
  runs `initializeBackofficeCodemodeOAuthClient(auth)` on every activation, not only when the schema
  version changes. Auth is a singleton on the critical path of every authenticated page
  (`getBackofficeMe`) and of `backoffice-token` (Auth DO CPU p50 61 ms, p95 132 ms).
- Fragment-hosting DOs run `fragno.fragment_runtime.create` + `fragno.fragment.migrate`
  (schema-version reads, `settings.getOrCreate`, `hooks.getNextWakeAt` per fragment) on activation.
  These are cheap in I/O but add CPU to every cold hop.

### Critical-path hops on every page

- **Middleware**: `establishBackofficeAuthenticatedRequest` → Auth singleton `getBackofficeMe`, in
  series before any loader. A cold Auth adds ~1 s to whatever page triggers it.
- **Layout loader** (`app/layouts/backoffice-layout.tsx`): awaits `fetchAutomationCollectionSource`
  (Automations `GET /_internal`, the TanStack DB sync descriptor) before rendering anything. On the
  `/backoffice` trace this alone took 2459 ms (746 ms cold gap). Project scopes await a second one
  for the org.
- **Dashboard loader**: about 10 hops across Automations, PiManager, Api, Mcp, Auth, and GitHub.
  Some run in sequence, and the slowest cold one gates the whole response.

### GitHub webhooks

`POST /api/github/webhooks` goes web → GitHubWebhookRouter DO → GitHub DO in sequence before
returning. When both DOs are cold, that's two activations (~0.87 s + ~0.82 s) before the
acknowledgement. GitHub times out deliveries after 10 s, so there's headroom, but this is avoidable
latency on every quiet-period delivery.

### Lingering DO events (not user-facing; cost and metrics)

Several DO events stay open long after the caller received its response:

| Event                                        | Caller saw | DO event lasted                                 |
| -------------------------------------------- | ---------- | ----------------------------------------------- |
| PiManager `GET /view` → Pi `getView` (jsrpc) | 68 ms      | ~12 s                                           |
| Automations `GET /api/automations/_internal` | 28 ms      | ~11 s (max 28 s)                                |
| Dashboard DO `GET` (`196b201e…`)             | 35 ms      | 60 s                                            |
| GitHub DO alarm (`processWebhook` hook)      | RPC 52 ms  | alarm 80–85 s; outgoing DO subrequest open 21 s |

GitHub alarm: p50 1.1 s, **p95 82 s**. `fragno.durable_hook.attempt` spans are p95 319 ms, max 1.7
s. Pi `jsrpc` p95 10.9 s, PiManager `fetch` p95 10.5 s.

`Pi.getView` returns plain data and `commands` is the raw DO stub, so leaked `RpcTarget` stubs don't
explain the Pi case. Per Cloudflare's RPC lifecycle docs, a callee's context ends when the call
returns unless stubs or functions crossed the boundary, or I/O is still pending. Candidates:

- background work left running after the response (harness `root()` / `viewState`, durable-hook
  processing kicked off by a request);
- response bodies not consumed by the caller (`/_internal`);
- DO stubs kept alive across the alarm.

Impact: DOs stay active (billed duration, no eviction), DO p95 metrics are polluted, and if alarm
events are what's lingering, the next durable-hook alarm may be delayed. This would add latency
between a GitHub event and the automation it triggers. Not confirmed.

### Session detail page CPU

`GET .../sessions/:id.data` is the highest-volume page route. It has the highest web CPU: p50 102
ms, p95 239 ms. Its loaders fetch `/entries?pageSize=100`, the session, the full `/view`, `/models`,
`/sessions?pageSize=100`, and Automations `/_internal` on every navigation. That's six subrequests,
two of them potentially large payloads that are parsed and re-serialized in the web worker.

That route became the agent page (`routes/backoffice/agents/agent-detail.tsx`) after the deploy
measured here. Addressed since: the agent page has no loader. It reads the agent from the agents
directory and renders the conversation from the `view-stream` snapshot. History before the active
context loads only on "Load older", bounded by the compaction's head marker. Sending, aborting, and
compacting no longer reload the agents layouts. Not yet measured in production.

### Scanner noise (low)

A steady stream of `.env` / credentials / `/@fs/` probes hits the web worker. Each costs 3–10 ms and
returns 404. A WAF custom rule could drop them before they reach the worker. Not a latency issue.

## Opportunities (in priority order)

1. **Shrink what every DO activation evaluates.**
   - Lazy-load class-specific heavy dependencies with `import()` inside the DO or fragment that
     needs them: the Cloudflare SDK (Cloudflare DO), the codemode `execute` chunk + domino (Codemode
     / Pi), react-email + postal-mime (Resend / Auth email paths), and the pi-ai providers.
   - ~~Deduplicate typebox (1.1.38 vs 1.3.27) and zod (4.6.7 vs 4.5.4).~~ Done: one typebox (1.3.27)
     and one zod (4.6.7) via `pnpm-workspace.yaml` overrides. Object bundle 15.8 → 15.3 MB raw, 3.13
     → 3.04 MB gzip, `index.js` 8.98 → 8.43 MB. Local `wrangler check startup` did not move
     measurably (~115 ms active both before and after, same machine), so the duplicate copies were
     mostly not evaluated at startup.
   - ~~Find the large module-level zod schemas evaluated at startup (backoffice-api contracts and
     runtime-tool definitions in `execute-*.js`, `index.js`) and build them on first use.~~ Done:
     integration action definitions convert to JSON Schema on first listing, and every
     backoffice-api module-level schema is lazy. Local `wrangler check startup` went from ~105–119
     ms to ~86–90 ms active. Zod is still ~30 ms of startup, now spread across fragment contracts,
     app modules, and third-party packages (MCP SDK protocol schemas, better-auth). Non-zod
     top-level work worth deferring next: turndown (~13 ms in Node) and `systemFileCollection` (~5
     ms).
   - If that's not enough, split the object worker into several scripts (for example Pi / PiManager
     / Codemode / Sandbox vs Auth / Automations / Upload / integrations) so each activation loads
     only its own graph.
   - Track `wrangler check startup` for the object bundle as a budget.
2. **Do less in constructors.** Move `initializeBackofficeCodemodeOAuthClient` into the
   schema-migration branch (or a deploy-time step) so a cold Auth DO doesn't rebuild it. Audit
   `blockConcurrencyWhile` initializers in PiManager (slowest activation) and Automations.
3. **Take DO hops off every page's critical path.**
   - Answer `getBackofficeMe` from verified token claims plus a short isolate-local cache instead of
     calling the Auth singleton on every request. JWKS is already fetched for local verification.
   - Don't await `fetchAutomationCollectionSource` in the layout loader. Return it as a promise for
     the client to resolve, or let the browser fetch the sync descriptor itself.
4. **Don't let one cold DO gate a page.** Run independent dashboard loads in parallel, and stream
   non-critical sections (return promises, render with `<Await>`) so a cold PiManager doesn't hold
   the 6 s document.
5. **Acknowledge GitHub webhooks after one hop.** Persist in the router and forward to the GitHub DO
   through a durable hook, instead of waiting on both DOs before responding.
6. **Investigate lingering DO events** (Pi `getView`, Automations `/_internal`, GitHub alarms):
   check for pending background I/O after the response, unconsumed response bodies on the web side,
   and stubs held across the alarm. Then check the end-to-end delay from GitHub delivery to
   automation run.
7. ~~**Profile session-detail CPU.**~~ The agent page no longer loads the view or history on the
   server (see above). Re-measure after the next deploy.

## Verify

- Split the cold gap: record a timestamp at DO constructor entry and after each
  `blockConcurrencyWhile` initializer resolves (log or span attribute). Compare against the request
  span start. Record the "Worker Startup Time" that `wrangler deploy` prints for the object worker
  on each deploy.
- After changes, re-run the queries below and compare: web → DO `fetch` p95 (618 ms today),
  `backoffice-token` p50 (783 ms), dashboard `.data` p50 (1712 ms), and the cold gaps in the trace
  table.

## Query recipes (Observability MCP)

- The `events` view returns only `$metadata` (no span attributes). The `invocations` view fails on
  events without `requestId`. Use `calculations` grouped by `$metadata.traceId`, `spanId`,
  `parentSpanId`, `name` with `max(durationMS)` and `min(startTime)` to rebuild a trace. Join
  `url.path` and `jsrpc.method` with a second query grouped by `spanId`.
- Use `median`; there is no `p50` operator.
- Find slow traces with filter `$metadata.type = cf-worker-event` plus `$metadata.trigger`, grouped
  by `$metadata.traceId` with `max($workers.wallTimeMs)`.
- Startup profile of the object worker: copy `dist/rejot_backoffice` outside the repo (the
  `.wrangler/deploy/config.json` redirect otherwise selects the web worker) and remove `containers`
  from its `wrangler.json` (the Dockerfile path doesn't resolve). Then run
  `wrangler check startup -c wrangler.json --outfile objects.cpuprofile`.
