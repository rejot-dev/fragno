# Backoffice local tracing verification report

Date investigated: 2026-08-27

## Summary

The tracing changes are partially successful.

Custom Backoffice and Fragno database spans are exported in local Cloudflare traces, transaction
request sources are attached, cold Automations runtime construction and migrations are visible, and
stream-originated Fragno transaction spans are suppressed. The Files and system Automations pages
both loaded successfully in the browser. Relevant tests and type checks passed.

The verification also found unresolved lifecycle and trace-quality problems:

- Browser outbox coordinators continue streaming after route navigation because successful browser
  database resources have no normal ownership or cleanup path.
- Long-lived outbox streams continue producing automatic Durable Object storage spans at the 100 ms
  polling cadence.
- Before the trace-boundary fix described below, those overlapping storage operations could appear
  beneath an unrelated foreground RPC span.
- The new outbox lifecycle logging emitted `started`, but no `completed` event was observed for the
  streams exercised before the development server stopped.
- Cold Automations initialization spans report `backoffice.object.scope_kind = unknown` because
  persisted runtime initialization runs before RPC `init(scope)` assigns the object's in-memory
  scope.
- The local observability store is 41 GiB and the Local Explorer SQL endpoint was too slow to use.

The trace-context contamination was fixed independently from lifecycle ownership by forwarding the
Automations outbox response through the Durable Object `fetch` boundary instead of returning its
streaming `Response` through an initialized `RpcTarget`. Browser coordinator cleanup remains
necessary to stop unused streams, but it is no longer required to keep their polling spans out of
foreground request traces.

## Verified trace-context isolation fix

The scoped Automations route previously called:

```text
remoteObject.init(scope) -> RpcTarget.fetchWithContext(request) -> streaming Response
```

The live response body kept the JSRPC invocation active while the outbox timer continued polling.
The route now uses the RPC target only to initialize the object's scope, disposes that target, and
forwards the response through the Durable Object's native fetch boundary:

```text
remoteObject.init(scope) -> dispose RpcTarget -> DurableObjectStub.fetch(request)
```

The fix is implemented in:

```text
apps/backoffice/app/routes/api/automations-scoped.server.ts
```

A browser Automations stream remained active under trace:

```text
92960043019208d949e1a32174a06ca0
```

While that stream was polling, two independent Files requests were issued:

```text
82f8a80d08db47c5d48ff39b0e72e71f
6c96b52dd5055b7ab4ece3f50a4da2ca
```

The first Files trace had a 63 ms root and a 63 ms whole-trace wall time. Its span count and storage
counts remained unchanged during a later three-second sample:

```text
before: 147 spans, 47 storage execs, 11 storage transactions
later:  147 spans, 47 storage execs, 11 storage transactions
```

During the same interval, the independent stream trace continued growing:

```text
before: 833 spans, 392 storage execs, 400 storage transactions
after:  856 spans, 402 storage execs, 413 storage transactions
```

The second Files trace had a 67 ms root and a 67 ms whole-trace wall time after the stream had
already been active for approximately one minute. Its storage spans were confined to the request
interval; there was no approximately 100 ms polling tail.

This bounded reproduction demonstrates that active Automations outbox polling now remains in the
stream trace rather than extending the foreground Files trace. It also localizes the original
contamination to streaming a response through the returned RPC target, not to
`getUploadBrowserDatabase()` running on the server.

## Additional trace-context contamination audit

The outbox fix did not cover every route that returns a long-lived response through an initialized
Automations RPC target.

### Confirmed Workflows emission-stream contamination

The Workflows route remains forwarded through:

```text
apps/backoffice/app/routes/api/scoped-pi.ts
  -> kernel.scoped(... runtime.objects.automations)
  -> AutomationsObject.fetchWithContext(...)
  -> initialized RpcTarget
```

The route below is a 60-second NDJSON stream backed by a `BufferedDatabasePump` polling every 100
ms:

```text
GET /api/workflows/:scope/:workflowName/instances/:instanceId/current-step/emissions
```

A bounded browser probe opened this stream for an existing Marketplace ingestion workflow.

Stream trace:

```text
6a5e0e3e7fa40476841d53fa48da3ad5
```

Foreground Files trace issued while the stream was active:

```text
08bb8fdd7f3783fc7aabdb016da98771
```

The Workflows stream initially accumulated polling storage in its own trace. When the foreground
Files request entered the same Automations Durable Object, polling attribution moved into the Files
trace:

```text
Workflows stream before transition:
  1,243 spans
  971 storage execs
  235 storage transactions

Files request after transition:
  HTTP root: 73 ms
  final whole-trace wall time: 34,554 ms
  1,792 spans
  1,377 storage execs
  339 storage transactions
```

The dominant Files-trace parent was one incomplete JSRPC span with 1,658 automatic storage children.
The Workflows stream trace stopped growing while the Files trace continued growing. Both stopped at
the stream's 60-second timeout/abort boundary.

This is the same contamination class as the original Automations outbox issue and is independently
confirmed by trace evidence.

### Structurally affected Pi event stream

The Pi route is forwarded through the same `scoped-pi.ts` `fetchWithContext` boundary. Its session
event endpoint is also a 60-second NDJSON stream backed by the same workflow step-emission pump:

```text
GET /api/pi/:scope/workflows/:workflowName/sessions/:sessionId/events
```

There was no persisted Pi session available for a second browser reproduction, but the transport,
stream implementation, timeout, and 100 ms database pump are the same as the confirmed Workflows
case. This path should be treated as affected until moved to a native Durable Object fetch boundary.

### Structurally affected internal outbox routes under Pi and Workflows

The Fragno internal outbox stream can be reached below any hosted fragment mount. Therefore these
routes can also stream through `scoped-pi.ts` and `fetchWithContext`:

```text
/api/pi/:scope/_internal/outbox/stream
/api/workflows/:scope/_internal/outbox/stream
```

Backoffice currently gets session listings from the shared Automations collections rather than a Pi
outbox coordinator, so these endpoints were not observed as normal browser traffic. They remain
reachable and share the affected transport.

### Long-poll risk: `wait-for-agent-end`

The Pi route below can wait up to 60 seconds while a `BufferedDatabasePump` polls workflow
emissions:

```text
GET /api/pi/:scope/workflows/:workflowName/sessions/:sessionId/wait-for-agent-end
```

It returns JSON rather than a streaming body, but the `fetchWithContext` JSRPC invocation remains
open for the wait duration. The runtime-tools Pi implementation also opens this request before
sending a command. This has the same ambient-context risk even though the response is not streamed.
It was identified statically but not separately reproduced in the trace store.

### Streaming Telegram download RPC

`TelegramObject.downloadAutomationFile()` returns a `Response` whose body is the upstream Telegram
file stream. The Backoffice attachment-download route then forwards that body to the browser.
Because this `Response` is returned from an initialized RPC target rather than native Durable Object
fetch, a long download can keep its JSRPC invocation alive and expose concurrent Telegram object
activity to the same attribution problem.

This path does not run a 100 ms database pump, so it is lower amplification than Workflows and Pi,
but it violates the same transport constraint.

### Initialized bindings without current stream handlers

The initialized bindings are:

```text
API
AUTOMATIONS
BILLING
TELEGRAM
MCP
```

API and MCP public routes currently return bounded JSON/text responses; repository search found no
production `jsonStream()` handler in either fragment. Billing likewise has no current long-lived
response. Their use of `object.fetch()` through an initialized RPC target is a latent transport
risk, not a confirmed active contamination source.

MCP tool calls and some Telegram operations can wait on external services for many seconds. Long
awaited RPC invocations can enlarge the overlap window, but no independent contamination trace was
captured for them.

### Streaming-route census

Repository search found three production Fragno `jsonStream()` route definitions:

1. Fragno DB outbox stream.
2. Workflows current-step emission stream.
3. Pi session event stream.

Their Backoffice transports are currently:

| Stream                       | Transport                                             | State                  |
| ---------------------------- | ----------------------------------------------------- | ---------------------- |
| Upload outbox                | native Upload Durable Object fetch                    | isolated               |
| Automations outbox           | native Automations Durable Object fetch after the fix | isolated               |
| Workflows emissions          | `AutomationsObject.fetchWithContext` RPC              | confirmed contaminated |
| Pi session events            | `AutomationsObject.fetchWithContext` RPC              | structurally affected  |
| Pi/Workflows internal outbox | `AutomationsObject.fetchWithContext` RPC              | structurally affected  |

### Required transport invariant

A streaming or long-polling `Response` must not cross a returned `RpcTarget`. The RPC target may be
used for short initialization or command methods, but response-body ownership must cross a native
Durable Object fetch boundary.

For Pi and Workflows, direct fetch also needs the trusted `BackofficeExecutionContext` currently
passed as an RPC argument. A complete fix should introduce one canonical internal fetch transport
that:

1. resolves the raw scoped Automations Durable Object stub;
2. initializes and disposes the scope RPC target before forwarding;
3. serializes the trusted execution context into a route-owned internal request envelope;
4. validates that envelope in `Automations.fetch()` at the Durable Object boundary;
5. calls the existing `fetchWithContext` domain path locally inside the object;
6. returns the response through `DurableObjectStub.fetch()` rather than RPC.

The route Worker must overwrite or remove any caller-supplied internal context envelope before
forwarding. The Durable Object must validate the decoded execution context before using it.

Telegram downloads should similarly become a native fetch endpoint instead of returning a `Response`
from `downloadAutomationFile()` over RPC.

## Evidence boundary

Backoffice was started with:

```text
pnpm --filter @fragno-apps/backoffice-rr dev
```

The live origin was:

```text
http://localhost:5173
```

Both known Local Explorer SQL endpoint variants accepted a connection but failed to return a simple
count query within ten seconds:

```text
POST /cdn-cgi/local/explorer/api/local/observability/query
POST /cdn-cgi/local/explorer/api/observability/query
```

The trace investigation therefore used the observability SQLite database read-only:

```text
apps/backoffice/.wrangler/state/v3/observability/miniflare-wobs-trace-store/
  a590acd76969f996ec6e4b599c3c09f58c283a76f2d61392b5d3046caf557602.sqlite
```

The development server was stopped after verification. No trace-store records were mutated.

## Changes under verification

The working tree contained tracing-related changes in Backoffice and `@fragno-dev/db`.

### Backoffice custom spans

The route Worker configures `cloudflare:workers` tracing through
`configureBackofficeTracer(tracing)`. New spans include:

- `backoffice.files.load_collections`
- `backoffice.files.collection.workspace`
- `backoffice.files.collection.static`
- `backoffice.codemode.resolve_artifacts`
- `backoffice.capability.<capability>.status`
- `backoffice.mcp.list_servers`
- `backoffice.automations.ensure_configured`
- `backoffice.automations.runtime.create`
- `backoffice.automations.runtime.reuse`
- `backoffice.automations.migration.<fragment>`

### Fragno database transaction source

Database transaction instrumentation now carries:

```text
fragno.db.request.source = route | context | stream
```

Cloudflare custom transaction spans are skipped when the source is `stream`.

### RPC stub disposal

Initialized Backoffice RPC objects are wrapped in a proxy. Each method call creates an initialized
RPC target and disposes it when the returned promise settles.

### Outbox lifecycle logging

The outbox stream now logs:

- `fragno.outbox_stream.started`
- `fragno.outbox_stream.completed`

The completion payload is intended to contain duration, poll count, entries read, error count, and
completion reason.

## Representative Files request

### Selection

Full trace ID:

```text
802488fe51250b331627ea8aa12d8f76
```

Stable selection key:

```text
http://localhost:5173/backoffice/files/org/wilcos-organization/workspace/AGENTS.md?trace-check=2
```

This was a warm, successful browser request and was representative of the new custom Files spans. It
was not representative of a cold Durable Object initialization.

### Execution summary

| Measurement                          |    Value |
| ------------------------------------ | -------: |
| HTTP root duration                   |   148 ms |
| Whole-trace wall time                | 1,947 ms |
| Span count                           |      267 |
| Errors                               |        0 |
| Incomplete spans                     |        0 |
| `durable_object_storage_exec`        |       90 |
| `durable_object_storage_transaction` |       42 |
| `durable_object_subrequest`          |       27 |
| `jsrpc`                              |       25 |

The difference between the 148 ms HTTP duration and 1,947 ms whole-trace wall time came from child
RPC and storage spans that continued after the HTTP root ended. Consequently, whole-trace wall time
was not the user-visible request duration in this trace.

### Critical branch

The useful application branch was:

```text
GET Files request — 148 ms
  -> backoffice.files.load_collections — 111 ms
     -> backoffice.files.collection.static — 89 ms
        -> backoffice.codemode.resolve_artifacts — 87 ms
           -> sequential capability status checks
           -> backoffice.mcp.list_servers — 16 ms
     -> backoffice.files.collection.workspace — 27 ms
```

Observed capability spans included Telegram, Resend, Reson8, Upload, Pi, Sandbox, and GitHub. This
confirms that the custom spans expose the live capability-discovery fan-out described in the
production Files incident report.

The local warm request was substantially faster than the production incident's 6.940 second request.
It does not invalidate the production causal explanation because the local objects were warm and the
environments differ.

### Database transaction source

The trace contained:

| Request source | Custom Fragno DB spans |
| -------------- | ---------------------: |
| `context`      |                     15 |
| `route`        |                      6 |
| `stream`       |                      0 |

This proves that `route` and `context` attributes are exported. The absence of `stream` custom spans
is consistent with the new stream suppression.

### RPC lifetime distortion

An Automations-related `jsrpc` `init` span lasted approximately 1.25 seconds, outlived its
capability parent and the HTTP request, and owned 48 automatic storage spans spread over roughly
1.13 seconds.

No RPC disposal warning or canceled RPC span was observed. Disposal is therefore improved, but the
remaining `init` span duration still cannot be interpreted as method execution time.

The repeated storage children were consistent with overlapping outbox polling. They did not belong
to the Files request's application-critical branch.

## Cold system Automations initialization

### Selection

Full trace ID:

```text
5b28f6f32593bade0f524aaa77e0ce2b
```

Stable selection key:

```text
http://localhost:5173/backoffice/automations/system/system/dashboard?trace-check=system
```

The system Automations dashboard loaded successfully. This also confirmed that the prior system
scope `500` incident did not reproduce in the local browser scenario.

### Execution summary

| Measurement                          |    Value |
| ------------------------------------ | -------: |
| HTTP root duration                   |   108 ms |
| Whole-trace wall time                | 1,178 ms |
| Span count                           |      174 |
| Errors                               |        0 |
| Incomplete spans                     |        0 |
| `durable_object_storage_exec`        |       49 |
| `durable_object_storage_transaction` |       13 |

### Initialization spans

| Span                                           | Duration |
| ---------------------------------------------- | -------: |
| `backoffice.automations.runtime.create`        |     5 ms |
| `backoffice.automations.migration.workflows`   |     1 ms |
| `backoffice.automations.migration.automations` |     5 ms |
| `backoffice.automations.migration.pi-harness`  |     4 ms |

The new initialization instrumentation is therefore exported and parented into the request trace.

### Incorrect scope metadata

Every runtime creation and migration span reported:

```text
backoffice.object.scope_kind = unknown
```

A later `backoffice.automations.ensure_configured` span correctly reported `system`.

Source inspection explains this ordering:

```text
InMemoryAutomationsObject constructor
  -> state.blockConcurrencyWhile(...)
     -> loadStored()
     -> initializeFromStored(stored)
        -> runtime creation and migrations

later RPC call
  -> init(scope)
     -> this.#scope = scope
```

The initialization instrumentation reads `this.#scope`, but persisted initialization happens before
that field can be assigned. The instrumentation context needs to receive scope from the stored or
initialization source instead of consulting RPC session state.

## Outbox stream amplification

### Selected stream traces

Automations stream:

```text
1dd876f42ce8dc493fb17b663bbee863
```

Upload stream:

```text
2222116894626e7270154360863177f5
```

Both were independently rooted `_internal/outbox/stream` HTTP requests. The existence of those
separate root traces is expected: the browser synchronization clients legitimately open one stream
per active backend source.

The polling work should remain attributable to those stream lifecycles and should stop when the
client coordinator is disposed.

### Continued growth after navigation

After navigating away from the Files page, the two traces were sampled three seconds apart:

| Trace       | Initial spans | Later spans | Growth | Storage exec growth | Storage transaction growth |
| ----------- | ------------: | ----------: | -----: | ------------------: | -------------------------: |
| Automations |        10,357 |      10,533 |   +176 |                 +88 |                        +88 |
| Upload      |         3,470 |       3,530 |    +60 |                 +30 |                        +30 |

This proves that polling continued after route navigation. The browser probes started multiple
streams through repeated full navigations, so absolute totals were probe-distorted. Continued growth
after leaving the route was not explained by a one-time probe.

The rates match the configured 100 ms pump cadence after accounting for multiple automatic storage
spans per poll.

### Custom span suppression

The Automations stream trace contained only initial `route` and `context` Fragno spans. Repeated
polls did not add repeated custom `fragno.db.service.internal.outbox.list.*` spans. The Upload
stream trace contained no Fragno custom spans.

The `requestSource === "stream"` suppression therefore works for custom spans. It cannot suppress
Cloudflare's automatic `durable_object_storage_*` spans.

### Lifecycle logging

Each selected stream had a `fragno.outbox_stream.started` log with a stream ID. No matching
`fragno.outbox_stream.completed` log appeared before the development server stopped.

The server-side callback was still waiting for `stream.onAbort`. This means either the browser
coordinator remained intentionally alive or disconnect cancellation did not reach the
`ResponseStream`. Source inspection found evidence for both risks.

## Browser coordinator lifecycle

### Upload database

`getUploadBrowserDatabase` is a browser-only loader. On first browser use, its `open()` callback
constructs a `createCollectionResourceRegistry` registry. Each resource creates a Fragno outbox
coordinator and calls `coordinator.preload()`.

Successful resources return only their collections. The coordinator is not retained in the public
resource shape and has no normal cleanup path. `coordinator.cleanup()` is called only when opening
or preloading fails.

`createCollectionResourceRegistry` can invalidate a cached resource, but callers are not given an
ownership or release operation that invokes cleanup.

### Automation database

`getAutomationBrowserDatabase` uses a module-level map keyed by scope and adapter identity.
Successful promises remain in the map indefinitely. The returned database does contain its
coordinator, but normal UI consumers do not release it, and cleanup is called only when opening
fails or in explicit tests/scenarios.

Navigating through scopes can therefore accumulate one live coordinator and stream per previously
opened scope.

### Existing cleanup mechanism

The lower layers already support correct cleanup:

```text
coordinator.cleanup()
  -> FragnoOutboxSynchronizer.dispose()
     -> AbortController.abort()
        -> consumeNdjsonOutboxStream cancels its reader
```

The primary missing piece is invoking that mechanism from normal browser resource ownership.

### Response stream disconnect handling

`ResponseStream.responseReadable.cancel()` calls `abort()`, which should notify registered abort
listeners when cancellation propagates through the response chain.

However, `ResponseStream.writeRaw()` catches and ignores all writer errors. If downstream
cancellation does not invoke `responseReadable.cancel()`, a failed write cannot terminate the pump.
For an empty outbox, no writes happen after startup, so the server has no fallback liveness signal.

## Is `createCollectionResourceRegistry` supposed to load on the server?

There are two separate questions: module evaluation and resource creation.

### Module evaluation

Yes, the module can currently be evaluated in the server bundle because route modules import
`getUploadBrowserDatabase`, `getAutomationBrowserDatabase`, and related types and helpers.

`createCollectionResourceRegistry` itself is an isomorphic in-memory `Map` helper. Merely importing
or evaluating its definition does not open a database, perform a fetch, or start an outbox stream.

The Automation browser database module also creates module-level maps during module evaluation.
Those maps are inert unless `getAutomationBrowserDatabase()` is called.

### Resource creation

No, browser collection resources are not supposed to be created on the server.

For Upload, `createCollectionResourceRegistry()` is called inside the `open()` callback passed to
`createBrowserCollectionDatabaseLoader`. The returned loader checks:

```ts
if (typeof window === "undefined") {
  throw new Error("... is only available in the browser.");
}
```

Therefore the Upload registry should not be constructed during SSR unless server code incorrectly
calls the browser loader.

For the observed Files and Automations routes, calls occur in components nested under `ClientOnly`.
On the server, `ClientOnly` returns the fallback and does not render those synchronized child
components. Their modules are still imported and evaluated, but their database loader calls should
not execute.

The current local traces do not show that a server invocation of `createCollectionResourceRegistry`
opened these streams. The stream roots were browser HTTP requests created after hydration.

That said, the browser-only boundary is weaker than ideal:

- Browser implementation modules are imported by universal route/component modules.
- `getAutomationBrowserDatabase()` has no direct `window` assertion comparable to the Upload loader.
- Correctness depends on every call site remaining under `ClientOnly`.

A `.client.ts` module boundary or explicit browser assertion in both loaders would make illegal
server invocation unrepresentable and keep browser persistence dependencies out of server bundles
where the framework supports that split.

## Local observability store health

At the time of investigation:

| Measurement      |                 Value |
| ---------------- | --------------------: |
| Main SQLite file |  approximately 41 GiB |
| WAL              | approximately 131 MiB |
| SQLite page size |           4,096 bytes |
| Page count       |            10,632,510 |
| Freelist count   |                     0 |

The store size made the Local Explorer API unusable for even `SELECT COUNT(*) FROM spans` within a
ten-second timeout. Trace-id-bound primary-key queries remained practical through read-only SQLite.

Current stale stream polling adds data continuously, but the investigation did not prove that the
newly observed streams account for the entire pre-existing 41 GiB database.

Store maintenance must remain separate from application fixes. Backoffice should be stopped before
any direct mutation, and only proven disposable trace IDs should be deleted.

## Probe distortion and excluded traces

Initial startup and Vite optimization generated non-representative traces, including
`__vite_plugin_cloudflare_get_export_types__` work with thousands of `fetch` spans. Browser reloads
also encountered temporary Vite `504 Outdated Optimize Dep` responses while dependencies were being
optimized.

Those traces were excluded from application conclusions. Repeated browser navigations did, however,
create additional real outbox streams. This inflated absolute stream counts and also revealed that
successful coordinators were not being disposed.

## Propagation state

The selected scenarios did not execute a durable hook attempt and contained no
`fragno.hook.has_propagation_context` attribute. Durable-hook propagation across capture,
persistence, restoration, and child/link creation remains unverified by this run.

Database request-source propagation was exercised and worked for `route` and `context`. Stream
source propagation was indirectly verified by the absence of repeated custom transaction spans and
by the relevant unit tests.

## Automated verification

The focused test command completed successfully:

```text
Test Files  5 passed
Tests       106 passed | 1 todo
```

It covered:

- RPC stub disposal
- Cloudflare database transaction instrumentation
- stream transaction suppression
- overlapping stream and foreground transaction behavior
- Durable Object initialization instrumentation
- outbox lifecycle logging in the in-process stream test
- unit-of-work instrumentation context

Type checking also passed:

```text
23 successful tasks
```

for:

- `@fragno-dev/db`
- `@fragno-apps/backoffice-rr`

The passing in-process outbox test proves that `completed` is logged when the test explicitly calls
`stream.return()`. It does not prove that real browser cancellation reaches the server.

## Causal assessment

### Observed facts

- Files and system Automations loaded successfully.
- New Backoffice custom spans were exported.
- Cold runtime creation and migration spans were exported.
- Cold initialization scope was `unknown`.
- Route and context database sources were exported.
- Repeated stream custom database spans were suppressed.
- Automatic storage spans continued at the polling cadence.
- Streams continued after route navigation.
- Successful browser resources have no normal cleanup ownership.
- Lower-level coordinator cleanup already aborts the client stream.
- Only stream-start logs were observed in the browser lifecycle.
- The local trace store was 41 GiB and the SQL API timed out.

### Inference

- The missing browser resource cleanup is the most direct explanation for streams surviving route
  and scope changes.
- Stale stream polling overlapping a foreground RPC is the most likely source of the automatic
  storage spans attached beneath that foreground RPC in local traces.
- Local Miniflare or Cloudflare automatic trace-context handling may also contribute to incorrect
  parentage when concurrent Durable Object operations overlap. This should be rechecked after stale
  coordinators are eliminated before concluding that the runtime itself is at fault.
- Additional custom `requestSource` checks cannot fix automatic storage span parentage because they
  only control Fragno-created spans.

## Recommendations

### 1. Introduce explicit browser database ownership

Replace permanent promise/resource caches with reference-counted leases or another explicit
ownership primitive.

A suitable shape is:

```ts
type BrowserCollectionDatabaseLease<TDatabase> = {
  database: TDatabase;
  release(): Promise<void>;
};
```

Required behavior:

1. The first owner opens and preloads the coordinator.
2. Multiple consumers of the same resource share it.
3. Releasing one of multiple owners keeps it alive.
4. Releasing the final owner calls `coordinator.cleanup()`.
5. Cleanup removes the exact resource from the cache.
6. A later acquire creates a new coordinator and catches up from the persisted checkpoint.
7. A short grace period may prevent churn during quick sibling-route transitions.

Ownership should live at the Backoffice scope or shell level when global UI such as the top bar or
workflow drawer needs the same coordinator. Individual leaf components should not independently
fight over lifetime.

### 2. Add browser shutdown and development cleanup

As defense in depth:

- Clean up coordinators on `pagehide`.
- Clean up all module-owned coordinators in `import.meta.hot.dispose` during Vite HMR.
- Remove failed and disposed resources from maps deterministically.

This is especially important locally because HMR can preserve or recreate module resources while old
network activity remains visible.

### 3. Make the generic synchronizer stop when unused

The synchronization primitive should not require every application to get lifecycle behavior exactly
right.

Consider making `FragnoOutboxSynchronizer` or its coordinator stop streaming when it has no
registered consumers, and restart with catch-up when a consumer is added. This requires a
restartable stream abort controller distinct from permanent coordinator disposal.

Application-level leases are still necessary if eager TanStack collections remain registered after
their UI consumers disappear.

### 4. Strengthen server stream termination

- Do not silently swallow writer failures without aborting the response stream.
- On write failure, invoke `stream.abort()` and allow the route callback to reach `finally`.
- Send an occasional blank NDJSON heartbeat. The current consumer ignores blank lines.
- Add a bounded stream lease, such as 30–60 seconds, and let the client reconnect from its persisted
  versionstamp.
- Extend completion reasons to distinguish `aborted`, `lease_expired`, `closed`, and `failed`.

A bounded lease caps individual trace size and guarantees periodic lifecycle completion even when a
proxy fails to propagate cancellation.

### 5. Eliminate per-stream 100 ms database polling

The strongest primitive is event-driven outbox notification inside the database-owning Durable
Object:

1. Perform an initial outbox query from the client's cursor.
2. Register an in-memory waiter or subscriber.
3. Signal subscribers after an outbox mutation commits.
4. Query from the latest cursor only when signaled.
5. On object restart or reconnect, recover through the persisted versionstamp.

This produces no storage activity while idle.

If event-driven notification is not implemented immediately:

- Share one poller per Durable Object instead of one pump per stream.
- Fan out observed entries to all connected streams.
- Add adaptive idle backoff from 100 ms toward one or several seconds.

A shared poller reduces amplification but may still inherit an unhelpful trace context. Event-driven
notification removes the idle storage spans entirely.

### 6. Fix initialization scope at the source

Pass scope through the Durable Object initialization instrumentation context rather than reading
`this.#scope`.

For persisted initialization, derive scope from the stored initialization source. For
`storeAndInitialize`, derive it from the supplied configuration. The initialization context can then
make scope non-optional:

```ts
type FragmentDurableObjectInitializationContext =
  | { phase: "createRuntime"; hostName: string; scopeKind: BackofficeContextScope["kind"] }
  | {
      phase: "migrate";
      hostName: string;
      scopeKind: BackofficeContextScope["kind"];
      fragmentName: string;
    };
```

The generic Fragno DB primitive should not depend directly on a Backoffice scope type; Backoffice
can instead supply stable initialization metadata or the instrumentation callback can close over
initialization source data.

### 7. Strengthen the browser-only boundary

The current implementation should not create resources on the server, but that guarantee depends on
call-site discipline.

Recommended hardening:

- Put browser database implementations behind `.client.ts` entrypoints where supported.
- Add a direct browser assertion to `getAutomationBrowserDatabase()`.
- Keep server code on dedicated `server.ts` modules and type-only imports.
- Avoid importing browser persistence implementation modules from universal modules when a narrow
  client component can own the import.

This is primarily an architecture and bundle-safety improvement, not the explanation for the
observed stream traces.

### 8. Keep Files performance remediation separate

The new spans confirm that static codemode artifact generation still performs sequential capability
status discovery on the request path. The warm local timing was acceptable, but the production
incident remains structurally possible.

Longer-term options remain:

- cache capability snapshots;
- regenerate artifacts when capability configuration changes;
- parallelize independent status checks with bounded timeouts;
- defer artifact generation until the relevant static file is selected.

### 9. Add lifecycle scenario tests

Add scenarios that assert final state, not only method calls:

1. Open one scope and observe exactly one stream per source.
2. Acquire the same resource twice and release once; the stream remains.
3. Release the final owner; the client request aborts and the server logs `completed` once.
4. Navigate from scope A to scope B; A's stream stops and B's stream starts.
5. Navigate out of Backoffice; all scope streams stop.
6. Run HMR disposal; all old coordinators stop.
7. Sample trace counts after cleanup and assert that they no longer grow.
8. Keep a legitimate stream active while making a foreground request and verify that 100 ms polling
   is not parented beneath the foreground request.
9. Exercise a cold stored initialization and assert a concrete scope kind rather than `unknown`.
10. Exercise a durable hook with and without restored propagation context.

### 10. Repair the local trace store only after application fixes

After stopping Backoffice and identifying an explicit disposable set:

1. Record the exact stale stream trace IDs.
2. Delete matching logs before spans.
3. Preserve unrelated traces.
4. Checkpoint or compact only with the server stopped.
5. Re-measure database and WAL size.
6. Consider a local retention mechanism so one forgotten stream cannot produce another 41 GiB store.

No trace-store mutation was performed during this investigation.

## Reproduction SQL

Resolve recent roots by indexed time range:

```sql
SELECT trace_id, span_id, name, service, start_ms, duration_ms,
       outcome, error, json(attributes) AS attributes
FROM spans
WHERE parent_id IS NULL
  AND start_ms BETWEEN ? AND ?
ORDER BY start_ms DESC;
```

Expand one trace:

```sql
SELECT span_id, parent_id, service, name, kind, start_ms,
       duration_ms, outcome, error, json(attributes) AS attributes
FROM spans
WHERE trace_id = ?
ORDER BY start_ms, span_id;
```

Group dominant operations:

```sql
SELECT name, service, COUNT(*) AS count,
       SUM(COALESCE(duration_ms, 0)) AS summed_ms,
       MAX(COALESCE(duration_ms, 0)) AS max_ms
FROM spans
WHERE trace_id = ?
GROUP BY name, service
ORDER BY count DESC, summed_ms DESC;
```

Calculate trace wall time and incomplete spans:

```sql
SELECT COUNT(*) AS span_count,
       MIN(start_ms) AS earliest,
       MAX(start_ms + COALESCE(duration_ms, 0)) AS latest,
       MAX(start_ms + COALESCE(duration_ms, 0)) - MIN(start_ms) AS wall_ms,
       SUM(duration_ms IS NULL) AS incomplete,
       SUM(error IS NOT NULL) AS errors
FROM spans
WHERE trace_id = ?;
```

Count stream growth:

```sql
SELECT COUNT(*) AS span_count,
       SUM(name = 'durable_object_storage_exec') AS storage_execs,
       SUM(name = 'durable_object_storage_transaction') AS storage_transactions,
       SUM(duration_ms IS NULL) AS incomplete
FROM spans
WHERE trace_id = ?;
```

Inspect lifecycle logs:

```sql
SELECT ts_ms, level, message, operation, span_id
FROM logs
WHERE trace_id = ?
ORDER BY ts_ms, seq;
```

Inspect request-source distribution:

```sql
SELECT json_extract(json(attributes), '$."fragno.db.request.source"') AS request_source,
       COUNT(*) AS count
FROM spans
WHERE trace_id = ?
  AND name LIKE 'fragno.db.%'
GROUP BY request_source;
```

Group automatic storage spans by parent:

```sql
SELECT storage.parent_id,
       parent.name AS parent_name,
       COUNT(*) AS count,
       SUM(COALESCE(storage.duration_ms, 0)) AS summed_ms,
       MIN(storage.start_ms) AS first_ms,
       MAX(storage.start_ms + COALESCE(storage.duration_ms, 0)) AS last_ms
FROM spans AS storage
LEFT JOIN spans AS parent
  ON parent.trace_id = storage.trace_id
 AND parent.span_id = storage.parent_id
WHERE storage.trace_id = ?
  AND storage.name LIKE 'durable_object_storage_%'
GROUP BY storage.parent_id, parent.name
ORDER BY count DESC;
```

## Conclusion

The tracing additions provide materially better application-level visibility and correctly identify
route, context, runtime creation, migration, capability, and collection operations. They also
demonstrate why filtering custom stream spans is not enough.

The Automations trace-context contamination is resolved by keeping the long-lived response off the
returned RPC target and using the Durable Object fetch boundary. Explicit browser ownership and
cleanup are still recommended to stop unused streams, and event-driven outbox notification remains
the cleanest way to remove idle storage amplification. Those are lifecycle and efficiency concerns,
not prerequisites for foreground trace isolation after this fix.
