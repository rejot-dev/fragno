## Verdict

**The main bottlenecks are control-plane I/O and resident-worker overhead—not application SQL.** I’d
preserve the durability protocol, but simplify lifecycle management and reduce repeated control
reads.

Reviewed the current worktree, including uncommitted changes. Build, typecheck, and **73 tests
passed**. Additional probes reproduced three issues. No repository source changes.

Paths below are relative to `packages-private/backoffice-node-runtime/src/`.

## Findings

### 1. P1: One blocked worker can fence the entire node

`runtime/node-object-runtime.ts:509–538`

Lease renewal waits for **every worker** to acknowledge `advanceNodeAuthorityWindow()` before
scheduling the next renewal. A worker blocked in synchronous application code or Graft I/O therefore
stalls renewal for otherwise healthy objects.

**Reproduced:** with a two-second lease, blocking one worker for four seconds caused the whole node
to self-fence. Another object remained responsive before fencing.

**Change:** schedule node renewal independently of worker acknowledgements. Bound each worker’s
acknowledgement window and retire only the worker that misses it.

### 2. P1: Alarm polling prevents idle eviction

`runtime/node-object-worker.ts:133–152,435–440`  
`runtime/node-object-runtime.ts:1048–1051`

Every tick drains `waitUntil` on every resident worker. That runs through activity tracking, which
updates the last-activity timestamp **even when nothing happened**.

**Reproduced in both local and authority-bound Graft runtimes:** polling every 500 ms prevented
eviction with a 1,000 ms idle timeout. Stopping polling allowed eviction.

With normal polling enabled, resident workers can effectively accumulate indefinitely.

**Change:** distinguish application activity from housekeeping. Empty drains and readiness checks
must not refresh idle time.

### 3. P2: Readiness stays healthy after terminal fencing

`runtime/node-object-runtime-host.ts:274–285`

Readiness checks the host lifecycle, not runtime authority.

**Reproduced:** authority was `fenced`, application requests returned `503`, but `/_runtime/ready`
returned `200`.

**Change:** readiness must require both a serving host and serving node authority.

### 4. P2: Background work creates node-wide alarm head-of-line blocking

`scheduling/node-alarm-scheduler.ts:27–38,59–70`

A poll waits for global `waitUntil` drains, and subsequent polls are skipped while it remains
active. One long-running background task can delay unrelated alarms indefinitely. Authority-bound
discovery also waits for its entire selected work page.

**Change:** production alarm scheduling should service objects independently with bounded
concurrency. Keep “drain everything” as an explicit scenario/shutdown operation, not a recurring
scheduling barrier.

## Performance characteristics

### Graft changes how to interpret the costs

A fresh clone is **not a full database download**: Graft loads pages lazily and caches them. Push
also rolls multiple local commits together. Conversely, competing commits from the same snapshot can
conflict; losing speculative state cannot simply be treated as authoritative. These support keeping
your output gates and receipt-backed command replay.

### Control reads are disproportionately expensive

`graft/graft-control-store.ts:806–827`  
`rpc/node-peer-rpc.ts:368–401`  
`rpc/node-peer-object-forwarder.ts:66–72`

Every control read closes the previous connection and creates a uniquely tagged clone, followed by
`pull`. Peer authority checks repeat that operation around multiple layers of forwarding.

Measured using Graft’s tag inventory:

| Operation                                                                 | Fresh control clones |
| ------------------------------------------------------------------------- | -------------------: |
| First call through a new handle to a resident local object                |                    1 |
| Call through a retained peer handle                                       |                    3 |
| First call through a new peer handle, with connection already established |                    9 |
| Lazy provisioning and first activation of a simple object                 |                   15 |

These counts are **not network-request counts**. Nevertheless, the synchronous clone/pull/read
operations sit on the routing thread, so backend latency blocks unrelated ingress and renewal
processing.

**Highest-value optimization:** consolidate related reads into one authoritative snapshot; separate
reusable clean read replicas from speculative command clones. Move native control I/O off the
ingress thread. Preserve fresh-state retry semantics after command conflicts.

### One thread per object is expensive

`runtime/node-object-runtime.ts:398,541–561`

There is no resident-worker capacity limit. Eviction is the only resource control, and currently
suffers from finding 2.

In a local probe with a tiny object factory, **32 resident objects added approximately 500 MiB RSS**
over baseline. That is a measurement of this environment, not a universal per-worker constant.

Renewal broadcasts, eviction sweeps, and background drains also scale with resident-object count.
Local-mode alarm discovery additionally activates every persisted identity, even without a due
alarm.

I’d add admission/capacity limits before attempting a worker-pool redesign. Pooling changes
isolation and lets one synchronous operation block multiple objects.

### Alarm mutations are coordination-heavy

`graft/graft-object-alarm-coordinator.ts:32–65`

An alarm change normally requires:

1. A durable control reconciliation marker.
2. An object-log push.
3. A durable control publication.

These are sequential durability barriers, and alarm mutations serialize within each object.
Activation also performs alarm reconciliation even for objects without alarms.

Furthermore, leases, claims, alarm publications, and command receipts all write the **same control
log**, creating a shared contention point. Command retries are bounded but immediate. Receipts are
inserted without a retention mechanism.

I would not remove the reconciliation protocol casually; first reduce redundant activation work and
measure control-log contention.

### Small local measurements

Node 26.10.0, filesystem Graft backend, loopback peers, 30 sequential samples. These are
illustrative—not production capacity estimates.

| Operation                                      |  Median |
| ---------------------------------------------- | ------: |
| Retained local handle: inspect in-memory state | 0.07 ms |
| Fresh local handle: same inspection            | 0.40 ms |
| Retained peer handle: same inspection          | 0.64 ms |
| Fresh peer handle: same inspection             | 1.80 ms |
| Retained local handle: durable KV write        | 0.65 ms |
| Retained local handle: alarm installation      | 2.65 ms |

The difference between retained and fresh handles is already visible without remote-storage network
latency.

## What I would simplify

### 1. Remove inherited runtime machinery

`runtime/local-durable-objects.ts:92,323`  
`sqlite/sqlite-durable-object-state.ts:71`

Each worker owns exactly one object, yet instantiates a multi-object namespace with maps, restart
support, and coordination machinery.

Replace that with a **single-object activation** abstraction. Preserve event gating and
returned-capability handling.

I found no repository consumers of this package’s `InMemoryDurableObjectState` or
`registerRuntimeRefresh`; those are immediate deletion candidates rather than abstractions to
maintain.

### 2. Reduce backend variants

`runtime/node-object-runtime.ts:165–242`

There are local SQLite, single-owner Graft, and authority-bound Graft runtime paths. The
single-owner Graft path is explicitly a compatibility path and primarily serves tests.

Unless it has an independent product requirement, migrate those scenarios and remove it. This
eliminates a separate lifecycle/durability mode.

### 3. Give pending-work tracking one implementation

`runtime/local-durable-objects.ts`  
`sqlite/sqlite-durable-object-state.ts`  
`graft/graft-durable-object-state.ts`

`waitUntil`, blocking-work sets, draining, and settlement notifications are substantially
duplicated. A small shared lifecycle component would reduce drift—including the activity-accounting
problem—without introducing a generic storage framework.

### 4. Simplify the local persistence model

`sqlite/sqlite-object-storage.ts`  
`sqlite/managed-node-runtime-object-database.ts`

Local mode stores KV/alarms in shared `objects.sqlite`, while application SQL uses per-object
databases and a different SQLite binding.

Consider putting KV, alarms, and SQL in the same per-object schema for both backends. Keep only the
discovery index separate. That would reduce backend divergence and shared-KV write contention.

### 5. Fix smaller query inefficiencies afterward

- Prefix listing reads **all KV rows**, then filters in JavaScript:
  `graft/graft-durable-object-state.ts:226–239`.
- SQL cursors eagerly materialize every row: `sqlite/managed-node-runtime-object-database.ts:217`.
- Every `WITH` query takes the mutation path, including read-only CTEs:
  `sqlite/managed-node-runtime-object-database.ts:103–113`.

**My order:** fix renewal isolation and eviction → fix readiness and alarm scheduling → reduce
control-read amplification → establish capacity limits → remove redundant runtime variants and
machinery.

## Implementation update — October 4, 2026

The sections above preserve the original review. The changes below have since been implemented in
`packages-private/backoffice-node-runtime`; earlier line numbers, backend descriptions, and baseline
measurements should not be read as a description of the updated implementation. Performance probes
have not been rerun against the consolidated runtime.

### Correctness fixes completed

- **Renewal isolation:** node lease renewal no longer waits for worker acknowledgements. Each worker
  has at most one authority-extension RPC in flight and one coalesced latest pending window. Late
  extensions cannot revive an expired activation; the affected worker is retired while healthy
  siblings can continue serving.
- **Idle eviction:** maintenance protects workers from concurrent eviction without refreshing their
  idle deadlines. Empty alarm polls and background drains no longer keep activations resident.
  Pending registered work prevents eviction, and its settlement starts a fresh idle window.
- **Readiness:** `/_runtime/ready` requires both a serving host and serving node authority. It
  returns `503` after expiry or fencing, including when readiness is the first request to observe
  expiry.
- **Alarm/background isolation:** production polling no longer drains all workers' `waitUntil`
  promises. Scenarios have an explicit `background.drain()` operation; shutdown still drains
  registered work. A blocked background task no longer prevents another object's due alarm from
  being delivered. Bounded per-object scheduling and removal of the selected-page completion barrier
  remain separate follow-up work.

Regression coverage uses real workers/storage, shared manual clocks, explicit barriers, and cleanup
that releases blocked work. It covers renewal recovery before expiry, rejection after expiry,
healthy-sibling availability, idle eviction, background settlement, readiness, and alarm isolation.

### One authority-bound Graft implementation

- Migrated local scenarios, runtime lifecycle tests, managed-database tests, output-gate concurrency
  scenarios, and remaining single-owner fixtures to authority-bound Graft.
- Added `createNodeRuntimeScenarioEnvironment()` and `createNodeRuntimeScenarioRuntime()`. Tests use
  temporary filesystem remotes/caches and real control-log provisioning, leases, fencing, output
  gates, and alarm reconciliation—not a reduced test-only durability model. One environment is
  shared per process, with isolated control logs per independent scenario and explicit cleanup.
- Removed the local SQLite and unbound single-owner Graft constructors, backend-selection branches,
  `InMemoryDurableObjectState`, and the separate SQLite state, storage, coordination, and connection
  configuration modules. Removed their package exports/build entries and the runtime package's
  `better-sqlite3` dependencies.
- Made authority, routing, and alarm coordination mandatory. SQL, KV, and authoritative alarms now
  share each object's fenced Graft database. Durable control-work scans replace activate-everything
  discovery; the alarm scheduler directly invokes the consolidated alarm drain.
- Updated the README, schema inventory, and runtime plan. Backoffice's separate application-owned
  runtime was not migrated by this package-level change.

This removes backend-specific pending-work implementations rather than extracting a generic
multi-backend lifecycle framework. It does **not** establish fully RAM-only Graft operation or
cross-worker sharing of a memory remote; local scenarios deliberately use filesystem remotes.

### Additional issues exposed by migration

The authority-bound output-gate scenarios exposed premature flushing during request preparation.
Admission now checks authority and waits for initialization without opening an empty durable event
that could push another request's unconfirmed writes. Explicit output boundaries retain ownership of
durability checks.

Parallel activation also reproduced a native Graft 0.2.1 abort reporting a remote-LSN monotonicity
violation. Control-store refreshes and commands now serialize across worker threads sharing the
process-wide native cache. Lock waits are bounded, and worker exit releases any lock it held.
Object-log pushes never hold this lock, preserving the blocked-object-push renewal regression.
Independent nodes still use optimistic conflicts and receipt-backed replay. This is a correctness
safeguard, **not** control-I/O isolation: synchronous control work and lock contention can still
block the calling thread.

### Validation and remaining work

Latest code validation passed build, typecheck, lint, and tests for both the runtime package and its
demo consumer: **79 runtime tests across 18 files**, plus the demo's node and fleet scenarios.
`git diff --check` was clean. The count decreased from the earlier 80-test baseline because the
connection-configuration test for the deleted SQLite backend was removed; the behavioral regression
coverage remains.

The next structural simplification is replacing each worker's multi-object namespace with a
**single-object activation**, preserving event/output gating and capability lifetimes. Control-read
consolidation, native control-I/O isolation, resident-worker capacity limits, control-log contention
and receipt retention, alarm retry/backoff, and the smaller SQL/KV query inefficiencies remain open.
No worker pooling or production throughput improvement has been claimed.

## Single-object activation update — October 4, 2026

The worker-local namespace simplification is implemented. `runtime/node-object-activation.ts`
creates one `NodeObjectActivation` owning its object instance, concrete Graft state, output scopes,
alarm delivery, activity tracking, pending-work draining, and shutdown. `node-object-worker.ts` is
now the MessagePort control adapter rather than the owner of a second lifecycle implementation.

Removed `LocalDurableObjectNamespace`, its object-instance map, lazy lookup and restart paths, the
separate `ProcessLocalObjectExecutionCoordinator`, and the intermediate method-wrapping proxy. The
obsolete `local-durable-objects` package export/build entry and unused background-drain hooks are
also gone. Alarm installation types now live with Graft alarm coordination rather than a
backend-neutral namespace contract. Author-facing object definitions and state APIs are unchanged.

Handlers still interleave; this change does not serialize events. Handler and returned-capability
calls share one activity tracker, while maintenance still avoids refreshing idle deadlines.
Initialization, output-gate durability, fencing, alarm reconciliation, capability scope checks, and
graceful draining retain their existing boundaries. The new scenario holds a capability call open
while another handler runs, verifies that an idle sweep cannot evict it, then checks eviction,
stale-capability rejection, and durable recovery after the call completes.

Validation passed **80 runtime tests across 19 files**, including all 79 previous tests, plus build,
typecheck, lint, and the demo scenarios. An initial combined runtime/demo run exceeded an existing
five-second process-scenario timeout. A later run exposed a missing worker-delivery barrier in the
renewal scenarios: a completed push or node tick does not acknowledge an asynchronous worker lease
extension. Those scenarios now cross the worker RPC channel before advancing manual time past the
old lease; production renewal behavior is unchanged.

There is still **one thread per active object**. No material memory reduction or throughput gain is
claimed. The next substantive runtime task is isolating synchronous control-plane I/O from ingress
and node renewal, followed by reducing repeated control reads and adding residency capacity limits.

## Control-read implementation update — October 4, 2026

Following measurement, control-read reduction was prioritized over moving unchanged synchronous work
into a dedicated worker. Steps 1 and 2 are implemented; the resident-activation routing fast path
remains deferred.

### Reusable clean read snapshots

`graft/graft-control-read-replica.ts` owns a lazy, query-only connection for each control store.
Every fresh read pulls before querying, validates the control schema, and completes its related
queries synchronously under the existing native-cache lock. Successful reads reuse the connection
and local volume. Failed pulls, queries, or schema checks discard the reader and fail closed.
Routing and peer authentication now share the node's store rather than constructing a store for
every authority assertion. Each thread owns its own connections, and store shutdown closes them.

Commands retain separate speculative clones, transactions, durable receipts, conflict retries, and
uncertain-push recovery. Neither failed nor successful command state is reused as a trusted read
snapshot. `GraftRuntimeDatabaseOperations` now requires a main-thread `control` collaborator
alongside `provisioning` and the importable `worker` definition; existing consumers were migrated.

### Lease-bounded peer authority

`rpc/node-peer-authority.ts` gives each authenticated session a confirmed caller lease window. Every
existing admission and forwarded-result assertion remains, but checks local epoch and monotonic
deadlines inside that window. Expiry requires a fresh matching lease. Clock skew is subtracted,
storage-read time counts against the deadline, and failed confirmation cannot extend it. The network
remembers conservative epoch progress across sessions, so wall-clock rollback and reconnection
cannot revive an expired lease. Session closure releases its window without a global peer-identity
cache.

This relies on the current extension-only lease protocol and immutable node identities, not an
arbitrary TTL. An early-revocation protocol would require revisiting this optimization. Exact
object-route validation, worker fencing, output gates, and capability lifetimes are unchanged.

### Measured results

Repeated the earlier probe against the actual implementation: two authority-bound hosts in one
process, a real object worker, filesystem Graft, loopback peer WebSockets, a frozen shared manual
clock, 20 warmups, and 200 measured calls per case. Tracing ran separately from timing.

| Operation                           | Previous median | Implemented median | Warm control pulls before → after |
| ----------------------------------- | --------------: | -----------------: | --------------------------------: |
| Fresh local handle                  |        0.252 ms |           0.185 ms |                             1 → 1 |
| Retained peer handle                |        0.543 ms |           0.153 ms |                             3 → 0 |
| Fresh peer handle, existing session |        1.490 ms |           0.392 ms |                             9 → 2 |
| Empty alarm scan                    |        0.382 ms |           0.065 ms |                             1 → 1 |

These warm paths create no new control clones. The two remaining fresh-peer pulls are sender routing
and receiver exact-route validation. Cold local provisioning/activation uses seven control clones
instead of fifteen, but still performs fifteen pulls and five control pushes. Alarm installation
retains two control commands and its existing durability barriers. Clone/pull counts are native
operations, not full-download or network-request counts. These local timings are diagnostic results,
not production capacity claims.

Timing and trace artifacts are `/tmp/backoffice-control-read-implemented-benchmark.log` and
`/tmp/backoffice-control-read-implemented-trace.jsonl`; the earlier comparison is
`/tmp/backoffice-control-read-benchmark-repeat.log`.

### Validation and remaining scope

Validation passed **100 runtime tests across 21 files**, including the previous 80 tests, plus
runtime/demo builds, typechecks, lint, and the demo's node/fleet scenarios. New scenarios exercise
real storage, independent-process reader freshness, query-only protection, failed refreshes, schema
rejection, uncertain commands, receipt replay, bounded clone/pull counts, peer renewal, blocked-call
expiry and recovery, read latency, clock skew, rollback/reconnect, changed caller incarnations,
stale routes, and returned capabilities. Blocked work is released during cleanup.

One initial assertion incorrectly expected a retained handle to survive stale-route rejection; the
existing transport discards that session. The scenario now verifies recovery through a fresh handle
instead of changing transport semantics.

No dedicated control worker, asynchronous driver, generic TTL cache, resident-object routing fast
path, or worker pooling was added. Control I/O and cache-lock waits remain synchronous. Reassess
isolation with representative remote-storage latency after these reductions; cold activation,
resident capacity, alarm backoff, control-log contention, and receipt retention remain open.
