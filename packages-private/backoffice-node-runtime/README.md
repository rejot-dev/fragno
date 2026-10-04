# Backoffice Node runtime

Reusable Durable Object execution in Node worker threads, authority-bound Graft persistence, Cap'n
Web RPC, durable-hook processing, and alarm scheduling. Backoffice currently keeps its own runtime
implementation; application integration with this package is deferred.

## Package layout

```text
bin/
  run.js            backoffice-node-runtime command entrypoint
src/
  graft/            Graft storage, control bootstrap, durable commands, and object-log fencing
  runtime/          Object definitions, worker ownership, Node process hosting, clocks, and state APIs
  gateway/          Read-only discovery, incarnation probes, and single-attempt HTTP streaming
  rpc/              Cap'n Web sessions over MessagePorts and authenticated peer WebSockets
  sqlite/           Managed object SQL boundary and Durable Object SQL adapter
  scheduling/       Alarm scheduling and durable-hook processing
  testing/          Scenario runner
    fixtures/       Importable object factories used by package tests
```

Tests live beside their source files. Build output mirrors these directories; public package
subpaths map directly to the defining modules and remain independent of the internal layout.

Type checking and type-aware lint wait for this package's build because scenario fixtures consume
its compiled public exports; otherwise rebuilding can remove declarations while checks read them.

References:

- `docs/sqlite-ddl-reference.md` inventories every package-owned and test-only SQLite DDL statement.
- `docs/stateless-graft-runtime-plan.md` describes the remaining distributed runtime work.

## Object workers

`createAuthorityBoundGraftNodeObjectRuntime` from
`@fragno-private/backoffice-node-runtime/node-object-runtime` owns one worker thread per
`(binding, object name)`. Fetch, RPC, initialization, alarms, and `waitUntil` all use the **same
object instance and SQLite connection inside that worker**. Different object identities have
separate threads and in-memory state. The routing server stays in the calling thread.

Internally, `runtime/node-object-activation.ts` owns one object, its Graft state, output scopes,
alarm delivery, and shutdown. `runtime/node-object-worker.ts` only adapts that activation to the
MessagePort control protocol. Handler and returned-capability calls can interleave; one activity
tracker prevents eviction and waits for admitted calls during shutdown. There is no worker-local
multi-object namespace or separate execution coordinator. This is a lifecycle simplification, not
worker pooling: resident objects still have separate threads and their associated memory costs.

Factories must be named exports from modules that Node can import directly. They are not serialized
closures and cannot capture the routing server's variables. Use compiled ESM modules for deployment;
native, erasable TypeScript modules also work on the supported Node versions. Module URLs must
resolve in the deployed filesystem, not through Vite or a test runner's module transforms. The
package's `dist/runtime/node-object-worker.js` and the rest of `dist/` must be preserved when
deploying or bundling. The low-level runtime leaves ingress in the calling thread; the
authority-bound Node host described below owns both production HTTP listeners and the internal peer
upgrade lifecycle.

```ts
// counter-object.ts
import type { NodeRuntimeObjectContext } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

export function createCounterObject({ state, nowEpochMs }: NodeRuntimeObjectContext) {
  let memoryCount = 0;
  return {
    async schedule() {
      await state.storage.setAlarm(nowEpochMs() + 100);
    },
    async fetch(_request: Request) {
      return Response.json({ memoryCount, count: (await state.storage.get("count")) ?? 0 });
    },
    async alarm() {
      memoryCount += 1;
      const count = (await state.storage.get<number>("count")) ?? 0;
      await state.storage.put("count", count + 1);
    },
  };
}
```

Construct the runtime using the Graft configuration and authority policy below. There is one storage
implementation: development and scenarios use filesystem remotes, not a separate SQLite or in-memory
runtime. The control log coordinates ownership and discovers due alarms across restarts without
activating every persisted identity. Object names can contain colons; binding names must be nonempty
and cannot contain colons. Object factories receive `id`, `name`, `state`, and `nowEpochMs()`.
Synchronous and asynchronous methods both wait for `blockConcurrencyWhile` initialization. Factories
may return object literals or class instances.

Fetch and RPC cross real worker-thread boundaries through Cap'n Web sessions on Node MessagePorts.
Cap'n Web owns serialization, callback capabilities, returned `RpcTarget` capabilities, promise
pipelining, and Request/Response body streaming. Plain supported values are copied, not shared by
reference. `Date`, `Uint8Array`, and `bigint` values survive the boundary. Unsupported values follow
Cap'n Web's serialization errors (for example, version 0.12.0 rejects `Map` values). Instance fields
and alarm handlers are not exposed as public RPC methods. Every namespace `get(name)` returns an
independently disposable duplicate; disposing it explicitly or with `using` does not invalidate
other callers or the runtime-owned handle. An active output gate owns and automatically disposes
namespace handles acquired inside it. Calls outside an output gate remain caller-owned. Cap'n Web's
reserved method names apply.

KV storage retains its separate V8 serialization format; RPC serialization does not change persisted
values. Alarm failures leave alarms pending for retry, and successful alarms can reschedule
themselves. Worker exits reject outstanding calls and retained capabilities rather than hanging.
Application requests are never replayed automatically.

## Graft storage and durability

The runtime uses one durable Graft control database to map object identities to remote logs and one
Graft SQLite database per object. The object database contains application SQL plus the runtime's
narrow KV and alarm tables. Object authors access persistence only through `state.storage`; the
worker owns local commits and Graft pushes. The database assigns every local commit an
activation-local storage position. Internal RPC calls made inside `runtime.runWithOutputGate()`
accumulate the highest position their output can reveal without pushing between calls. Immediately
before the enclosing external result or handler error is exposed, the worker proves that position
durable with Graft. A failed push poisons that worker's database so its speculative local state
cannot be read as confirmed state.

Every runtime uses renewable leases, terminal watchdog-driven retirement, authenticated peer
routing, receipt-backed lazy first-object provisioning, object-log fencing, and durable fleet-wide
alarm discovery. The unbound single-owner Graft constructor has been removed.

Provision the control database once and retain its remote log ID in deployment configuration. The
runtime CLI separates identity reservation from remote publication so deployment tooling can persist
the canonical identity before any ambiguous remote write:

```sh
GRAFT_CONFIG=./graft.toml backoffice-node-runtime bootstrap reserve

GRAFT_CONFIG=./graft.toml backoffice-node-runtime bootstrap publish \
  --control-remote-log-id 'reserved-id'
```

`reserve` prints `GRAFT_CONTROL_REMOTE_LOG_RESERVED` with the generated ID. `publish` creates the
control schema or verifies an existing schema through a fresh clone, so rerunning it with the same
ID is safe after interruption. The CLI also accepts `--graft-config <path>` instead of
`GRAFT_CONFIG`. Deployment tooling must persist the reservation and ensure that only one identity
becomes canonical.

### Authority-bound activation and takeover

`createAuthorityBoundGraftNodeObjectRuntime` registers one process-incarnation lease, claims each
opened object as `restoring`, pushes an authority fencing commit to the object's stable log,
initializes the worker, and publishes `ready` before its first RPC is admitted. The managed object
database captures the exact object epoch, node generation, claim ID, and confirmed lease deadline.
Every output checks that token before and after its durability push. Expired authority, an authority
row mismatch, or a divergent push poisons the activation instead of rebasing application SQL.

```ts
import type { createCounterObject } from "./counter-object";
import { createAuthorityBoundGraftNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import { startNodeBackofficeAlarmScheduler } from "@fragno-private/backoffice-node-runtime/node-alarm-scheduler";

const counterDefinition = defineNodeRuntimeObject<typeof createCounterObject>(
  new URL("./counter-object.js", import.meta.url),
  "createCounterObject",
);
const runtime = createAuthorityBoundGraftNodeObjectRuntime({
  storage: { configPath: "./graft.toml", controlRemoteLogId },
  clock: { kind: "system" },
  nodeIdentity: {
    nodeId: crypto.randomUUID(),
    processGeneration: crypto.randomUUID(),
    privateAddress: "wss://node-a.internal/node-object-peer",
    applicationOrigin: "https://node-a.internal",
    compatibilityVersion: 1,
  },
  leasePolicy: {
    leaseDurationMs: 30_000,
    renewalIntervalMs: 5_000,
    renewalRetryIntervalMs: 500,
    selfFenceSafetyMarginMs: 5_000,
    maximumClockSkewMs: 500,
  },
  peerRpc: {
    authenticationSecret: process.env.NODE_PEER_AUTHENTICATION_SECRET!,
    authenticationWindowMs: 5_000,
  },
  objectProvisioning: { kind: "lazy" },
  objectEviction: {
    kind: "automatic",
    idleTimeoutMs: 300_000,
    sweepIntervalMs: 30_000,
    reportError: console.error,
  },
  objects: { COUNTER: counterDefinition },
});
```

Use `startNodeBackofficeAlarmScheduler(runtime)` for background polling, and stop that scheduler
before `runtime.cleanup()`. The runtime owns expiry and renewal identities. Choose the policy from
measured push/reconciliation latency and the deployment's bounded inter-node skew, not a fixed TTL
fraction. The example above is illustrative, not a production timing recommendation. The safety
margin must cover the declared skew; renewal and retry intervals must fit inside the conservative
authority window.

`GraftNodeAuthority` in `graft-node-authority` translates each confirmed lease into a monotonic
deadline anchored at attempt start. Failed or unresolved renewals keep the old window and retry the
same semantic command. Confirmation after the old deadline permanently fences that process
generation, even if its renewal landed remotely. The runtime aborts RPC sessions and retires its
workers; retained stubs and capabilities cannot revive it. Workers check authority before events,
storage access, and output, and the main transport rejects replies queued across suspension.
Wall-clock rollback cannot extend monotonic authority; crossing the persisted wall expiry also fails
closed.

System clocks schedule renewal and a separate deadline watchdog automatically. Lease renewal never
waits for worker acknowledgements. Each worker has at most one extension RPC in flight and one
pending latest window, so a stalled activation neither blocks renewal nor accumulates an unbounded
RPC queue. Workers still reject extensions received after their previously accepted window expires.
Manual clocks use `runtime.tick()` and expose independent wall/monotonic adjustments for
deterministic scenarios. A tick confirms node authority but is not a barrier for worker
acknowledgement. Object activation eviction is separately configured as `disabled`, `manual`, or
`automatic`. Automatic eviction sweeps every `sweepIntervalMs`; manual scenarios call
`runtime.sweepIdleObjects()`. A worker is eligible after `idleTimeoutMs` only when it has no active
event, open output scope, or registered pending work. Eviction releases resident resources and exact
object authority without deleting durable state or scheduled alarms. Retained capabilities and
post-return streams remain activation-bound and can break after eviction.

`runtime.readNodeAuthorityStatus()` reports `serving`, terminal `fenced`, or `closed`; registration
is synchronous and must confirm before construction returns. Healthy `cleanup()` keeps renewing
while registered work drains, then conditionally releases only the exact claims returned by worker
shutdown. Terminal fencing never runs graceful release. A worker that misses an extension is retired
rather than revived; other objects can remain available on the node.

Authority-bound namespace lookups now resolve a fresh ownership-and-lease snapshot, activate locally
when the object is unowned or conservatively takeover-eligible, and otherwise obtain an exact
epoch/claim-bound capability from the live owner over an authenticated Cap'n Web WebSocket session.
The receiving node validates its own identity, process generation, compatibility version, claim,
lease, and authority before delivery. Explicit stale-route refusals are retried only before an
application method is delivered; retained object and returned capabilities stay tied to their
original activation and are never silently reconnected.

`startAuthorityBoundGraftNodeObjectHost` from
`@fragno-private/backoffice-node-runtime/node-object-runtime-host` is the recommended Node process
shell. It binds separate application and internal HTTP listeners before registering node authority.
Only the internal listener accepts authenticated peer WebSocket upgrades; its advertised HTTP(S)
origin and peer path determine the WS(S) address. The host starts durable alarm-work polling, gates
requests during startup and shutdown, and owns cleanup of both listeners. The application listener's
host-owned `GET /_runtime/ready` route bypasses the application and returns `200` only when both the
host and its node authority are serving. Its JSON body is
`{ status: "ready", nodeId, processGeneration }`, binding readiness to the exact leased incarnation
without an application health endpoint. The path and response type are defined in
`node-runtime-readiness`. It returns `503` with `{ status: "not-ready" }` after authority expires or
fences, even if the HTTP listener remains open and no application request has observed the expiry
yet. Every admitted application Fetch runs inside one automatic output gate, which proves local
object state durable and disposes namespace handles before releasing the response. The application
also maps failures that occur after handler execution, such as a failed durability push. Hono
remains an application choice:

```ts
import { startAuthorityBoundGraftNodeObjectHost } from "@fragno-private/backoffice-node-runtime/node-object-runtime-host";

const host = await startAuthorityBoundGraftNodeObjectHost({
  storage: { configPath: "./graft.toml", controlRemoteLogId },
  clock: { kind: "system" },
  identity: { kind: "generated", compatibilityVersion: 1 },
  leasePolicy,
  peerRpc,
  objectProvisioning: { kind: "lazy" },
  objectEviction: {
    kind: "automatic",
    idleTimeoutMs: 300_000,
    sweepIntervalMs: 30_000,
    reportError: console.error,
  },
  objects: { COUNTER: counterDefinition },
  network: {
    application: {
      listenHost: "0.0.0.0",
      listenPort: 8080,
      resolveOrigin: (port) => `http://node-a.internal:${port}`,
    },
    internal: {
      listenHost: "0.0.0.0",
      listenPort: 8081,
      resolveOrigin: (port) => `http://node-a.internal:${port}`,
      peerWebSocketPath: "/node-object-peer",
      peerWebSocketMaximumPayloadBytes: 1_048_576,
    },
  },
  alarmPolling: {
    kind: "automatic",
    intervalMs: 1_000,
    reportError: console.error,
  },
  createApplications({ runtime }) {
    return {
      application: {
        fetch(request) {
          return handleApplicationRequest(request, runtime);
        },
        handleFetchFailure(error) {
          return Response.json({ error: String(error) }, { status: 503 });
        },
      },
      internal: {
        fetch(request) {
          return new URL(request.url).pathname === "/diagnostics"
            ? Response.json(runtime.readNodeAuthorityStatus())
            : new Response(null, { status: 404 });
        },
        handleFetchFailure(error) {
          return Response.json({ error: String(error) }, { status: 500 });
        },
      },
    };
  },
});

await host.close({ maximumDrainDurationMs: 8_000 });
```

The host returns `applicationOrigin`, `internalOrigin`, and `peerWebSocketAddress`. Origin resolvers
run after both ports bind, support ephemeral ports and deployment-owned advertised addresses, and
must return distinct HTTP(S) root origins without credentials. Only the application origin and peer
address are persisted in the node lease; internal HTTP inspection needs no new control-schema field.

Internal HTTP handlers do not get the application's automatic output gate or serving-authority
admission, so read-only diagnostics remain available after self-fencing. Internal commands must use
authority-checked runtime operations; any object mutations require an explicit `runWithOutputGate`.
Neither listener falls back to the other handler. Deployments must restrict the internal listener
and authenticate administrative operations as needed: a second port is not an access-control policy.
The application listener reserves `/_runtime` and rejects WebSocket upgrades.

The host enters draining immediately and rejects new application, internal HTTP, and peer-upgrade
admission. Both listeners close, and admitted handlers on both surfaces are tracked before runtime
cleanup. The close promise rejects with
`NODE_OBJECT_RUNTIME_HOST_CLOSE_DEADLINE_EXCEEDED:<milliseconds>` when its caller-visible budget
expires, while already-started cleanup remains draining and may still finish. The host waits for
active Fetch handlers but cannot infer work that outlives a returned `Response`; callers must still
settle stream producers and retained capabilities before closing. It does not install process signal
handlers; a container entrypoint should translate its platform termination signal into the bounded
`close()` call. Custom transports may continue to use the low-level
`runtime.acceptNodePeerWebSocket()` API directly.

### Read-only HTTP gateway

`createNodeRuntimeGateway` exposes `fetch(request)` and idempotent `close()`. It owns the supplied
read-only directory, checks leases and host readiness, and streams each application request to one
worker's registered `applicationOrigin`. Only readiness probes may fail over; once application
delivery starts, failures are never replayed, including mutations with lost acknowledgements.

```ts
import { startGraftGatewayDirectory } from "@fragno-private/backoffice-node-runtime/graft-gateway-directory";
import { createNodeRuntimeGateway } from "@fragno-private/backoffice-node-runtime/node-runtime-gateway";

const gateway = createNodeRuntimeGateway({
  directory: startGraftGatewayDirectory({ configPath: "./graft.toml", controlRemoteLogId }),
});

// Mount gateway.fetch on the application's HTTP listener.
// Drain that listener before close when graceful completion is required.
await gateway.close();
```

The Graft directory refreshes off the HTTP thread, without node registration, object ownership, or
provisioning capabilities. Failed refreshes invalidate the snapshot; snapshots older than five
seconds are unavailable. The gateway also requires a one-second lease margin and verifies the node
ID and process generation through the host-owned readiness route before forwarding. Its own
`GET /_runtime/ready` returns `200` only after finding a ready worker, without exposing that
worker's identity response.

The gateway has no application-route allowlist and never interprets the peer address. The registered
`applicationOrigin` must point exclusively to application ingress; administrative handlers and peer
RPC belong on the internal listener. New application routes and application 404s pass through
without any gateway configuration change. Runtime namespace routes (apart from local gateway
readiness) and protocol upgrades cannot be forwarded. Application `Authorization`, cookies, and
response `Set-Cookie` headers pass through; authentication and authorization remain application
concerns. Only transport/proxy headers and upstream body-framing headers are removed. The
`x-node-runtime-ingress-node-id` response header identifies the selected ingress worker.

`close()` stops admission, aborts in-flight probes and streams, and closes the directory. Listener
binding, graceful listener draining, environment configuration, and process signal handlers remain
application responsibilities. Discovery trusts registered origins: deployment networking and
control-log write access must prevent untrusted workers from advertising arbitrary services.

Every process uses the same peer authentication secret while advertising its own reachable `ws:` or
`wss:` address. Production must use encrypted/private transport and protect that shared secret; a
private address alone is not authorization. Peer sessions are cached by exact owner incarnation,
while object routes are read fresh for each namespace handle.

Incoming sessions retain a positively confirmed caller lease window. Admission and result checks
remain in place, but use local epoch/monotonic deadlines inside that window instead of refreshing
the control database at every check. Deadlines subtract the declared clock skew and include time
spent reading storage. Expiry requires a fresh confirmed lease; a failed refresh never extends the
window. A node-wide conservative clock prevents rollback or reconnects from reviving an expired
lease. This relies on immutable node identities and extension-only leases, not an arbitrary TTL;
adding early lease revocation would require changing this protocol. `NodePeerRpcNetwork` borrows its
node's `controlStore` reader and receives `maximumClockSkewMs`; its owner closes the store only
after peer sessions and workers have stopped.

When lazy provisioning sees a missing object, it pushes a fully initialized candidate object log and
uses the receipt-backed `registerObjectDatabase` command to select the canonical mapping. Concurrent
creators re-read and use the winning mapping before ownership activation. Losing or interrupted
candidate logs can remain unreferenced; automatic orphan-log collection is deliberately not yet
implemented. `{ kind: "preprovisioned" }` retains fail-closed missing-object behavior.

This is still not a complete fleet runtime: production backend qualification, capacity limits,
orphan-log collection, durable alarm retry backoff, and the broader peer fault matrix remain
incomplete. Main-thread lease, routing, and scanner commands still use synchronous native SQLite
operations; alarm mutation commands run in their object workers. Worker and peer admission fail
closed after a blocked main thread resumes, but dedicated control-worker isolation and fleet renewal
throughput still require qualification.

Real two-process scenarios cover both object-log orderings. If an old write reaches remote storage
first, the replacement reclones that head and preserves the write behind its higher-epoch fence,
while the expired caller receives no success. If the replacement fence lands first, the paused old
push diverges and its speculative write is discarded. Both paths delete every local cache and
restore the authoritative result in a third process.

### Durable alarm discovery

Authority-bound objects store the authoritative alarm installation in their object database and one
`reconcile` or `scheduled` work row in the control database. Every installation has a fresh UUID. An
alarm mutation is serialized within its worker and performs this sequence before returning:

1. durably replace the control row with an exact reconciliation marker;
2. mutate and push the object alarm;
3. replace the marker with the scheduled installation, or remove it when no alarm remains.

A crash before the object push leaves repair work that restores the prior object state. A crash
after the object push leaves the same marker, so a replacement activation reads the durable object
state and republishes its alarm before readiness. Successful delivery consumes only the exact
installation that ran; an alarm handler that re-arms itself therefore wins over completion of the
old alarm.

Each authority-bound host scans a bounded control page. It services alarms already owned by its node
and may claim unowned or expired-owner objects through the normal fence-and-activate path. Live
remote-owner rows are left for that owner's scanner; there is no peer alarm-wake RPC or scanner
partitioning yet. Handler failures leave the scheduled row due for a later poll without persisted
backoff. Delivery is at least once.

The process scenarios kill workers both before and after the object push, delete every local cache,
and prove that replacements respectively clear the false-positive marker or rediscover and deliver
the durable alarm. Additional scenarios cover fresh-process delivery, handler retry, and re-arm
survival.

### Durable control commands

`GraftControlStore` from `@fragno-private/backoffice-node-runtime/graft-control-store` manages the
shared control log through named, receipt-backed commands. It stores process-incarnation leases,
stable object mappings, explicit `unowned`/`restoring`/`ready` ownership, decimal-string fencing
epochs, and alarm discovery work. Available commands register and renew nodes, register object
databases, claim objects, mark claims ready, conditionally release exact claims, and begin or
complete exact alarm reconciliations.

Each store owns a lazy `GraftControlReadReplica`, separate from speculative command connections.
Read methods pull a clean, query-only connection and finish all related queries in one synchronous
snapshot. Routing and peer admission share the node's store; connections are never shared across
threads. Successful reads reuse their local volume, while a failed refresh, query, or schema check
discards the connection and fails closed. Closing the store closes both its reader and command
connection. No generic data cache or stale-snapshot fallback is used.

Every command opens a clean clone, checks an existing command receipt, evaluates its preconditions
in a short SQLite transaction, writes the result and receipt together, and synchronously pushes.
After a failed or lost push response, the store discards the speculative clone and searches a fresh
remote snapshot for the receipt. If the receipt is absent, it reruns the named command against
current state with the same command ID. It never rebases raw SQL from the losing snapshot.

Control-log read snapshots and commands share a synchronous process-local lock across object
workers. This prevents Graft 0.2.1's shared native cache from aborting on concurrent remote-head
advancement. The wait is bounded, and worker exit releases any lock it held. Object-log pushes do
not hold this lock: a blocked object push still cannot delay lease renewal. Independent processes
retain Graft's optimistic conflict/replay protocol; this is not a fleet-wide writer lock.
Synchronous control I/O and lock contention can still block the calling thread and remain a reason
to isolate control work.

Independent-process scenarios prove that concurrent claims produce one fresh epoch, losing clients
recompute against the winning history, a remotely committed command survives a lost response, an
expired owner can be replaced, and a late completion from the old claim cannot publish readiness.
The authority-bound runtime now consumes these decisions for lazy first-object registration, local
activation, remote-owner resolution, object-log fencing, node lease renewal, terminal process
self-fencing, conditional graceful release, and owner-local durable alarm scanning.

`GraftDatabaseOperations` owns the `clone`, `pull`, `push`, and remote-log lookup pragmas. The
default runtime uses the production pragma implementation for main-thread control and candidate
provisioning, and imports it separately inside each worker. Tests and alternative adapters pass
`GraftRuntimeDatabaseOperations`, whose required `control` and `provisioning` members are concrete
main-thread collaborators and whose `worker` member comes from `defineGraftDatabaseOperations`. The
worker definition transfers only a module URL, export name, and structured-clonable factory input
across the worker boundary. The package scenario uses a recording decorator around the real pragmas
to prove both boundaries: direct RPC calls push before returning to their caller, while separate
RPCs inside one external output gate perform no intermediate pushes and share one final push.
Concurrent scenarios also prove that RPCs within one scope and separate writer scopes can share a
push, while a reader does not wait for a later storage position it did not observe.

The Node host places every application Fetch and its internal object RPCs inside one output gate.
Namespace handles acquired during that Fetch are request-owned and automatically disposed. Object
factories still receive no transaction or push controls:

```ts
async function handleApplicationRequest(request: Request, runtime: CounterRuntime) {
  const counter = runtime.objects.COUNTER.get("one");
  await counter.increment();
  await counter.increment();
  return await counter.fetch(request);
}
```

Custom hosts and non-HTTP shells establish the same boundary explicitly with
`runtime.runWithOutputGate()`. Nested gates share the outer scope.

A second request that reads locally committed state inherits that object's storage position. Its
output gate pushes that position before releasing the response, even when the request that wrote the
state is still running. When the writer later reaches its own output gate, the already-proven
position causes no additional push. These are visibility dependencies, not transactions: separate
RPC calls may observe each other's intermediate commits, and atomic state changes still require a
SQLite transaction. One output gate may touch several local objects and pushes each object log
independently. Calls routed to a peer retain their implicit per-call durability boundary rather than
extending the caller's local output scope across the network. A combined result can wait for all of
those calls, but neither form provides cross-object atomicity.

Object factories use the Durable Object-style SQL surface:

```ts
export function createCounterObject({ state }: NodeRuntimeObjectContext) {
  return {
    increment() {
      state.storage.sql.exec("UPDATE counters SET count = count + 1 WHERE id = 1");
      return state.storage.sql
        .exec<{ count: number }>("SELECT count FROM counters WHERE id = 1")
        .one().count;
    },
  };
}
```

Calls outside `runWithOutputGate()` retain an implicit per-call gate, so a direct public RPC cannot
return unconfirmed state, but their namespace handles remain caller-owned and must be disposed.
Initialization and drained `waitUntil` work retain immediate worker-owned durability boundaries.
Authority-bound alarm installation, deletion, and successful consumption are stronger immediate
coordination barriers: they write a control reconciliation marker, push the object database, and
publish the resulting alarm discovery state before the storage call returns. This can push earlier
writes before the enclosing output gate closes. A namespace handle acquired inside an output scope
is disposed when that scope closes. Returned `RpcTarget` capabilities inherit the output scope in
which they were created and reject use after that scope closes, but applications still dispose those
returned capabilities explicitly. This is not a general side-effect gate: outbound fetches, callback
arguments, and response-stream work performed after the handler returns are not transactional or
delayed. Detached unregistered work remains unsupported.

The Graft runtime requires Node.js 24.11 or newer. `state.storage.sql.exec()` accepts one
application statement and does not expose transaction control, `PRAGMA`, `ATTACH`, or tables whose
names begin with `node_runtime_`. The Graft configuration must be established before the extension
loads, use `make_default = false`, and use a distinct `data_dir` for each container cache. Graft
0.2.1 is pinned; its VFS uses `journal_mode = MEMORY`, not WAL. The filesystem remote supports local
scenarios, while deployment can supply Graft's S3-compatible configuration. See
`docs/stateless-graft-runtime-plan.md` for the remaining control plane, fencing, routing, and
scheduling work.

### Caller-coordinated cleanup

Before calling `cleanup()`:

1. Stop accepting application requests and stop the alarm scheduler or other RPC producers.
2. Await every outstanding application RPC, including pipelined calls, returned-capability calls,
   and their callbacks. Unawaited calls are not guaranteed to finish during cleanup.
3. Finish or cancel request and response body streams. Do not use previously acquired object or
   capability handles once cleanup begins.

`cleanup()` is idempotent. It rejects new namespace lookups and runtime scheduling operations, waits
for object-local operations and background work registered with `state.waitUntil`, closes storage,
and terminates workers. It does not provide session-wide RPC draining or admission control for
existing handles. Racing application calls or streams with cleanup is unsupported: those operations
can fail or lose writes even when cleanup succeeds. Register background work with `state.waitUntil`;
detached work is not covered by cleanup.

Cap'n Web is used unmodified. Worker shutdown uses private control RPC after the caller has finished
application work; no custom shutdown envelope or dependency patch is required.

## Node runtime scenarios

Import from `@fragno-private/backoffice-node-runtime/node-runtime-scenario`. Scenarios use the same
authority-bound Graft runtime as production, with a temporary filesystem remote/cache and an
atomically shared manual clock. Leases, fencing, output gates, and alarm reconciliation remain
active. No HTTP listener, application server, or background polling timer is started.

Create one environment per process because the native Graft configuration is process-global.
Provision a separate storage locator per independent scenario; reuse a locator for restart tests.
Stop every runtime before cleaning up the environment.

```ts
import { afterAll, assert, expect, test } from "vitest";
import type { createCounterObject } from "./counter-object";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

const environment = await createNodeRuntimeScenarioEnvironment();
afterAll(() => environment.cleanup());

test("fetch and alarms share the counter worker", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "scheduled-counter",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "disabled" },
      objects: {
        COUNTER: defineNodeRuntimeObject<typeof createCounterObject>(
          new URL("./counter-object.ts", import.meta.url),
          "createCounterObject",
        ),
      },
      server: ({ objects }) => ({
        async fetch(request) {
          const counter = objects.COUNTER.get("one");
          if (request.method === "POST") {
            await counter.schedule();
            return new Response(null, { status: 204 });
          }
          return await counter.fetch(request);
        },
      }),
      steps: ({ server, alarms, clock }) => [
        server.fetch(new Request("https://scenario.test/", { method: "POST" }), (response) => {
          assert.equal(response.status, 204);
        }),
        alarms.tick(),
        clock.advanceBy(100),
        alarms.tick(),
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          expect(await response.json()).toEqual({ memoryCount: 1, count: 1 });
        }),
      ],
    }),
  );
});
```

- `given(label, run)`, `when(label, run)`, and `then(label, run)` create labeled custom steps. Their
  context exposes `server`, typed `objects`, `alarms`, `background`, `activations`, and `clock`.
- `server.fetch(request, assertResponse)` runs the routing handler inside
  `runtime.runWithOutputGate()`, then checks the durable response.
- `alarms.tick()` renews authority and scans durable alarm work, activating only serviceable objects
  and delivering due alarms. It does not drain unrelated `waitUntil` work.
- `background.drain()` explicitly waits for registered `waitUntil` and initialization work across
  resident workers. Use it before assertions that require background completion; shutdown also
  drains registered work. Empty drains and alarm polls do not reset the idle-eviction deadline.
- `clock.advanceBy(ms)` changes the clock in all workers without delivering alarms or renewing
  authority. Scenario runtimes use a 60-second lease with a 5-second safety margin; tick before the
  serving window expires unless testing terminal fencing.
- `objectEviction` configures the same eviction policy as production. With a manual policy,
  `activations.sweepIdle()` runs an explicit idle sweep; elapsed time alone does not evict workers.
- `concurrent(alarms.tick(), alarms.tick())` tests overlapping polls without creating duplicate
  object instances. Every branch settles before the scenario proceeds or cleans up.

The previous `processors` option and inline object factories have been removed. There are no
separate processor instances or runtime names: each object's worker owns both serving and
processing.

Scenarios return a journal of completed top-level steps. Failures name the scenario and step and
preserve serialized RPC error causes. Each scenario closes workers and connections and releases
healthy claims on success or failure. The environment's `cleanup()` removes its temporary directory
after all scenarios finish. Backoffice's authorization envelopes, object registry, Fragment
services, and durable-hook fragment composition are not installed by this harness.

Package tests exercise the built worker entry point, so build before running Vitest directly.
`pnpm exec turbo run test --filter=@fragno-private/backoffice-node-runtime` handles that dependency.
See `src/testing/node-runtime-scenario.test.ts` and `src/runtime/node-object-runtime.test.ts` for
serialization, capabilities, streaming fetch, alarm retries, persistence across restarts, cleanup,
and worker failures.
