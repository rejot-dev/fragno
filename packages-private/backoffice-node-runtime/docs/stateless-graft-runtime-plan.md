# Stateless containers with Graft-backed object and control databases

Status (October 4, 2026): one authority-bound Graft implementation, durable control commands,
distributed lazy first-object provisioning, authority-bound activation/fencing, renewable node
authority, terminal process self-fencing, authenticated peer routing, a runtime-owned Node HTTP/peer
host with automatic Fetch output gates and namespace-handle disposal, conditional graceful release,
process-local object activity tracking, configurable idle activation eviction, and the first
correctness slice of durable fleet alarm discovery are implemented. Control-worker isolation,
persisted alarm retry backoff, scanner partitioning or peer wake delivery, orphan-log collection,
and the broader peer fault matrix remain planned. Local scenarios now use temporary filesystem Graft
remotes with the same authority, fencing, output gates, and alarm reconciliation. The in-memory,
plain-SQLite, and unbound single-owner runtime alternatives have been removed. Process-local
control-store locking protects Graft 0.2.1's shared native cache during concurrent activation;
object-log pushes do not take that lock.

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

- `src/runtime/node-object-runtime.ts` caches object workers and reads fresh ownership and
  owner-lease state before choosing local activation or authenticated peer routing.
- `src/graft/graft-durable-object-state.ts` is the sole object-state implementation. SQL, KV, and
  authoritative alarms share one fenced object log; durable control commands coordinate ownership
  and alarm discovery. There is no separate local SQLite persistence or coordination path.
- `src/testing/node-runtime-scenario.ts` provisions filesystem Graft storage and uses the production
  runtime with real leases. Manual clocks do not bypass expiry or output authority checks.
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
  main thread host: HTTP ingress, peer WebSocket ingress, routing, worker lifecycle,
                    control-index alarm polling, authority watchdog, readiness, and drain
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
  its mapping. A losing concurrent creator uses the canonical winning mapping and leaves its
  unreferenced candidate for future collection; it never reuses that candidate as winner storage.

## 4. Control-plane database and command protocol

### Required persistent concepts

| Concept                     | Required information and access paths                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet format                | Schema/protocol version; reject incompatible clients before serving.                                                                                    |
| Node lease                  | Incarnation ID, peer address, application origin, compatibility version, expiry, renewal identity; lookup by node ID and scan by expiry.                |
| Object directory/ownership  | Binding/name, stable remote log ID, monotonically increasing epoch, lifecycle, owner incarnation when owned; unique object identity and index by owner. |
| Alarm index                 | Object identity, installation identity, next due time; index `(due_at, object_id)` for cursor scans.                                                    |
| Alarm reconciliation intent | Object identity, ownership epoch, operation token; find unfinished publications without opening every object database.                                  |
| Control-command receipt     | Command ID and committed outcome, stored in the command's transaction; lookup by command ID and bounded retention index.                                |

Represent ownership as explicit `unowned`, `restoring`, and `ready` variants. Keep the epoch when
releasing ownership. Use exact integer representations for epochs/sequences, not unsafe JavaScript
numbers. Runtime-only states such as `resolving` and `fenced` need not all become persisted fields.

### One durable control command

Distributed ownership access goes through a small concrete `GraftControlStore`, not arbitrary
application SQL. Implemented operations are `registerNode`, `renewNodeLease`,
`registerObjectDatabase`, `claimObject`, `markObjectReady`, and `releaseObject`. Alarm
reconciliation commands remain planned. `provisionGraftObject` pushes a complete candidate object
log, then uses the receipt-backed registration command to select one canonical mapping. Concurrent
creators re-read and use the winner before the ordinary `restoring` claim and readiness protocol.

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

### Lease time, renewal, and bounded clocks

Graft is the final **storage fence**, not a lease clock or ownership oracle. It rejects an old
activation's different append after a replacement fencing commit has won the next object-log
position. It does not reject an expired owner's append when no successor has fenced the log yet. An
old append may also land immediately before the replacement fence; takeover must preserve that
durable write, while the expired caller must not receive success. Graft therefore prevents history
corruption but does not decide when a process may admit work, acknowledge output, or declare another
owner expired.

The first fleet implementation uses a deliberately small bounded-clock contract rather than a
general distributed-time system:

1. Declare a maximum inter-node wall-clock skew for the deployment. Use a lease TTL and safety
   margin substantially larger than that bound and measured control push/reconciliation latency.
2. Compute each proposed wall-clock expiry at the beginning of the registration or renewal attempt.
   Persisted SQLite time is still the proposing container's clock, not a central database-server
   clock.
3. At that same point, derive a local monotonic self-fencing deadline. A slow push consumes the
   attempt's authority budget; confirmation does not grant a fresh full TTL starting at receipt.
4. Continue relying on the previous confirmed deadline while renewal is pending or its response is
   being reconciled. Advance authority only after the durable command or its receipt is confirmed.
5. Stop admission and externally visible output at the conservative monotonic deadline. Admission
   and managed database boundaries recheck it, so a process that resumes after suspension cannot
   continue merely because its watchdog timer did not run while paused. Also reject crossing the
   captured persisted wall expiry: a forward correction or platform sleep must not grant authority
   when the monotonic counter has not yet consumed that window.
6. Permit takeover only after the persisted expiry plus the declared skew margin. Check the previous
   lease and apply the claim in the same control snapshot, so renewals and takeovers conflict
   through the control log rather than racing unconditional row updates.
7. Once the previous confirmed authority window ends, terminally fence that process generation even
   if a delayed renewal later appears remotely. Retire its workers instead of reviving them.

This does not require NTP integration, continuous clock-quality estimation, or tolerance of
unbounded skew in the first release. It requires an explicit deployment assumption, conservative
margins, a monotonic deadline, and scenarios covering clocks offset within the declared bound, a
process suspended past its deadline, wall-clock movement, and renewal confirmation delayed beyond
the old authority window. Operation outside those assumptions fails closed.

Prioritize renewals over background scans. Choose TTL, cadence, skew allowance, and safety margin
from measured backend behavior rather than celld defaults or a fixed fraction such as one-third of
the TTL. Missing or replaced leases, unreadable control state, exhausted authority windows, and
unreconciled renewal failures stop admission and retire workers. The object fencing commit remains
necessary because a watchdog cannot physically stop a suspended or partitioned process.

## 5. Object takeover and storage fencing

The minimum stable-log fencing protocol in this section is now implemented by
`createAuthorityBoundGraftNodeObjectRuntime`. Lazy first-object provisioning, renewable authority,
terminal self-fencing, and remote-owner routing are also implemented. Remaining work includes
orphan-log collection, broader activation crash-window coverage, and production backend
qualification.

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

The runtime-owned Node host wraps each admitted application `fetch()` in one output gate. Custom
hosts and non-HTTP shells establish the same non-streaming external-result boundary explicitly with
`runtime.runWithOutputGate()`. Namespace handles acquired inside a gate are owned and automatically
disposed by its outermost scope; they cannot escape the Fetch invocation. Calls outside a gate keep
an implicit per-call durability boundary so direct RPC users cannot accidentally receive unconfirmed
state, but those namespace handles remain caller-owned. A failed push rejects every output waiting
on the covered object position and poisons the activation. Competing managed reads cannot continue
from its rejected speculative state.

It does not make arbitrary JS memory, outbound `fetch`, callback arguments, or stream producers
transactional. Response-stream work performed after the handler returns is outside the scope and
will require per-chunk tickets before claiming general streaming output coverage. Applications still
use durable hooks/outboxes plus idempotency for external effects. Returned capabilities inherit the
scope that created them and cannot be used after it closes, but the runtime does not discover and
automatically dispose arbitrary capabilities nested in RPC results. Raw in-memory capability methods
are not promised linearizable behavior across ownership changes.

Keep `blockConcurrencyWhile` as an initialization/explicit admission barrier with documented Node
semantics. It does not pause already-running native promise continuations. Registered `waitUntil`
work uses the same authority-bound database; on crash it is not itself durable unless it recorded an
outbox/job first. No automatic event-level rollback or serialization is added.

## 7. Routing, Cap'n Web, and lifecycle

Namespace lookup resolves an object identity, not a permanent node address. Authority-bound
namespace handles now resolve either a prepared local activation or an epoch/claim-bound remote
route. A fresh control snapshot supplies ownership and the owner's exact node lease for each new
handle; peer WebSocket sessions, not object routes, are cached by owner incarnation.

- MessagePort Cap'n Web sessions remain between the container and its workers.
- `src/rpc/node-peer-rpc.ts` owns authenticated persistent WebSocket sessions. Its HMAC handshake
  binds caller and receiver node IDs, process generations, compatibility versions, an issuance time,
  and a single-use nonce. The caller's durable lease must still be live.
- Remote object delivery carries object identity, expected epoch and claim, owner node incarnation,
  compatibility version, and the advertised WebSocket address. Receiver-side admission rereads the
  route, validates local and caller authority, and only then returns a capability for that
  activation.
- Explicit pre-delivery stale-route refusals trigger a bounded fresh resolution. Application method
  failures and ambiguous disconnects are not replayed. Because routes are not cached, the observed
  lease deadline bounds only the current resolution decision, not future namespace lookups.
- Preserve native capability lifetimes: a returned capability is tied to its activation/session. On
  worker loss or ownership change it breaks. Do not silently reconnect it to a different object
  instance. Reacquire a namespace handle for a new attempt.
- Retry only proven pre-delivery refusals or a connection failure known to have delivered nothing,
  with bounded attempts and a replayable request. A pipelined chain already emitted on a session,
  consumed request stream, or ambiguous disconnect is not transparently replayed.
- Validate peer identity and protocol at ingress. Use encrypted/private transport plus
  authentication; a private address alone is not authorization. Keep local module definitions
  application-owned.

`startAuthorityBoundGraftNodeObjectHost` is the reusable Node process shell around this protocol. It
binds separate application and internal HTTP listeners before publishing node authority. Only the
internal listener owns peer WebSocket upgrades. Application Fetch handlers receive an automatic
output gate and request-owned namespace handles; internal diagnostics remain available after
self-fencing and internal commands retain explicit runtime authority checks. The host starts durable
alarm-work polling, rejects new requests and peer upgrades during shutdown, and coordinates both
listeners' cleanup. Its application-listener `GET /_runtime/ready` bypasses the application and
returns the leased node identity and process generation only while the host and authority are
serving. The read-only gateway forwards to the registered application origin without duplicating
application routes; internal HTTP origins need not be stored in the control schema. The application
maps failures that can occur after its handler returns, including output durability failures,
without performing more object RPC. The low-level runtime and `acceptNodePeerWebSocket()` remain
available for custom hosts.

Graceful container drain: stop ingress/producers, let callers finish RPC and streams, drain
registered background work, close workers, and conditionally release ownership while authority
remains valid. The Node host waits for active Fetch handlers within the caller's required
`maximumDrainDurationMs`. Deadline expiry rejects the close promise while cleanup remains in the
terminal draining state; a container supervisor may then terminate the process and let lease expiry
recover unfinished ownership. A returned response stream or retained capability remains
caller-coordinated because its lifetime is not represented by the Fetch promise. Do not extend
`cleanup()` into a patched Cap'n Web session drain or install library-owned process signal handlers.

Resident activations now track active event count, open output scopes, registered pending work, and
the monotonic time of their last completed activity. Completed `waitUntil` and initialization work
also advances that local activity time. `NodeObjectActivationEvictionPolicy` can disable eviction,
expose caller-driven deterministic sweeps, or schedule automatic sweeps with configurable sweep and
idle durations. This activity is intentionally process-local; eviction does not add a control-plane
write to every object event.

An idle sweep quiesces a worker only when it has no admitted event, open output scope, or registered
pending work and its last completed activity is at or before the configured cutoff. Quiescing
rejects new worker delivery, waits for already admitted work, confirms the committed object
position, conditionally releases exact authority, closes the database, and terminates the worker.
Durable object state, canonical provisioning, and future alarms remain intact; the next namespace
lookup or alarm activation restores a fresh instance. A future scheduled alarm does not pin a
resident worker.

Retaining an unused capability does not pin an activation. Active direct capability calls count as
work, but retained capabilities and post-return streams remain activation-bound and can break after
idle eviction. There is still no live migration with outstanding capabilities or transparent replay
of failed calls. Capacity-aware admission, planned handoff, and individual unexpected worker-death
replacement remain follow-up work.

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

Cursor-based due-alarm and reconciliation scans have replaced activate-everything discovery. Local
timers may accelerate discovery, but every acknowledged installation must remain recoverable with no
resident worker and no local files.

The implemented first slice uses one `node_runtime_object_alarm_work` row as both reconciliation
marker and scheduled discovery entry. Authority-bound alarm installation, deletion, and successful
consumption are serialized and force an immediate object-log push before completing that row. This
is deliberately less optimized than deferring publication to the enclosing Fetch output gate, but it
closes the cross-database crash window with substantially less machinery. Each installation has a
UUID, so completion of an old handler cannot remove a same-timestamp re-arm.

Each host scans a bounded object-ID cursor page and services rows owned by its exact node generation
or eligible for local claim/takeover. Live remote-owner rows are left for that owner's scanner.
Activation republishes the authoritative object alarm before readiness. Handler failure leaves the
scheduled row due for the next poll; persisted backoff, scanner partitioning, and peer alarm-wake
RPC remain follow-up work. Real child-process scenarios kill an owner before and after the object
push, delete every local cache, and prove false-positive repair or durable alarm discovery
respectively.

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

The authority-bound takeover scenarios use production worker threads inside independent child
processes and a real push barrier. They prove both stable-log orderings: an old append that lands
first is preserved when the replacement reclones and retries its fence, while a replacement fence
that lands first makes the paused old append diverge. In both cases the old output reports failure,
the successor serves from epoch 2, every local cache is deleted, and a third process restores the
authoritative data under epoch 3.

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

| Phase                           | Deliverable                                                                                            | Acceptance criterion                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Qualify Graft                | Native loader/configuration, managed connection spike, real backend scenarios                          | Node 24, concurrent object workers/control connection, remote conflict and uncertain-push recovery pass; driver/topology decisions recorded.                                                              |
| 1. Per-object persistence       | One object database with runtime tables and managed Fragment SQL; explicit durable commit boundary     | Write real Fragment data, minimal KV, and an alarm; destroy the entire local cache; restore data from the same object remote log. Failed push cannot return success or leak through a later managed read. |
| 2. Graft control store          | Fleet bootstrap, schema, receipts, pull/transaction/push commands                                      | Independent control clients race conflicting and unrelated updates; all successful outcomes exist in one remote history, losing commands recompute, unknown outcomes are not guessed.                     |
| 3. Authority and local takeover | Node leases, fresh epochs, `restoring`/`ready`, fencing commits, terminal authority loss               | Two containers contend; one ready epoch. Pause an old owner, take over, resume it: stale writes cannot append after the successor fence.                                                                  |
| 4. Peer routing                 | Resolver, bounded caches, authenticated Cap'n Web peer sessions                                        | Requests arriving at either node reach the owner; stale pre-delivery routes refresh; callbacks/capabilities/streaming work; ambiguous operations are not replayed.                                        |
| 5. Durable scheduling           | Alarm reconciliation intents, due index, retry, production scheduler integration                       | Crash at every publication/consumption boundary; fresh containers rediscover acknowledged alarms; old cleanup cannot remove a re-arm.                                                                     |
| 6. Fleet scenarios and drain    | Runtime-owned Node host, multi-process test runner, fresh-cache restart, graceful drain/forced fencing | Whole-fleet cache loss preserves all successful writes; host shutdown stops admission without hanging on peer sessions; existing caller-coordinated cleanup and `.dup()` ownership tests remain valid.    |
| 7. Deployment qualification     | Container native packaging, readiness/drain wiring, metrics, load/failure soak                         | Control throughput and renewal headroom meet the declared fleet target; actual backend fault tests pass; no persistent volume required.                                                                   |

The implemented Phase 1 slice provisions a Graft control directory, creates one Graft database per
object, exposes synchronous SQL through `state.storage.sql`, stores the narrow KV/alarm surface with
the object, and proves fresh-cache recovery plus fail-closed push errors. An importable
`GraftDatabaseOperations` collaborator isolates management pragmas; a recording decorator around the
real implementation proves that separate internal RPC calls share one push at their external output
boundary, concurrent writer scopes can share a push, and readers wait for exactly the storage
positions their outputs can reveal: an intermediate-state reader proves that state durable, while a
reader that completed before a later write does not wait for it. It does not yet provide a Fragno
SQL adapter.

The implemented Phase 2 control-store slice persists process-incarnation leases, object ownership
states, decimal-string epochs, and command receipts. Every named command starts from a clean clone,
commits its decision and receipt together, and reconciles failed push responses through a fresh
remote snapshot before semantically retrying. Lazy provisioning pushes a candidate object database
before the registration command selects its canonical mapping. Independent child-process scenarios
prove concurrent candidate selection, claim serialization, lost-response receipt recovery, lease
renewal, conditional release, expired owner takeover, and rejection of a late predecessor
completion.

The implemented Phase 3 slice registers runtime-owned renewable node authority, claims an object as
`restoring`, pushes the exact epoch/node/generation/claim into the object database, initializes the
production worker, and publishes `ready` before RPC admission. `src/graft/graft-node-authority.ts`
keeps the prior confirmed monotonic window during unconfirmed renewal and retries the same semantic
command/receipt. Confirmation never resets the TTL at response time or revives a fenced generation.
System runtimes schedule renewals and a separate self-fencing watchdog; manual runtimes use
`tick()`.

`src/sqlite/managed-node-runtime-object-database.ts` accepts only deadline extensions for the exact
node generation, never for an expired activation. Storage, events, and managed output check
authority; `src/rpc/node-message-port-rpc.ts` also rejects replies queued across main-thread
suspension. Terminal fencing aborts sessions and retires workers. Healthy cleanup keeps renewing
during caller-coordinated drain, then conditionally releases exact shutdown claims. A divergent
application push poisons the activation and is never rebased. Real scenarios prove renewed worker
authority, delayed/lost renewal responses, skew-aware takeover cutoffs, wall-clock movement,
suspension, retained-handle rejection, and graceful replacement, alongside both append orderings and
cache-loss recovery.

The implemented Phase 4 functional slice resolves remote ready/restoring owners through stock Cap'n
Web over authenticated WebSockets. Namespace calls preserve callbacks, returned capabilities,
promise pipelining, structured values, and Request/Response streams across the peer and worker
sessions. Request/Response forwarding creates fresh stream wrappers at each RPC boundary because a
stream deserialized from one Cap'n Web payload cannot be directly re-exported through another
session. Receiver admission validates the exact route and both nodes' authority, retained handles do
not reconnect after activation loss, and only explicit pre-delivery stale-route refusals are
retried. The standalone two-server walkthrough places objects on separate owners, performs a
multi-owner request, routes capabilities and streams, hard-kills one owner, takes over after expiry,
deletes all caches, and restores state in a third process.

The runtime-owned Node host now binds application HTTP and peer WebSocket ingress on one listener,
derives the advertised address after binding, generates process incarnations, starts durable alarm
work polling, gates startup/shutdown admission, and closes peer transport before waiting for the
listener to finish. The standalone Hono demonstration now supplies only its application Fetch routes
and process signal wiring. This host does not make post-return streams or retained capabilities
implicitly drainable.

The implemented Phase 5 correctness slice stores exact alarm installations in object logs and one
reconciliation-or-scheduled work row in the control log. Alarm mutations force an immediate durable
object barrier before publishing discovery state. Bounded owner-local scans activate unowned or
expired-owner objects through the ordinary fencing protocol, and activation repairs unfinished
markers before readiness. Scenarios prove process death on both sides of the object push, total
cache deletion, fresh-node delivery, at-least-once retry after handler failure, and survival of a
handler re-arm. Persisted retry backoff, peer wake delivery, scan partitioning, and the remaining
fault matrix are not implemented.

The peer fault matrix is not complete: authentication rejection, stale-route races, proven
no-delivery connection failure, post-delivery response loss, and partially consumed request streams
still need dedicated deterministic scenarios. Broad activation crash-window coverage and safe orphan
candidate-log collection also remain. Control commands still perform synchronous native SQLite work
on the main thread; the proposed control worker and fleet latency qualification are not implemented.
The unbound single-owner API has been removed; all callers now exercise authority-bound serving.
Distributed rollout still requires alarm retry/load qualification and production backend
qualification.

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
    node-object-runtime-host.ts            # Node HTTP, readiness, alarms, and drain shell
    node-object-worker.ts                  # authority-bound DB bootstrap
  rpc/
    node-message-port-rpc.ts               # retain stock Cap'n Web
    node-peer-rpc.ts
    node-peer-websocket-server.ts          # Node HTTP upgrade adapter
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
- Remaining alarm completion/control-response crash windows, same-timestamp re-arm under competing
  events, and competing scanners. The implemented scenarios already cover pre-object-push and
  post-object-push process death, fresh-cache delivery, handler retry, and handler re-arm survival.
- Returned capability survives ordinary use but breaks on activation loss; new namespace lookup
  resolves the replacement. Disposing one duplicate still leaves other callers valid.
- Idle activation sweep skips admitted events, open output scopes, and registered pending work;
  durable state and scheduled alarms survive eviction and restore under a fresh activation.
- Peer authentication failure, stale route, no-delivery connection failure, post-delivery response
  loss, and partially consumed streaming request. Assert allowed retries and uncertain outcomes.
- Full fleet termination, deletion of all caches, fresh-container recovery of Fragment data and
  pending alarms. No success depends on a previous container's filesystem.

## 12. Operational constraints and follow-up work

Measure control-command latency/conflicts/retries, renewal headroom, fence reasons, object
activation latency, Graft push latency, uncertain outcomes, cache growth, alarm reconciliation age,
and peer retry classification. Include node incarnation, object identity, epoch, control command ID,
and activation ID in traces; never credentials or application values by default.

Readiness requires a bound listener, installed peer upgrade ingress, confirmed node authority, a
compatible control schema, and functioning peer routing. The Node host resolves its advertised peer
address from the actual bound port before registering authority and does not expose the application
handler until runtime construction succeeds. Liveness must not keep a fenced incarnation serving.
Resource limits bound resident workers, in-flight activations, local cache usage, and background
scans. Idle eviction bounds inactive resident workers by time but is not a substitute for a hard
resident-worker limit or capacity-aware admission.

Expect a remote round trip on each committed write and multiple remote operations on cold
activation/alarm publication. That is an intentional initial cost. Batch only within existing
transaction boundaries; do not acknowledge early and hope a later upload succeeds. The shared
control log may become the first scaling bottleneck, particularly with frequent alarms.

Keep these as explicit later work:

- Backoffice composition/adapters/migrations and the mapping of existing shared database scopes.
- Capacity-aware placement, retained-capability and post-return stream lifetime accounting beyond
  active calls, and planned handoff.
- Control-plane sharding if measured workload requires it.
- Application idempotency improvements and durable cancellation where independently required.
- Safe remote garbage collection, backup/restore procedures, and a reviewed dependency upgrade path.

No follower durability, turns, or exact KV compatibility is a prerequisite for any of these.

## 13. Source map

This plan combines inspected behavior with implemented and proposed protocol work. The current
fence, lease, routing, provisioning, host, output-gate, and minimal alarm protocols are runtime
behavior proven in package scenarios, not capabilities supplied directly by Graft.

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
