# Reimplementing a Durable Object / cell runtime

An implementation outline based on celld. Use this to build an equivalent architecture elsewhere,
not as a complete specification of the Cloudflare API or celld's wire formats.

**Core design:** give each stateful object one authoritative owner, keep that owner authorized
through a renewable process lease, fence each storage writer with an ownership epoch, and
acknowledge effects only after the required durability proof.

A lease alone is not a distributed lock that physically stops expired code. Safety also requires
fencing, recovery, and careful handling of uncertain operations.

## 1. Components and terminology

| Component             | Responsibility                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Cell / Durable Object | Stable identity, private storage, an in-memory instance, and event handlers.                           |
| Node                  | One runtime process that can own and execute many cells.                                               |
| Fleet                 | Nodes sharing a coordination store and durability protocol.                                            |
| Worker                | Application entrypoint that receives a request and calls cell stubs.                                   |
| Ingress               | HTTP listener/gateway that accepts client requests; need not be the cell's owner.                      |
| Stub                  | Client-side proxy naming a cell, not a permanent binding to a node or JS instance.                     |
| Isolate               | JS execution environment inside a node; may contain multiple cells.                                    |
| Turn                  | Host-controlled entry into the JS engine to invoke code or settle an operation and process microtasks. |
| Ownership epoch       | Monotonically increasing, per-cell writer generation.                                                  |
| Process generation    | Identity of one node-process incarnation, distinct from the cell epoch.                                |

```text
Browser -> ingress on Node A -> Worker -> cell stub
                                      -> ownership resolver
                                         -> local execution on A
                                         -> authenticated forwarding to Node B

Shared store: node leases + per-cell ownership + durable cell data + wake entries
```

The JS engine executes code and promises. The host supplies I/O, event admission, storage,
ownership, and durability. Node.js already supplies an event loop; a reimplementation need not
reproduce celld's Rust/V8 embedding machinery.

## 2. Invariants to preserve

1. **Unique claim:** ownership changes use atomic conditional creation or compare-and-swap (CAS),
   never an unconditional read-then-write.
2. **Writer identity:** every activation and storage proof is bound to a cell and its ownership
   epoch. Never reuse an exhausted epoch counter.
3. **Process identity:** delayed operations from a previous process or object instance cannot borrow
   a replacement's authority.
4. **Lease continuity:** a renewal must be confirmed while the previous lease is still valid. An
   expired process reacquires through recovery rather than resuming old authority.
5. **Fail closed:** an unreadable ownership/lease record is an error, not proof that the owner is
   absent or dead.
6. **Durable acknowledgement:** a response/effect cannot reveal a commit that the durability
   protocol has not covered.
7. **Complete restore:** an activation includes every acknowledged write in its recovery lineage.
   Failure to obtain required recovery data blocks activation.
8. **Safe alarm discovery:** an acknowledged alarm remains durably discoverable until consumption or
   replacement is proven safe.

These are guarantees about authoritative ownership, storage, and acknowledgement. They do not imply
that a paused former owner can never resume JS instructions, or that arbitrary external services
execute side effects exactly once.

## 3. Persistent directory and storage contracts

There is no need for one central directory table. Keyed records are enough:

```text
nodes/<node-id>.json                  Node authority and private address
cells/<cell-id>/own.json              Current owner and fencing epoch
cells/<cell-id>/ltx/e<epoch>/...       celld's epoch-separated storage history
wake/entries/<minute>/<cell>/<id>     Immutable alarm discovery publications
wake/retired/<cell>.json              Evidence authorizing obsolete-entry cleanup
```

Illustrative portable records; these field names/types are **not celld wire formats**:

```json
{
  "nodeId": "node-a",
  "processGeneration": "random-process-token",
  "address": "node-a:8081",
  "expiresAtMs": 1800000000000
}
```

```json
{ "ownerNodeId": "node-a", "epoch": "42" }
```

Keep the record's CAS version/ETag from the storage response separately. Use an integer
representation that does not lose precision: a JS `Number` cannot represent every 64-bit epoch. A
decimal string plus `BigInt` is one option.

The simplest process-identity policy is a unique node ID per process incarnation. Supporting a
stable node ID across restarts requires generation checks and a predecessor-recovery protocol; a
restarted process is not automatically entitled to its predecessor's cells.

### Coordination-store interface

Provide operations with explicit results:

- `readCoordinationRecord(key)` -> record + version, absent, or error.
- `createCoordinationRecordIfAbsent(key, body)` -> applied, rejected, or uncertain.
- `compareAndSwapCoordinationRecord(key, version, body)` -> applied + new version, rejected, or
  uncertain.

Celld requires working conditional writes and read-after-write consistency. Its replication also
requires correct ranged reads; alarm discovery needs listing. Qualify the actual backend rather than
assuming an S3-shaped API supplies these properties.

A timeout can mean that a write applied and its reply was lost. Preserve **uncertain** as a distinct
outcome. Never silently convert it into rejection or success.

## 4. In-memory state

A node should keep:

- Node authority state and the last confirmed lease/version/deadline.
- Per-cell lifecycle state, ownership epoch, storage handle, and JS instance generation.
- Per-cell single-flight resolution/activation and its waiting requests.
- Cached remote routes and cached node leases with bounded reuse deadlines.
- Input-gate holders/waiters, pending writes, and output/durability barriers.
- In-flight operations, cancellation state, resource accounting, and local alarm timers.

A useful lifecycle outline is:

```text
Inactive -> ReadingOwner -> [ReadingNodeLease]
         -> Acquiring -> Restoring -> Starting -> Resident
         -> Remote
Resident -> ProvingDurability -> Stopping -> Dormant or Inactive
Any owned state -> Fenced
```

`Remote` means the local node knows a forwarding route, not that it owns the cell. `Dormant` means
the runtime instance is absent; storage and possibly ownership remain.

Use one serialized lifecycle decision-maker per node, or equivalent synchronization. Keep slow
store/network operations outside it and return their results as events. Identify every operation so
late results can be rejected after its state has changed.

## 5. Node startup, renewal, and self-fencing

### Acquire node authority

1. Choose the process identity and advertise a private peer address.
2. Read any prior node record. If reusing an identity, complete the required predecessor recovery
   before replacing it.
3. Create or CAS the lease record with a deadline computed for that attempt.
4. On uncertainty, reread and reconcile the exact process identity and published record.
5. Become authoritative only after a valid, unexpired acquisition is confirmed.

**Completion criterion:** authority is confirmed for this process, not merely requested.

### Renew before expiry

Celld's default TTL is 10 seconds (`CELLD_TTL_MS`); its normal renewal cadence is approximately TTL
/ 3. These are tuning choices, not universal safe values.

- Serialize lease updates, or reconcile delayed concurrent updates explicitly.
- Compute expiry when the write attempt begins. Receiving a slow response does not grant a fresh
  full TTL.
- Keep using the previous confirmed deadline while an update is pending.
- Reconcile uncertain/rejected renewals by reading the stored record. A rejection can be caused by
  an earlier delayed renewal from this same process.
- Compare all authority-relevant identity fields, including recovery state if the record carries it.
- Retry only within the remaining authority window, with bounded I/O deadlines.

**Completion criterion:** confirmation extends continuously valid authority; a renewal completed
after the old authority ended is not permission to continue serving.

### Fence on lost authority

On expiry, missing/replaced authority, or unreconcilable loss:

1. Enter a terminal `Fenced` state.
2. Refuse new execution/ownership and retire local instances.
3. Fail or cancel outstanding work where possible; reject its later storage operations and effects.
4. Prevent stale outputs from obtaining an acknowledgement proof.
5. Stop/restart the process through a supervisor.

Celld halts with exit code 3. A different implementation can use a different shutdown mechanism, but
must preserve authority loss as terminal for that incarnation.

### Time assumptions

Use monotonic elapsed time for local budgets; celld also publishes a wall-clock expiry and checks
both bounds in its watchdog path. Account for drift, clock adjustments, scheduling delays, and VM
suspension. State your timing assumptions explicitly.

A timer is a cleanup/liveness mechanism, not the only authority check. Validate authority at
admission and effect boundaries. In pure JS, a blocked event loop cannot run its expiry timer on
time; external fencing remains necessary.

## 6. Resolving a stub call

The Worker sends a logical call to the host. The host resolves a **cell ID**, not the hostname in
the user's fetch URL.

### Fast path

| Local knowledge                                             | Result                   |
| ----------------------------------------------------------- | ------------------------ |
| Resident cell, valid local node authority, accepting events | Local dispatch.          |
| Remote route whose observed lease deadline is still valid   | Forward to cached owner. |
| Resolution/activation already in progress                   | Join its waiters.        |
| Unknown/dormant/expired route                               | Begin the slow path.     |

Cached lease renewal is not implied by a healthy peer connection. Refresh the observation when its
deadline passes; invalidate stale-owner responses immediately.

### Slow path

1. Read `cells/<cell>/own.json` and retain its CAS version.
2. If another node owns it, read/reuse that node's lease and private address.
3. If the owner is live and compatible, return a remote route.
4. If the record is absent or unowned, prepare a claim.
5. If the owner is dead, recover any acknowledged replication tail before preparing takeover.
6. If this node owns a dormant cell, reactivate through a fresh ownership epoch.
7. Claim with conditional creation or CAS against the exact record observed.
8. Restore/open the correct durable lineage, start the runtime, and publish residency.
9. Complete waiting routes as local only after the runtime is available.

Read failures stop resolution. A failed claim rereads ownership. An uncertain claim is reconciled:
if the stored identity/epoch matches the attempted claim, continue; otherwise resolve again within a
bounded retry policy.

The first claim uses epoch 1; subsequent acquisitions advance the persisted epoch. Ownership release
keeps the epoch instead of deleting its history. Celld advances epochs for ordinary same-node wakes
as well as remote takeovers.

Normally the receiving node claims an unowned cell if it has capacity. Load-based peer selection is
an optional placement optimization: the selected peer is a candidate and must still win ownership.
The cell ID does not permanently hash to a node.

**Completion criterion:** resolution returns a usable local runtime or a bounded remote route, not
just a successfully written ownership record.

## 7. Storage fencing: choose an enforceable design

**A valid-looking local lease flag is insufficient.** A process can pause after checking it and
resume after another process has taken over.

### Option A: authoritative transactional storage

For a simpler new implementation, use a store that can atomically validate the current cell
epoch/process authority and apply a mutation.

A transaction must serialize against ownership changes, using the backend's appropriate
locking/conditional-update mechanism. A plain ownership read followed by an unrelated write is not
atomic fencing. Restore and read visibility must follow the same authoritative state.

This may be easier than reproducing celld's local-SQLite/object-store replication protocol.

### Option B: celld-style epoch-separated replication

- Each activation writes into its own epoch prefix; an old writer cannot overwrite the new epoch's
  objects.
- Keep explicit recovery lineage and committed positions. A newly claimed epoch initially has no
  data: restore its correct predecessor baseline rather than treating it as an empty database.
- Before bucket-backed acknowledgement, prove the relevant commit durable and verify that the
  ownership record still names this owner and epoch.
- If acknowledging through followers, seal the old replication session during takeover so it cannot
  issue new valid follower proofs.
- Restore every required acknowledged tail before exposing the replacement runtime.

Prefix isolation alone does not select a correct restore history or prove that responses are safe.
Implement the acknowledgement and recovery protocols together.

For arbitrary remote APIs, use idempotency keys or a transactional outbox to manage retries, and
receiver-enforced fencing where stale authority must be rejected. Deduplication alone does not
reject a distinct stale operation. A local ownership check cannot atomically authorize an unrelated
third-party operation; an already sent operation cannot be unsent by lease expiry.

## 8. Event execution and input gates

A request can span multiple turns as I/O completes. Celld enters V8 under a lock, installs
event/storage context, executes JS and microtasks, collects host operations/outputs, and releases
the lock. Other events can interleave between turns.

### `blockConcurrencyWhile`

Maintain an object-level holder identity, nesting/lifetime bookkeeping, and waiting deliveries:

1. Request acquisition synchronously, before yielding.
2. Queue behind another holder without blocking its required I/O completions.
3. Run the callback with event identity preserved across awaits.
4. Keep the hold until all nested critical-section work finishes, including nested blocks the
   callback did not await.
5. Release in `finally`; on failure, reset the instance and fail the old instance's queued
   deliveries.
6. On cancellation/retirement, abandon the matching hold. Stale releases cannot open a replacement
   holder's gate.

Celld limits each block to 30 seconds. A promise timeout rejects the caller; it does not terminate
the losing callback. Bind late storage/effects to the retired instance generation and reject them.

Constructor blocks also delay that instance's initial readiness. Callback re-entry is a separate
compatibility concern: callbacks originating inside a block may need an explicit token to re-enter
instead of deadlocking behind it.

### Pure-JS implementation choices

- **Coarse MVP:** serialize whole events from handler entry. Simpler, but less concurrent than DOs;
  callbacks/self-calls can deadlock, long awaits block the object, and background work must be
  included or retired safely.
- **Concurrent runtime:** control incoming delivery and asynchronous completion delivery. Gating
  only new handlers does not pause continuations of handlers already running.

`AsyncLocalStorage` can carry identity in Node.js but does not schedule promises. Ordinary JS cannot
replace native `await` scheduling or explicitly perform the engine's microtask checkpoint. Exact
compatibility may require controlled I/O APIs, code transformation, or an embedded engine.

## 9. KV and transaction concurrency

Celld's `_cf_KV` is an ordinary SQLite table, not a distributed lock table. Storage handles are
accessed under the isolate's turn lock. The async-shaped KV methods perform local synchronous SQLite
work; they do not take an input-gate hold for a remote cache miss.

`put()` queues serialized values in memory. Reads and boundaries flush pending writes; a multi-key
flush is atomic through a transaction or a savepoint.

For a port with genuinely asynchronous storage, define operation admission and completion ordering
explicitly. `await` always permits microtask continuation scheduling; single-threaded JS does not
automatically make arbitrary read-modify-write sequences atomic.

- Individual mutations/batches need storage atomicity.
- Multi-operation updates acquire exclusivity **before reading**, not at the first write.
- `transaction(async callback)` uses a real database transaction plus object-level exclusion;
  competing transactions are serialized, nested transactions use savepoints, and failures roll back.
- Protect conflicting work admitted before the input gate closed too. A reentrant storage
  lock/transaction owner is one possible design; a new-handler gate alone is insufficient for
  existing continuations.
- `transactionSync(callback)` must finish its database transaction within the synchronous callback.
- Callback failure ordinarily rolls back and rejects; it need not reset the object as a failed
  concurrency block does. Timeout/reset must still roll back and retire late work.

Example of the failure a write-only gate misses:

```text
A reads 0; B reads 0; A writes 1; B writes 1.
```

The final writes can be individually serialized and still lose an increment.

## 10. Output gates and durability

Track committed/durable positions within each cell epoch. Before releasing an output, determine
which writes it can reveal and prove those positions durable.

Outputs include responses, errors carrying object values, outbound calls, response stream chunks,
and WebSocket frames. A read-only event can reveal another event's locally committed but unproven
write; gating only the event that wrote is insufficient.

A minimal distributed design can wait for the authoritative durable store before every
acknowledgement. Local SQLite commit alone is not protection against losing that node's disk.
`storage.sync()` should explicitly wait for the promised durability boundary.

If proof fails or ownership changes, refuse/reset rather than acknowledge unproven state. This does
not undo an operation already sent; API designs should communicate uncertain outcomes and support
deduplication where needed.

### Optional: follower acknowledgements

Celld can acknowledge before bucket upload after other nodes fsync the write. Adding this
optimization requires durable session/recovery metadata, complete-tail evidence, fencing/sealing old
followers, and a recovery interlock before restoration.

Do not implement early follower acknowledgements with only an eventual background upload. A dead
owner may have acknowledged writes that exist solely on its followers. If completeness cannot be
proven, recovery must wait or fail, not substitute an older bucket snapshot.

## 11. Durable alarms

A host `setTimeout()` is only the resident fast path, not a durable alarm implementation.

There is one current alarm per cell; setting another replaces it. During its handler, `getAlarm()`
hides the fired installation unless explicitly re-armed. Transactional alarm changes become visible
to discovery only after commit.

1. Persist the deadline/retry state in the cell database.
2. Atomically assign an installation identity `(epoch, sequence)` with the alarm change. Celld uses
   `_cf_WAKE` plus SQLite triggers.
3. Publish an immutable wake entry for that installation. A response acknowledging the arm waits for
   discovery publication and storage durability.
4. Schedule a local timer and run boot/periodic discovery scans for evicted or failed owners' cells.
5. Treat scan entries as hints: resolve ownership, restore SQLite, and check the actual persisted
   deadline before delivery.
6. Claim/fire the alarm, preserving the original row for crash recovery until consumption is
   durable.
7. On success, consume the original installation. An explicit re-arm/delete wins over cleanup, even
   when it uses the same timestamp.
8. On handler failure, persist retry/backoff. Celld allows six counted retries, starting at a
   2-second exponential backoff; some system failures do not count against the ceiling.
9. Retire discovery entries only with committed consumption/replacement evidence and current owner
   authority. Delete by installation identity, never just by cell ID.

Delivery is at least once. Crash/recovery can replay a handler; applications need idempotent alarm
work. Late PUTs/DELETEs must not destroy a newer installation's discoverability.

## 12. Eviction, handoff, and request retry

### Eviction / handoff

1. Stop or quiesce admission appropriately and account for running/background work.
2. Prove the cell's final state durable; ensure pending alarms have discovery coverage.
3. Retire/close the runtime without letting old callbacks use its replacement.
4. Keep ownership dormant or conditionally release it according to policy.
5. Release only if owner and epoch still match; preserve the epoch history.

A new owner reacquires/restores before execution. A preserved local snapshot is a cache of a
particular lineage, not permission to serve without authority.

### Retry classification

| Failure                                              | Automatic replay policy                            |
| ---------------------------------------------------- | -------------------------------------------------- |
| Explicit stale-owner refusal before handler delivery | Re-resolve and retry within a bounded policy.      |
| Connection never established / no request delivered  | Retry if the request body is replayable.           |
| Timeout/disconnect after possible delivery           | Report uncertainty; do not blindly replay.         |
| Streamed upload already consumed                     | Do not replay an unread suffix as a fresh request. |

Request IDs correlate cancellation and tracing; they are not durable deduplication by themselves.
Application/client retries require idempotency or a durable deduplication protocol. Lease recovery
does not provide exactly-once requests.

## 13. Failure tests required before distributed use

Use an injectable clock/store/transport and deterministic lifecycle tests. Cover at least:

| Fault                                                  | Required observation                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Two nodes claim an absent cell concurrently            | One CAS winner; loser resolves the winner.                       |
| Two nodes take over the same dead owner                | One new authoritative epoch.                                     |
| Renewal applied but response lost                      | Readback reconciles; no guessed extension.                       |
| Old renewal lands after a newer update                 | Identity/version reconciliation cannot overwrite recovery state. |
| Renewal completes after old lease expiry               | Old incarnation cannot resume serving.                           |
| Process paused across expiry/takeover                  | Late work cannot commit to or acknowledge the successor's state. |
| Wall-clock step, monotonic drift, VM suspension        | Authority/cache deadlines fail safely under stated assumptions.  |
| Ownership/lease read error                             | No inference that the owner is absent/dead.                      |
| Lease record missing or replaced                       | Self-fencing, including retirement of late callbacks.            |
| CAS accepted without enforcing its condition           | Backend qualification fails before fleet use.                    |
| Old ownership-release request arrives late             | Successor record remains intact.                                 |
| Dead owner acknowledged only to followers              | Restore waits for complete, sealed recovery.                     |
| Concurrent reader exposes an unproven commit           | Its output waits or fails with the same durability barrier.      |
| Transaction overlaps an already-admitted continuation  | Reads/writes do not join another event's transaction.            |
| Block/transaction times out but callback later resumes | No stale writes, late commit, leaked hold, or stale release.     |
| Alarm arm succeeds, then process crashes               | Durable scan rediscovers it.                                     |
| Old wake publication/deletion arrives after re-arm     | New alarm remains discoverable.                                  |
| Remote handler commits but response is lost            | No automatic ambiguous replay.                                   |

Measure renewal latency/headroom, fence causes, CAS conflicts, activation queues, stale-route
refreshes, durable-position lag, and blocked recovery. A too-short TTL or shared-store outage can
fence healthy nodes together; preserve safety even when availability suffers.

## 14. Suggested implementation order

1. **Single process:** stable IDs, lazy instances, per-cell storage, admission, transactions, and
   explicit concurrency semantics.
2. **Authoritative durable storage:** define which failures an acknowledgement survives; implement
   output/read visibility rules.
3. **Distributed ownership:** process identity, node leases, CAS epochs, forwarding, cache expiry,
   and storage-enforced fencing.
4. **Recovery and lifecycle:** restore correct lineage, safe eviction/release, uncertain-result
   handling, and fault tests.
5. **Durable alarms:** persistent source state, immutable discovery, retry, and proof-based
   retirement.
6. **Optimizations only after correctness:** follower proofs, paged restores, capacity placement,
   hibernating WebSockets, clean-reload reuse, and re-entry compatibility.

Start without early follower acknowledgements or stable-ID restart shortcuts. If using coarse
whole-event serialization, document its concurrency/deadlock limitations rather than presenting it
as exact DO semantics.

## 15. Source map

Use symbol names to find the implementation; line numbers drift.

| Topic                                               | Source                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle/routing/leases/CAS reconciliation         | [`crates/logic/lib.rs`](../crates/logic/lib.rs): `request_authorized`, `owner_read`, `apply_node_lease_result`, `owner_cas_completed`, `hold_node_lease`, `node_lease_read`, `node_authoritative`, `fence_node`.                                      |
| Bucket record adapters                              | [`crates/celld/ownership_store.rs`](../crates/celld/ownership_store.rs): `read_owner`, `cas_owner`, `release_owner`, `cas_node_lease`.                                                                                                                |
| Host effect execution / local development ownership | [`crates/celld/actor.rs`](../crates/celld/actor.rs): `Ownership`, `MemoryOwnership`, execution of `ReadOwner`, `CasOwner`, `Restore`.                                                                                                                 |
| Worker-to-cell dispatch and peer retries            | [`crates/celld/main.rs`](../crates/celld/main.rs): `dispatch_do_call`, `dispatch_rpc_call`, `RemoteRouteRetry`.                                                                                                                                       |
| Safe transport replay classification                | [`crates/logic/routing.rs`](../crates/logic/routing.rs): `Attempt`, `Dispatcher`.                                                                                                                                                                     |
| Stubs, readiness, concurrency blocks, transactions  | [`crates/celld/js/harness.js`](../crates/celld/js/harness.js): `DurableObjectNamespace`, `_readyInstance`, `blockConcurrencyWhile`, `DurableObjectStorage`.                                                                                           |
| Input-gate decision logic                           | [`crates/logic/gate.rs`](../crates/logic/gate.rs): `InputGate`.                                                                                                                                                                                       |
| Native gates, event contexts, turns                 | [`crates/celld/js.rs`](../crates/celld/js.rs): `CellGate`, `cell_gate_wait`, `op_gate_acquire`, `op_gate_release`, `finish_turn`.                                                                                                                     |
| Isolate turn scheduling                             | [`crates/celld/pool.rs`](../crates/celld/pool.rs): `Slot::turn_in`.                                                                                                                                                                                   |
| Cell runtime registry and activation                | [`crates/celld/runtime.rs`](../crates/celld/runtime.rs): `CellRegistry`, `restore_cell`, `fetch_cell`, `drive_cell`.                                                                                                                                  |
| KV/schema/transaction/alarm state                   | [`crates/celld/storage.rs`](../crates/celld/storage.rs): `schema`, `transaction_control`, `put_many_serialized`, `finish_alarm_handler_with_retry_policy`.                                                                                            |
| Queued KV write flush                               | [`crates/celld/js/storage_ops.rs`](../crates/celld/js/storage_ops.rs): `flush_pending_puts`.                                                                                                                                                          |
| Output barriers                                     | [`crates/logic/output_gate.rs`](../crates/logic/output_gate.rs) and lifecycle `alarm_finished`.                                                                                                                                                       |
| Wake identity and discovery                         | [`crates/celld/storage/wake_record.rs`](../crates/celld/storage/wake_record.rs), [`crates/logic/wake.rs`](../crates/logic/wake.rs), [`crates/celld/wake.rs`](../crates/celld/wake.rs), [`crates/celld/wake_entry.rs`](../crates/celld/wake_entry.rs). |
| Alarm retry policy                                  | [`crates/logic/alarm.rs`](../crates/logic/alarm.rs): `alarm_retry`.                                                                                                                                                                                   |
| Durability, recovery, backend assumptions           | [Guarantees](guarantees.md), [Durable Objects](services/durable-objects.md), [Limitations](limitations.md).                                                                                                                                           |
