# Query-Driven Stream DB Refactor Plan

## Status

Feasibility gates evaluated July 21, 2026 against:

- TanStack DB `f42db5ca` (`@tanstack/db` 0.6.16 and `@tanstack/db-sqlite-persistence-core` 0.2.8);
- Durable Streams `a172acc3`.

**Verdict:** the architecture is feasible without upstream changes, but not by wiring the current
persistence runtime unchanged. Gate 1 requires direct public collection adapters instead of derived
views. Gate 2 passes at the public SQLite adapter layer. Gate 3 requires Fragno-owned subset
lifecycle handling, and gate 4 requires a Fragno-owned observation-batching boundary.

This plan supersedes the **client materialization architecture** in `STREAM_DB_REFACTOR_PLAN.md`.
The State Protocol route, codecs, validation rules, consumer semantics, checkpoint guarantees, and
public naming remain valid.

## Problem

The current implementation treats TanStack SQLite persistence as an eager cache:

- `src/tanstack/materialized-state-runtime.ts` restores every persisted row;
- `src/tanstack/state-sink.ts` keeps every row in `materializedRows` and one TanStack source
  collection;
- every public table view is started during preparation;
- `adaptStateMaterializationPlan()` scans all materialized rows for every batch.

Memory is therefore `O(total rows)`, startup is `O(total rows)`, and batch adaptation is currently
`O(total rows + batch size)`. This defeats TanStack DB's query-driven synchronization model.

## Target architecture

```text
Durable State stream
  -> parse and validate complete batch
  -> atomically materialize rows + checkpoint in SQLite
  -> publish committed change metadata

TanStack live query
  -> request subset with where/orderBy/limit/cursor
  -> execute subset query against SQLite
  -> hydrate only matching rows into TanStack
  -> maintain the active result with differential dataflow
```

SQLite owns the complete client materialization. TanStack owns only active query subsets and their
incremental views.

### Required complexity

- startup without active queries: `O(metadata)` memory and work;
- query activation: `O(requested subset)` memory;
- stream batch: `O(batch size + affected active subsets)`, never `O(total rows)`;
- permanent memory: `O(active subsets + query-engine state)`, never `O(total rows)`;
- no unfiltered `loadSubset({})` unless the application explicitly requests the full collection.

## Public semantics

Keep the current public names:

- `state`, `streamOptions`, `stream`, `collections`, `status`, `offset`;
- `syncOnce()`, `drain()`, `close()`, `subscribeStatus()`;
- `utils.awaitTxId()`.

Change lifecycle meaning where required:

- `db.preload()` synchronizes the durable SQLite materialization through an up-to-date checkpoint;
  it does **not** hydrate every collection into memory;
- a live-query preload requests and hydrates only its query subset;
- `offset` advances only after the SQLite row/checkpoint transaction commits;
- query readiness waits for both subset hydration and the required stream checkpoint;
- direct `collection.get(key)` only reflects rows currently loaded by active subsets; primary-key
  reads must use a query that can request that key.

Query-driven mode requires SQLite persistence. If bounded in-memory replication remains useful,
expose it as a separately named API rather than an implicit fallback.

## Feasibility gates

The spikes are complete. TanStack provides useful pieces, but its current persistence runtime does
not satisfy the target complexity and atomic-observation guarantees as a complete unit.

### 1. Query-pushdown integration — compatible through a direct adapter

**What passes**

A live query whose source is a direct `syncMode: "on-demand"` collection passes normalized `where`,
`orderBy`, `limit`, and cursor/offset constraints to `loadSubset()`. TanStack's existing tests cover
direct queries, subqueries, ordered limits, and lazy join-key loading. The SQLite expression
compiler supports nested JSON paths, so Fragno can translate:

```text
public field: name
stored field: row.name
implicit filter: tableKey = <physical table key>
```

by prefixing public `PropRef` paths with `row`, transforming order/cursor expressions the same way,
and adding the physical table predicate.

**What fails**

Outer query constraints do not propagate through a derived live-query collection. A focused spike
using the current Fragno shape observed the canonical source receive only its intrinsic
`tableKey = users` predicate; the outer `name = Ada`, `orderBy(age)`, and `limit(10)` were absent.
The public table collections therefore cannot remain derived views over one canonical TanStack
source.

The SQLite adapter also does not yet provide strict bounded pagination. Its `loadSubsetInternal()`
pushes supported `where` and `orderBy` expressions into SQL, but fetches all matching rows and
applies `limit`/`offset` in JavaScript. Cursor loading performs the same broad reads before merging
and sorting in memory. Unsupported expressions also fall back to an unfiltered SQL read followed by
JavaScript evaluation. Consequently a limited query can still do `O(all matching rows)`
deserialization and memory work.

**Decision**

Replace derived table views with direct on-demand public collections backed by a Fragno-owned
canonical-row projection adapter. This is a local architecture change, not a Fragno/TanStack
incompatibility: the direct collection receives the normal TanStack subset request, and the adapter
rewrites that request before delegating to SQLite.

The current TanStack SQLite adapter still returns only the requested subset to the collection, so
retained TanStack memory remains subset-sized. Its broad internal read is a query-work caveat. If
the strict `O(requested subset)` transient-work requirement must hold immediately, implement a
dedicated Fragno SQLite subset executor behind the Fragno persistence contract. No upstream change
is required.

### 2. Storage-only stream commits — adapter pass, coordinator partial

**What passes**

The public `PersistenceAdapter.applyCommittedTx(collectionId, tx)` API is already a storage-only
commit path. `SQLiteCorePersistenceAdapter.applyCommittedTx()` runs the following in one SQLite
transaction:

- optional truncate/reset;
- all row mutations;
- row and collection metadata mutations;
- collection row-version and leader-term updates;
- the applied-transaction replay record.

The Fragno checkpoint can be another canonical row in the same `PersistedTx`. Awaiting
`applyCommittedTx()` is an exact acknowledgment that this SQLite transaction committed, and the call
does not hydrate a TanStack collection. Targeted patch materialization can use `loadSubset()` with
key predicates before constructing the final transaction.

**What is incomplete**

The optional coordinator API is narrower. Browser and Electron coordinators implement
`requestApplyLocalMutations()`, but it accepts ordinary row mutations only: no truncate, row
metadata, collection metadata, caller-supplied transaction identity, or complete `PersistedTx`.
`SingleProcessCoordinator` does not implement it. The coordinator implementations assign and
broadcast positions only through that narrow method.

**Decision**

Gate 2 does not require private TanStack runtime access. Fragno will serialize commits under its
existing stream-leader ownership, call the public adapter directly, and publish a Fragno commit
message after the await. It will not depend on the narrower coordinator mutation RPC.

### 3. Active-subset invalidation integration — partial, lifecycle gaps

**What passes**

For active subsets, `PersistedCollectionRuntime` already:

- evaluates changed rows against every active non-paginated predicate;
- inserts/updates rows that match;
- deletes loaded rows that no longer match;
- applies deletes directly;
- reloads active subsets for paginated windows or large/full-reload transactions;
- propagates persisted index definitions to the adapter.

This covers enter, update, leave, delete, and ordered/paginated refresh semantics when committed
messages use the public collection's row shape.

**What fails the target architecture**

- `unloadSubset()` removes only the active-subset registration. It does not evict rows that are no
  longer owned by any active subset, so memory grows with the union of previously loaded subsets.
- `reloadActiveSubsetsUnsafe()` substitutes `[{}]` when there are no active subsets. A reset,
  sequence gap, large transaction, or explicit full reload can therefore hydrate the entire
  collection while no query is active.
- Paginated invalidation reloads every active subset, not only the affected window.
- Active subsets and targeted invalidation are private runtime state. A canonical-row projection
  adapter cannot ask the runtime to invalidate several public collections inside one shared
  observation batch.
- The local-only persisted options default `gcTime` to `0`, while TanStack lifecycle semantics treat
  non-positive values as disabling GC; that does not provide an eventual memory bound.

**Decision**

Do not treat current active-subset tracking as sufficient for the permanent-memory requirement. The
Fragno public collection adapter must explicitly track subset ownership, evict unowned rows, and
never translate a zero-subset refresh into `loadSubset({})`. TanStack remains responsible for query
planning and differential dataflow; Fragno owns the storage projection and subset lifecycle.

### 4. Fragno cross-table atomic observation — feasible only with batching

A shared canonical source transaction is not by itself an atomic observation boundary. A focused
TanStack spike updated a user and task in one source sync commit while a join consumed two derived
table views. Without an ambient TanStack transaction, the join emitted an intermediate
`Bob / Old task` state before the final `Bob / New task` state.

Wrapping the exact same source sync commit in a public `createTransaction().mutate()` scope caused
the transaction-scoped scheduler to coalesce the derived graphs and emit only the final joined
state. This proves the query engine can preserve the guarantee when every affected collection is
updated synchronously under one scheduler context.

The current persistence invalidation path cannot supply that boundary across public collections:
each collection receives and processes coordinator messages asynchronously through its own mutex.
Using an empty optimistic transaction merely as an external sync batching primitive is also not an
obvious long-term API contract.

**Decision**

The query-driven implementation must durably commit first, then synchronously apply all affected
active-subset changes inside one observation batch. Encapsulate the tested
`createTransaction().mutate()` scope in a clearly named Fragno helper and add a permanent test that
rejects intermediate join states. The helper is an implementation detail and does not expose
optimistic transaction semantics through the Stream DB API.

### Overall feasibility decision

Keep one canonical SQLite collection for rows plus checkpoint atomicity, but do not keep one derived
TanStack source collection. Public Fragno collections must be direct on-demand sources that project
their subset requests into the canonical SQLite shape. Stream commits and public-memory observation
must remain separate phases:

1. targeted reads for affected patch keys;
2. one storage-only canonical SQLite transaction;
3. one synchronous cross-table TanStack observation batch affecting active subsets only;
4. follower notification after durable commit.

The production rewrite should start only after choosing concrete implementations for:

- SQL-bounded limits/cursors;
- subset ownership and eviction;
- zero-active-subset invalidation;
- the cross-collection observation-batching boundary.

### No-upstream implementation choices

1. **Direct public collections**
   - replace derived views with `syncMode: "on-demand"` collections;
   - translate public expressions to canonical SQLite paths in Fragno.
2. **Storage-only commits**
   - call the public persistence adapter directly under Fragno's existing leader ownership;
   - publish Fragno commit metadata only after the SQLite await resolves.
3. **Subset lifecycle**
   - track active subset requests and the keys each request owns;
   - evict keys after their final owner unloads;
   - do nothing when a refresh occurs with zero active subsets.
4. **Atomic observation**
   - synchronously apply all affected public collection changes inside one encapsulated TanStack
     transaction scope.
5. **Bounded SQLite execution**
   - initially delegate to the existing adapter if subset-sized retained memory is sufficient;
   - add a Fragno-specific SQLite subset executor if benchmarks require strict subset-sized
     transient work as well.

### Durable Streams conclusion

Durable Streams does not provide an alternative query-driven storage layer. Its current
`MaterializedState` owns nested in-memory maps, and `createStreamDB()` owns one eager TanStack
collection per state type plus process-lifetime key and transaction-ID sets. Its State Protocol and
public API concepts remain the alignment target, but none of the four storage/query feasibility gaps
are solved there.

## Implementation layers

### SQLite materialization store

Add a dedicated store that owns:

- canonical row IDs and table keys;
- SQLite subset reads;
- batch row lookup for patch materialization;
- atomic row and checkpoint writes;
- persisted indexes requested by TanStack queries;
- exact commit acknowledgment.

Patch processing must read only keys affected by the batch. Split the current planner into:

1. pure event parsing that collects operation intents and required existing keys;
2. targeted SQLite reads for those keys;
3. pure validation and final row planning;
4. one atomic SQLite commit.

Remove the full `materializedRows` map.

### Query-driven TanStack adapter

Each public collection must use `syncMode: "on-demand"` and provide `loadSubset`/`unloadSubset`.
`loadSubset` must:

1. add the physical table constraint;
2. translate public row paths to the canonical stored-row paths;
3. execute the query in SQLite;
4. unwrap stored rows into public Fragno rows;
5. write only that subset into the TanStack collection.

Do not call public collection `preload()` from database startup.

### Stream runtime

Retain the transport, status, transaction-ID, and leadership layers. Replace the current in-memory
sink call with:

1. parse batch;
2. commit batch to the SQLite materialization store;
3. accept durable checkpoint;
4. notify active subsets;
5. resolve transaction IDs;
6. invoke `onBatch`.

### Coordination

Only the leader consumes and writes the stream. Followers receive committed checkpoint/change
metadata and refresh only affected active subsets from SQLite. Paginated subsets may reload; bounded
non-paginated subsets should use targeted invalidation.

## Code changes

### Remove or replace

- `src/tanstack/materialized-state-runtime.ts` eager hydration and source ownership;
- `src/tanstack/state-sink.ts` `materializedRows`, `restorePersistedMaterializedRows()`, and
  `adaptStateMaterializationPlan()`;
- automatic startup of every table collection;
- the per-batch full existing-key scan;
- unbounded observed transaction-ID retention.

### Keep and adapt

- `src/consumer/durable-stream-consumer.ts`;
- `src/consumer/stream-status.ts`;
- `src/consumer/stream-offset.ts`;
- `src/coordination/coordinated-consumer.ts`;
- `src/coordination/coordinator-messages.ts`;
- `src/materialization/plan-state-batch.ts`, after splitting intent parsing from row lookup;
- `src/state/fragno-state-schema.ts`;
- `src/stream-db.ts` as the thin public facade.

The server route and projection remain unchanged:

- `packages/fragno-db/src/fragments/internal-fragment.routes.ts`;
- `packages/fragno-db/src/outbox/state-protocol.ts`;
- `packages/fragno-db/src/outbox/durable-streams.ts`.

## Reference implementations

### TanStack DB

- `@tanstack/db@0.6.16/src/collection/sync.ts`
  - `syncMode: "on-demand"`;
  - query-triggered `loadSubset()` and `unloadSubset()`.
- `@tanstack/db@0.6.16/src/query/compiler/index.ts`
  - query subset propagation and differential-dataflow compilation.
- `@tanstack/db-sqlite-persistence-core@0.2.8/src/persisted.ts`
  - `PersistedCollectionRuntime.activeSubsets`;
  - `hydrateSubsetUnsafe()`;
  - `applyTargetedInvalidationUnsafe()`;
  - paginated-subset reload behavior.
- `@tanstack/db-sqlite-persistence-core@0.2.8/src/sqlite-core-adapter.ts`
  - SQL-backed `loadSubset()` and persisted index handling.

Installed sources are under the repository's `node_modules/.pnpm/` directory.

### Upstream Durable Streams State

- `/Users/wilco/dev/durable-streams/packages/state/README.md`;
- `/Users/wilco/dev/durable-streams/packages/state/src/stream-db.ts`;
- `/Users/wilco/dev/durable-streams/packages/state/src/materialized-state.ts`;
- `/Users/wilco/dev/durable-streams/packages/state/STATE-PROTOCOL.md`.

Use upstream for State Protocol and public API overlap only. Its StreamDB is an eager in-memory
replica and is not the storage architecture for this refactor.

## Test requirements

Add integration coverage with a real Kysely SQLite server and real client SQLite persistence:

- startup with a large persisted dataset loads zero rows before a query;
- a limited query loads only its requested rows;
- primary-key and filtered queries push predicates into SQLite;
- an unrelated stream update does not increase in-memory collection size;
- rows correctly enter, update, and leave active query results;
- ordered and cursor-paginated windows refresh correctly;
- restart resumes from the checkpoint without full row hydration;
- multi-table batches remain atomically observable;
- leader/follower tabs share SQLite without duplicate stream consumption;
- failed SQLite commits do not advance offsets or update queries.

Instrument the persistence adapter in tests and fail on unrequested `loadSubset({})` calls.

## Completion criteria

The refactor is complete when:

- no runtime structure contains every materialized row;
- no startup path loads every persisted row;
- no batch path scans every persisted row;
- live-query predicates, ordering, and limits execute against SQLite;
- only active query subsets are represented in TanStack memory;
- differential dataflow updates those subsets after durable stream commits;
- rows and checkpoint remain atomic and exactly acknowledged;
- existing lifecycle, validation, coordination, and terminal-error guarantees still pass;
- memory and work scale with active queries and batch changes, not total database size.
