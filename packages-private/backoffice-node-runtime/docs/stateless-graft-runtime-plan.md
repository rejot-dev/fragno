# Stateless containers with Graft-backed object and control databases

Status (October 1, 2026): the single-owner persistence slice is implemented; distributed ownership
remains planned.

Scope: `packages-private/backoffice-node-runtime`. Backoffice application integration remains
separate. This plan does not modify `apps/graft-poc` or port celld's execution engine.

## 1. Outcome and explicit limits

Run a fleet of replaceable Node containers. Each container has a unique process-incarnation ID, an
ephemeral Graft cache, a control-plane client, and one worker thread for each resident object. Every
object has one logical Graft-backed SQLite database. The fleet's leases, object directory, ownership
epochs, and alarm discovery metadata live in a separate Graft-backed SQLite database.

**Stateless means local disk is disposable, not that objects have no state.** After losing every
container and every local cache, a fresh fleet must recover all acknowledged database writes and
acknowledged alarms from remote storage. Keep the control database's remote log ID in deployment
configuration; losing that locator is not something a local cache can repair.

Preserve:

- One instance and worker per resident object identity: initialization, fetch, RPC, alarms, and
  registered background work share it.
- Stock Cap'n Web serialization, independent `.dup()` handle ownership, callbacks, capabilities,
  promise pipelining, and streaming where supported by the transport.
- Real SQLite transactions, Fragno's constrained query model, and its two-phase OCC.
- Caller-coordinated graceful cleanup. Distributed failure fencing is a separate responsibility.

Do not implement:

- Turns, microtask scheduling, a general JavaScript side-effect gate, or precise Cloudflare
  execution semantics.
- A full `DurableObjectStorage` compatibility layer, implicit KV read-modify-write isolation,
  asynchronous interactive transactions, or automatic transactional wrapping of entire handlers.
- Exactly-once requests or external side effects, transparent replay after ambiguous failures,
  durable RPC capabilities, WebSocket hibernation, follower acknowledgements, or automatic balancing
  in the first release.
- A new authoritative PostgreSQL/Redis service or a secretly single-writer control-plane container.
  Graft is the durable storage mechanism for both planes.

The target guarantee is **durable managed database operations and fenced takeover**, not arbitrary
JavaScript side-effect isolation. Ordinary handlers may interleave across `await`. A paused former
owner can resume JS; it must not extend the successor's database history with stale writes.

## 2. What the current implementations establish

### Private runtime

- `src/runtime/node-object-runtime.ts` caches local workers and discovers every object from one
  local `objects.sqlite` file. Namespace handles currently resolve directly to those workers.
- `src/sqlite/sqlite-object-storage.ts` stores identities, KV, alarms, and narrow
  initialization/alarm claims together. Its ordinary writes are not fleet-fenced.
- `src/sqlite/sqlite-connection-config.ts` requires WAL. This configuration cannot be reused for a
  Graft connection.
- `NodeRuntimeObjectContext` exposes identity, a clock, and a narrow state API whose
  `state.storage.sql` surface uses the worker-owned object connection. It exposes no transaction,
  commit, flush, or push controls.
- Backoffice's separate `node/sqlite-database-adapters.ts` opens additional databases for Fragment
  data. Those adapters are outside this implementation; the new package must provide the primitive
  they can eventually consume rather than declaring the application stateless prematurely.

### Graft baseline

Use the POC's pinned `sqlite-graft@0.2.1` as the initial qualification target, not an assumption
about whatever version is newest. The source inspected for this plan is Graft tag `v0.2.1`, commit
`f38e03536d106747132476d7f21b84ffa64535c6`.

The relevant source behavior is:

1. Local SQLite commit and remote Graft push are different operations.
2. Remote commits are uploaded after their data segments and use conditional creation of a
   `(remote log, LSN)` commit object. Competing different commits at the same position cannot both
   win on a conforming storage backend.
3. A conflicting push produces divergence. It does not merge SQL rows or roll back the losing local
   SQLite transaction. The POC records this behavior against R2.
4. Push failures can be uncertain. Graft retains pending-commit information and reconciles commit
   hashes; an error does not prove that remote storage rejected the commit.
5. `graft_clone` selects a fresh local volume tracking a remote log; `graft_pull` updates from it.
   Diagnostic pragmas return text, not a stable typed management SDK.
6. Autosync is opt-in. Keep it disabled for this runtime.
7. WAL is unsupported; Graft recommends `journal_mode = MEMORY`. Forking requires hydration in this
   version, so a fork per activation is not the default design.

**Design inference, to be qualified:** conditional remote append can provide the serialization point
for control commands and object fencing commits. Graft does not itself implement our leases, process
identities, ownership checks, alarm protocol, or retry policy.

### Celld lessons to reuse

Reuse unique process identities, continuously confirmed leases, monotonic object epochs, explicit
activation states, fail-closed ownership reads, conditional release, uncertainty-aware routing, and
durable alarm discovery. Do not port turns, its LTX/follower protocol, or Cloudflare KV behavior.

## 3. Proposed topology

```text
                         application ingress
                                 |
                     object namespace / resolver
                                 |
                   +-------------+---------------+
                   |                             |
             local object worker          authenticated peer RPC
                   |                             |
                   +---- owning object worker ---+
                                 |
                     managed Graft SQLite DB
                                 |
                          object remote log

Each container:
  main thread: ingress, routing, worker lifecycle, authority watchdog
  control worker: serialized local access to a clone of the shared control log
  object workers: one instance and one managed DB owner per resident object

Remote storage:
  control Graft log: nodes, object directory/ownership, alarm index, command receipts
  one Graft log per logical object: application tables + runtime tables
```

There is no shared container filesystem and no need for a serving control-plane leader. Each
container's control worker independently proposes short transactions against the same remote log.
The successful Graft append, not a local SQLite lock, decides the global order.

Start with one control database per fleet. It is a deliberate contention/throughput limit: even
updates to unrelated rows compete at the remote-log level. Qualify that limit before distributed
rollout; do not disguise it as row-level distributed locking. Sharding is a later design decision.

### Identity and provisioning

- Fleet configuration contains the remote backend/prefix, control remote log ID, peer authentication
  configuration, and compatible runtime/application version.
- Generate a new node ID on every process start. Do not reuse a hostname as process authority.
- Object identity is the fleet plus binding plus object name. Local tags/filenames use a safe
  deterministic encoding; they are not the durable locator.
- Store the object's actual Graft remote log ID in the control directory. Never infer it from a
  local filename or treat a missing remote database as an empty existing object.
- Provision the control database once through an explicit administrative command, push its schema,
  then publish its log ID in deployment configuration. Serving containers clone it; they must not
  silently create independent control planes when lookup fails.
- On first object creation, push a new database's identity/schema before conditionally registering
  its mapping. A losing concurrent creator discards its candidate. Unreferenced candidates may be
  collected later, not reused as the winner's storage.

## 4. Control-plane database and command protocol

### Required persistent concepts

| Concept                     | Required information and access paths                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet format                | Schema/protocol version; reject incompatible clients before serving.                                                                                    |
| Node lease                  | Incarnation ID, private address, compatibility version, expiry, renewal identity; lookup by node ID and scan by expiry.                                 |
| Object directory/ownership  | Binding/name, stable remote log ID, monotonically increasing epoch, lifecycle, owner incarnation when owned; unique object identity and index by owner. |
| Alarm index                 | Object identity, installation identity, next due time; index `(due_at, object_id)` for cursor scans.                                                    |
| Alarm reconciliation intent | Object identity, ownership epoch, operation token; find unfinished publications without opening every object database.                                  |
| Control-command receipt     | Command ID and committed outcome, stored in the command's transaction; lookup by command ID and bounded retention index.                                |

Represent ownership as explicit `unowned`, `restoring`, and `ready` variants. Keep the epoch when
releasing ownership. Use exact integer representations for epochs/sequences, not unsafe JavaScript
numbers. Runtime-only states such as `resolving` and `fenced` need not all become persisted fields.

### One durable control command

All control access goes through a small concrete `GraftControlStore`, not arbitrary application SQL.
Named operations include `registerNode`, `renewNodeLease`, `claimObject`, `markObjectReady`,
`releaseObject`, `beginAlarmReconciliation`, and `publishAlarmState`.

For each mutating command:

1. Serialize access to this container's control connection. Do not leave unrelated commands mixed
   into one unconfirmed local branch.
2. Pull a clean remote snapshot. Resolve any previous uncertain push before reusing that branch.
3. In one short SQLite transaction, check the command receipt, read all command preconditions,
   evaluate them, and write the state change plus its receipt.
4. Commit locally and synchronously push. Return the outcome only after remote confirmation.
5. On proven divergence, discard the speculative local branch, clone/pull a clean remote snapshot,
   and rerun the **semantic control command** with its original command ID and fresh preconditions.
   Do not replay raw SQL computed from the losing snapshot.
6. On an uncertain push, reconcile through Graft's recovery and a clean authoritative read of the
   command receipt. Preserve uncertainty until resolved or the caller's deadline expires.

A receipt found remotely proves the command's outcome, but does not make an expired lease usable. A
missing receipt by itself does not prove that an in-flight upload cannot still arrive. Retry only
with the same logical command identity and conditional append protocol; never assume an error means
a command was not applied. A generic SQLite error is not a conflict classification.

Control commands are replayable because they contain only bounded database decisions. They do not
invoke object handlers, network APIs, callbacks, or other side effects. Receipt collection must
respect the maximum retry/reconciliation lifetime; an old command outside that window is rejected,
not silently executed again.

Authoritative reads pull first. Cached routes are an explicitly bounded exception, not a reason to
read leases indefinitely from a local clone. Every reset must invalidate prepared statements and
local snapshot-dependent decisions.

### Lease time and renewal

- Generate and compare persisted times within the control command's database operation. However,
  SQLite time here is the proposing container's clock, **not a central database server clock**.
- Document a maximum inter-node clock skew and use conservative expiry/takeover margins. Reject
  operation outside those deployment assumptions; DB time alone does not solve distributed clocks.
- Carry both a wall-clock expiry and a local monotonic deadline. Use elapsed time for I/O budgets,
  detect clock discontinuity/suspension where possible, and fail closed rather than extending trust.
- Compute the proposed expiry at the beginning of the attempt. A slow push does not buy a new full
  TTL on receipt. Continue relying on the previous confirmed deadline while renewal is pending.
- A renewal must be confirmed before the previous authority window ends. Once that window ends, this
  incarnation is terminally fenced even if its delayed renewal later appears remotely.
- Takeover checks the previous owner's lease in the same control snapshot as the claim transaction.
  Renewals and takeovers therefore conflict through the control log rather than racing independent
  unconditional row updates.
- Prioritize renewals over background scans; choose TTL, cadence, and safety margin from measured
  push/retry latency and the deployment's time assumptions, not celld's default numbers.

Missing/replaced leases, unreadable state, exhausted authority windows, and unreconciled renewal
failures stop admission and retire workers. A timer assists this; admission and managed database
boundaries also check authority. Neither can physically stop a suspended process, which is why the
object database needs its own durable fence.

## 5. Object takeover and storage fencing

**Do not claim that a control-row epoch atomically fences another database.** The databases are
separate, so takeover is a recoverable protocol rather than a cross-database transaction.

### Recommended design: stable object log with a fencing commit

Each object database has one runtime-owned identity/authority row containing its object identity,
current epoch, and owning incarnation. Application SQL cannot modify that row or call Graft
management pragmas. Each activation binds its managed database handle to exactly that authority.

Activation:

1. Resolve the object mapping and owner. Join an existing local activation, route to a confirmed
   live remote owner, or try a control-plane claim.
2. Claim `restoring` at the next epoch in the durable control log, conditional on the observed
   ownership and previous owner's expired/released authority.
3. Open a clean clone of the object's stable remote log. Never reuse an old speculative branch.
4. Write the new authority row in a real transaction and push this **fencing commit**.
5. If an old writer won the next remote position first, the fencing push diverges. Before starting
   application code, discard this activation attempt's local branch, revalidate its control claim,
   pull the new head, and retry the fencing transaction with a bounded policy. Preserve those
   intervening durable writes. Never overwrite a higher epoch.
6. After the fence is remotely confirmed, revalidate the control claim and lease. Start the worker,
   finish initialization/migrations through the managed durable database, and conditionally publish
   `ready` for this exact epoch. Only then admit application delivery.
7. Reconcile the persisted alarm state before considering activation complete for scheduling.

A crash at any step leaves an explicit `restoring` record or a remotely fenced database, not a
fictional ready worker. A subsequent claimant advances the epoch and resumes from remote history. An
old completion cannot publish readiness or release a replacement's claim.

### Why this can fence an old writer

Suppose the old worker has remote base `H`:

- If its push wins `H+1` first, the replacement must include that commit before it successfully
  fences the database. An unacknowledged operation may therefore survive; its outcome was uncertain.
- If the replacement's fencing commit wins `H+1`, the old worker's different commit at `H+1` is
  rejected. It cannot append at `H+2` from its old snapshot.
- An application activation must **never automatically pull/reset/rebase and retry a divergent
  write**. Divergence retires that activation. Only the pre-execution activation protocol may retry
  its named fencing operation after checking ownership again.
- Even a clean old connection must not adopt a successor's snapshot. If reconnect/recovery opens a
  new snapshot, its authority row must match the handle's captured epoch/incarnation before use.

This relies on compliant runtime clients and verified conditional Graft appends. It is not a
security boundary against code with raw bucket credentials or unrestricted native database access. A
local lease check followed by a push is still not an atomic lease check: a late old push may win
**before** the replacement fence. It must not be acknowledged under expired authority, and takeover
must retain it if it reached remote history.

Do not substitute per-activation forked logs without also designing authoritative lineage and
acknowledged-head publication. Prefix separation alone is not recovery. It also imposes Graft
hydration/fork costs that this stable-log design avoids.

## 6. Managed SQL and durability without turns

### One object database, including real application data

Expose object-scoped SQL through the author-facing `state.storage.sql` API and provide Fragment
integration through a runtime-owned adapter over the same connection. Do not expose transaction,
commit, flush, or push controls through `NodeRuntimeObjectContext`. The worker owns the SQLite
connection and its close lifecycle. The same database contains:

- Fragment/application tables, with their existing schema namespacing;
- the runtime identity/authority row;
- a minimal KV table for the small compatibility surface actually used;
- the current alarm installation and retry state;
- durable hook/outbox tables belonging to the object's Fragments.

Do not let object factories open arbitrary files that bypass replication and then advertise the
object as durable. A future Backoffice integration must map its existing database scopes onto this
primitive explicitly, including any genuinely shared databases. That migration is not part of this
package-only plan.

Replace the broad `DurableObjectStorage` cast with an honest narrow runtime storage type. Preserve
needed `get`/`put`/`delete`/list/alarm behavior and V8 value encoding initially; do not implement
unused Cloudflare KV options, transaction APIs, or implicit concurrency guarantees.

### Commit and external output boundary

The managed driver must distinguish local commit from remotely durable commit while keeping push
outside object-author control:

1. Check captured object authority and the node's remaining authority window.
2. Execute storage SQL and narrow KV/alarm mutations through the worker-owned connection. Each SQL
   mutation commits locally and advances an activation-local storage position; no user-facing
   transaction or flush API exists.
3. Internal fetch/RPC and returned-capability calls inside one runtime output scope record the
   highest object storage position their results can reveal. They do not push between calls.
4. Immediately before the enclosing external result or handler error is exposed, synchronously run
   `graft_push` for every touched object whose required position is not already proven durable.
5. Recheck authority before reporting the external outcome.
6. On divergence, uncertainty that cannot be resolved in budget, or authority loss, poison the
   handle and retire the instance. Do not permit reads from its rejected speculative state.

Use synchronous native commit/push within the dedicated object worker for the first version,
including autocommit mutations. This blocks that worker, not the routing or control worker. The
output gate does not hold one SQLite transaction across arbitrary asynchronous handler work and does
not serialize whole fetch/RPC handlers. Separate calls may observe intermediate commits; callers use
real SQLite transactions when those changes must be atomic.

A second request that reads locally committed state records the same or a later object storage
position. Its output therefore waits for a push covering that position, even when the original
writer has not reached its own output boundary. The writer later releases without another push when
the proven position already covers its output. This is per-object position bookkeeping, not a
request dependency graph. An output scope that touches several objects waits for each object log
independently; it is not a distributed transaction and provides no cross-object atomicity.

Apply the same durable boundary to schema changes, KV writes, alarm consumption, initialization,
registered background writes, and Fragment mutations. Initialization, alarm acknowledgements, and
background drains without an enclosing external scope keep immediate worker-owned boundaries. Audit
the driver's actual commit path and its error handling: if push fails **after local COMMIT**, a
subsequent SQLite ROLLBACK does not undo it. Report a durability/uncertainty failure, not an
ordinary retryable OCC conflict. Never cause Fragno to replay a possibly committed application
mutation as though its SQL transaction rolled back.

### Deliberately narrower output contract

`runtime.runWithOutputGate()` is the shell boundary for a non-streaming external result. Namespace
lookups made inside it receive worker capabilities bound to that output scope. Calls outside it keep
an implicit per-call durability boundary so direct RPC users cannot accidentally receive unconfirmed
state. A failed push rejects every output waiting on the covered object position and poisons the
activation. Competing managed reads cannot continue from its rejected speculative state.

It does not make arbitrary JS memory, outbound `fetch`, callback arguments, or stream producers
transactional. Response-stream work performed after the handler returns is outside the scope and
will require per-chunk tickets before claiming general streaming output coverage. Applications still
use durable hooks/outboxes plus idempotency for external effects. Returned capabilities inherit the
scope that created them and cannot be used after it closes. Raw in-memory capability methods are not
promised linearizable behavior across ownership changes.

Keep `blockConcurrencyWhile` as an initialization/explicit admission barrier with documented Node
semantics. It does not pause already-running native promise continuations. Registered `waitUntil`
work uses the same authority-bound database; on crash it is not itself durable unless it recorded an
outbox/job first. No automatic event-level rollback or serialization is added.

## 7. Routing, Cap'n Web, and lifecycle

Namespace lookup resolves an object identity, not a permanent node address. Refactor worker creation
behind a resolver that returns either a ready local activation or an epoch-bound remote route.
Single-flight local resolution prevents duplicate workers for the same activation.

- Retain MessagePort Cap'n Web sessions between the container and its workers.
- Add an authenticated peer Cap'n Web transport, preferably a persistent WebSocket session, with a
  private routing handshake carrying object identity, expected epoch, node incarnation, and protocol
  version. Select its exact adapter after testing the stock dependency's transport behavior.
- Cache routes no longer than the observed owner's conservative lease deadline. Refresh on an
  explicit pre-delivery stale-owner refusal. Receiver-side admission validates its own authority;
  cached caller metadata does not confer ownership.
- Preserve native capability lifetimes: a returned capability is tied to its activation/session. On
  worker loss or ownership change it breaks. Do not silently reconnect it to a different object
  instance. Reacquire a namespace handle for a new attempt.
- Retry only proven pre-delivery refusals or a connection failure known to have delivered nothing,
  with bounded attempts and a replayable request. A pipelined chain already emitted on a session,
  consumed request stream, or ambiguous disconnect is not transparently replayed.
- Validate peer identity and protocol at ingress. Use encrypted/private transport plus
  authentication; a private address alone is not authorization. Keep local module definitions
  application-owned.

Graceful container drain: stop ingress/producers, let callers finish RPC and streams, drain
registered background work, close workers, and conditionally release ownership while authority
remains valid. If quiescence cannot be established within budget, fence/terminate and let recovery
handle uncertain operations. Do not extend `cleanup()` into a patched Cap'n Web session drain.

First release: no idle eviction or live migration with outstanding capabilities. Cap resident
workers and reject new placements at capacity; start with on-demand placement and failure takeover.
If a single object worker dies while its parent remains live, invalidate its handles and perform an
explicit fresh-epoch activation. Never revive the old epoch or automatically replay failed calls.

## 8. Durable alarms across the two databases

The object database is authoritative for the installed alarm. The control database is its durable
wake/discovery index. They cannot be updated atomically through an ordinary SQLite transaction.

Use **write-ahead reconciliation intent**, not best-effort publication after an object write:

1. Before an alarm-changing database unit, durably record a reconciliation token in the control
   database for this object/epoch. Do this before opening the object SQL transaction.
2. Change the object's alarm installation in its database and push it. Give every installation a
   distinct identity, including when the timestamp is unchanged.
3. Publish the resulting alarm index state and clear exactly that reconciliation token in one
   durable control command, conditional on the current ownership epoch. Then acknowledge the arm.
4. A periodic scanner processes both due index entries and unfinished reconciliation intents. It
   resolves ownership, opens/routes to the authoritative object, and repairs the index from the
   durable object database. An unavailable object leaves its intent pending, not forgotten.

A crash after step 1 is a false-positive wake to repair. A crash after step 2 cannot hide a newly
persisted alarm because its intent was already durable. A failed object push leaves an intent that
must be reconciled from remote history, never the losing local branch. Activation also reconciles
alarms so an interrupted old epoch cannot strand its intent.

Serialize alarm-changing units per object. Newer tokens/installations supersede older ones only
through conditional operations; a delayed publication/clear from an old epoch cannot delete a newer
alarm. A replacement owner may repair an old intent after obtaining its storage fence, using an
exact token guard plus its new authority rather than borrowing the old epoch's permission.

Delivery is at least once. Resolve the object, confirm the exact current due installation, and run
its alarm on the existing instance. After success, durably consume only the delivered installation;
a concurrent re-arm wins. Persist failure/backoff and index it through the same reconciliation
protocol. Do not copy Cloudflare's exact retry count unless the application needs it.

Replace `discoverPersistedObjects()`'s activate-everything behavior with cursor-based due-alarm and
reconciliation scans. Local timers may accelerate discovery, but every acknowledged installation
must remain recoverable with no resident worker and no local files.

## 9. Native integration qualification: the first implementation gate

Before building distributed ownership, create a package-local scenario using real Graft and the
supported Node 24 runtime. The existing POC is evidence, not a production storage adapter.

Prove:

- Which driver is supported: prefer preserving `better-sqlite3`/the existing Fragno driver if its
  extension loading and Graft URI opening work; otherwise implement a managed `node:sqlite` driver.
  The POC uses `node:sqlite`, so compatibility with `better-sqlite3` is not established by it.
- Extension path resolution on the deployment architectures, including the POC's package naming
  workaround; configuration must exist before extension initialization.
- Safe native VFS initialization and lifetime across worker threads. Do not assume each worker has
  an isolated VFS or may independently open the same Fjall cache. Establish the actual registration,
  shared-runtime, locking, and shutdown behavior for the chosen binding.
- Concurrent control/object connections use distinct volumes without reinitializing process-wide
  extension configuration. Different containers use independent local cache directories.
- The control worker continues renewing leases while another object's synchronous push is blocked.
- Graft connection settings, schema migrations, transactions, prepared statements after clone/reset,
  and the full Fragno query/commit path work without the local WAL configurator.
- Reliable parsing/classification of the pinned pragma/error formats at one adapter boundary.
  Unknown errors fail closed. Ordinary `ERR_SQLITE_ERROR`/`SQLITE_INTERNAL` values do not identify
  divergence by themselves.
- Independent-clone concurrent push, lost push reply, retry/recovery, late upload, fresh-cache
  restore, and storage backend conditional-create/read-after-write/range-read behavior.
- Bounds on local volume/cache accumulation after repeated resets. Do not assume deleting a SQLite
  tag deletes the underlying Graft history or that arbitrary remote-segment GC is safe.

Use Graft's filesystem remote for repeatable local scenarios, and an isolated S3-compatible backend
for faulted HTTP integration. Qualify the actual production R2/S3 backend separately with explicit
credentials and a disposable prefix. Do not silently run tests against the POC's existing data.

### Filesystem-remote conflict qualification

Qualified on October 1, 2026 with Node 24.18.0 and `sqlite-graft@0.2.1`. The
`graft-independent-clone-conflict.scenario.test.ts` scenario uses child-process invocations with two
independent cache directories, clones the same remote head, and commits a distinct SQL row in each
clone. Competing pushes produce these observable results:

- Exactly one push succeeds. The other synchronously throws an `Error` with
  `code="ERR_SQLITE_ERROR"`, `errcode=2`, `errstr="unknown error"`, and a message stating that the
  volume diverged from the remote.
- The losing local SQLite commit remains readable. `PRAGMA graft_status` reports one different local
  commit and one different remote commit, and retrying the losing push fails again.
- A third process with a fresh cache restores only the winning row. Graft neither merges the two SQL
  branches nor overwrites the winning remote commit with the losing clone.

This is a proven divergence only because the remote already contains a different commit and Graft's
status reports divergence. The generic SQLite error fields do not classify the failure. Runtime
application writes continue to fail closed rather than resetting or replaying the losing branch; a
future control-command adapter must perform conflict classification and semantic command retries at
one boundary.

The existing controlled-push scenarios cover both adjacent uncertainty boundaries. A failure before
the real push restores no write, while a real push followed by a simulated lost response restores
the write in a fresh process without replaying the handler. These filesystem-remote results do not
qualify conditional-create, delayed visibility, or lost HTTP response behavior for the production
R2/S3 backend; that still requires a controllable S3-compatible proxy and disposable remote prefix.

**Go/no-go:** if the pinned extension cannot safely support this worker topology, its remote append
cannot be reconciled reliably, or control-log contention cannot fit renewal budgets, stop here.
Report the concrete dependency/API limitation before changing the topology or promising fleet
safety.

## 10. Implementation phases and acceptance criteria

Each phase leaves an executable scenario and a narrow reviewable change. No phase wires Backoffice
into the package.

| Phase                           | Deliverable                                                                                        | Acceptance criterion                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Qualify Graft                | Native loader/configuration, managed connection spike, real backend scenarios                      | Node 24, concurrent object workers/control connection, remote conflict and uncertain-push recovery pass; driver/topology decisions recorded.                                                              |
| 1. Per-object persistence       | One object database with runtime tables and managed Fragment SQL; explicit durable commit boundary | Write real Fragment data, minimal KV, and an alarm; destroy the entire local cache; restore data from the same object remote log. Failed push cannot return success or leak through a later managed read. |
| 2. Graft control store          | Fleet bootstrap, schema, receipts, pull/transaction/push commands                                  | Independent control clients race conflicting and unrelated updates; all successful outcomes exist in one remote history, losing commands recompute, unknown outcomes are not guessed.                     |
| 3. Authority and local takeover | Node leases, fresh epochs, `restoring`/`ready`, fencing commits, terminal authority loss           | Two containers contend; one ready epoch. Pause an old owner, take over, resume it: stale writes cannot append after the successor fence.                                                                  |
| 4. Peer routing                 | Resolver, bounded caches, authenticated Cap'n Web peer sessions                                    | Requests arriving at either node reach the owner; stale pre-delivery routes refresh; callbacks/capabilities/streaming work; ambiguous operations are not replayed.                                        |
| 5. Durable scheduling           | Alarm reconciliation intents, due index, retry, production scheduler integration                   | Crash at every publication/consumption boundary; fresh containers rediscover acknowledged alarms; old cleanup cannot remove a re-arm.                                                                     |
| 6. Fleet scenarios and drain    | Multi-process test runner, fresh-cache restart, graceful drain/forced fencing                      | Whole-fleet cache loss preserves all successful writes; existing caller-coordinated cleanup and `.dup()` ownership tests remain valid.                                                                    |
| 7. Deployment qualification     | Container native packaging, readiness/drain wiring, metrics, load/failure soak                     | Control throughput and renewal headroom meet the declared fleet target; actual backend fault tests pass; no persistent volume required.                                                                   |

The implemented Phase 1 slice provisions a Graft control directory, creates one Graft database per
object, exposes synchronous SQL through `state.storage.sql`, stores the narrow KV/alarm surface with
the object, and proves fresh-cache recovery plus fail-closed push errors. An importable
`GraftDatabaseOperations` collaborator isolates management pragmas; a recording decorator around the
real implementation proves that separate internal RPC calls share one push at their external output
boundary, concurrent writer scopes can share a push, and readers wait for exactly the storage
positions their outputs can reveal: an intermediate-state reader proves that state durable, while a
reader that completed before a later write does not wait for it. It does not yet provide a Fragno
SQL adapter. Phase 1 is a single-owner storage milestone, not permission to deploy several writers.
Phase 3 is not complete without storage fencing. Distributed rollout requires the complete
scheduling and failure qualification phases.

## 11. Package structure and test seams

Keep responsibility-based modules and colocated scenario tests. Expected additions:

```text
src/
  graft/
    graft-extension.ts
    graft-database-operations.ts
    graft-database.ts
    graft-sql-driver.ts
    graft-database.scenario.test.ts
  control/
    graft-control-store.ts
    graft-control-schema.ts
    graft-control-store.scenario.test.ts
  runtime/
    node-authority.ts
    node-object-resolver.ts
    node-object-activation.ts
    node-object-runtime.ts                 # refactor existing owner
    node-object-worker.ts                  # authority-bound DB bootstrap
  rpc/
    node-message-port-rpc.ts               # retain stock Cap'n Web
    node-peer-rpc.ts
  scheduling/
    graft-alarm-discovery.ts
    graft-alarm-discovery.scenario.test.ts
  testing/
    node-runtime-scenario.ts               # extend existing runner
    node-runtime-fleet-scenario.ts
```

Treat these as responsibility boundaries, not a requirement to create empty modules or export every
helper. Add direct public subpath exports only for integration primitives. Remove obsolete shared
file-backed coordination from the distributed path; do not build a speculative universal storage
framework or retain compatibility wrappers around superseded internal classes.

Scenarios should use production workers, the real extension, independent caches, real peer
transports, and final-state assertions from newly cloned databases. Add visible seams for clocks,
identity generation, process lifecycle, and a concrete faulting HTTP proxy. Do not mock successful
Graft pushes or replace ownership logic with a test-only coordinator.

Use child processes for independent fleet nodes: worker threads alone do not test separate native
extension runtimes or process-wide state. Retain worker threads inside each node. The harness should
support crash/restart, cache deletion, paused processes, blocked/dropped backend replies, and
explicit scheduler/control ticks. Keep fault schedules reproducible rather than relying on sleeps.

Required scenarios, in addition to the current serialization/cleanup coverage:

- Concurrent absent-object claims and concurrent expired-owner takeovers.
- Lease renewal applied with a lost response; delayed renewal past the old deadline; clock skew,
  wall-clock steps, and process suspension under the declared time bounds.
- Control read failure does not imply owner absence; control outage eventually fences every node
  that cannot renew without losing acknowledged data.
- Old writer wins before the fencing commit: takeover includes its durable write. New fence wins
  first: the old write is rejected and its speculative value cannot be read as confirmed state.
- Claim succeeds then process dies before clone, after fence, during initialization, and before
  readiness. A successor recovers without epoch reuse or resetting the database.
- A push succeeds remotely but its response disappears: report uncertainty or reconcile, never
  return a false rollback or automatically replay the handler.
- Read-only handler overlaps a pending/failed database unit: no speculative SQL state escapes.
- Late ownership release/readiness publication cannot modify a replacement's record.
- Every alarm-intent/index crash window, same-timestamp re-arm, retry, and competing scanners.
- Returned capability survives ordinary use but breaks on activation loss; new namespace lookup
  resolves the replacement. Disposing one duplicate still leaves other callers valid.
- Peer authentication failure, stale route, no-delivery connection failure, post-delivery response
  loss, and partially consumed streaming request. Assert allowed retries and uncertain outcomes.
- Full fleet termination, deletion of all caches, fresh-container recovery of Fragment data and
  pending alarms. No success depends on a previous container's filesystem.

## 12. Operational constraints and follow-up work

Measure control-command latency/conflicts/retries, renewal headroom, fence reasons, object
activation latency, Graft push latency, uncertain outcomes, cache growth, alarm reconciliation age,
and peer retry classification. Include node incarnation, object identity, epoch, control command ID,
and activation ID in traces; never credentials or application values by default.

Readiness requires confirmed node authority, a compatible control schema, and functioning peer
routing. Liveness must not keep a fenced incarnation serving. Resource limits bound resident
workers, in-flight activations, local cache usage, and background scans.

Expect a remote round trip on each committed write and multiple remote operations on cold
activation/alarm publication. That is an intentional initial cost. Batch only within existing
transaction boundaries; do not acknowledge early and hope a later upload succeeds. The shared
control log may become the first scaling bottleneck, particularly with frequent alarms.

Keep these as explicit later work:

- Backoffice composition/adapters/migrations and the mapping of existing shared database scopes.
- Capacity-aware placement, idle eviction with capability lifetime accounting, and planned handoff.
- Control-plane sharding if measured workload requires it.
- Application idempotency improvements and durable cancellation where independently required.
- Safe remote garbage collection, backup/restore procedures, and a reviewed dependency upgrade path.

No follower durability, turns, or exact KV compatibility is a prerequisite for any of these.

## 13. Source map

This plan combines inspected behavior with a proposed protocol. The fence/lease/alarm protocols
above are runtime designs to prove in scenarios, not claims that Graft already supplies them.

Local inputs:

- `apps/backoffice/open-issues/references/durable-object-runtime-reimplementation.md`, especially
  sections 2, 5–7, and 10–13.
- `apps/graft-poc/src/graft-sqlite-poc.ts` and `graft-extension.ts`.
- Private-runtime source files named in section 2 and its README cleanup/capability contract.
- `packages/fragno-db/src/sql-driver/sql-driver-adapter.ts`: commit/rollback behavior to audit when
  adding remote durability to a driver.

Celld checkout: `~/dev/celld`, inspected at `bad4649d01f0db84cdc9093527e72e64ca7a14bf`:

- `crates/celld/ownership_store.rs`: `cas_owner`, `release_owner`, `cas_node_lease`.
- `crates/logic/lib.rs`: `apply_node_lease_result` and the recovery-before-takeover interlock.
- `crates/logic/routing.rs`: `Attempt` and `Dispatcher`; delivery uncertainty controls replay.
- `crates/logic/output_gate.rs`: explains the broader output guarantee deliberately not ported.

Graft repository: `github.com/orbitinghail/graft`, tag/commit pinned in section 2:

- `crates/graft/src/remote.rs`: `Remote::put_commit`, conditional create after segment upload.
- `crates/graft/src/rt/action/remote_commit.rs`: `RemoteCommit`, `plan_commit`, `attempt_recovery`.
- `crates/graft-sqlite/src/pragma.rs`: clone, pull, push, fork/hydration, and diagnostic formats.
- `crates/graft-ext/src/lib.rs`: extension configuration, initialization, VFS registration.
- `docs/src/content/docs/docs/concepts/consistency.mdx` and
  `docs/src/content/docs/docs/sqlite/{compatibility,config,pragmas}.md`.
