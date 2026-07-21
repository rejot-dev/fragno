# Stream DB Refactor Plan

## Status

Implementation in progress. Last updated: July 21, 2026.

This package is pre-1.0. We will make breaking changes rather than preserve the current API, wire
format, persisted cache identity, or internal architecture.

### Progress

- [x] Add `@durable-streams/state` as the canonical State Protocol dependency.
- [x] Add the adapter-wide `/_internal/outbox/durable/state` projection route.
- [x] Project outbox mutations to standard change-event fields: `type`, `key`, `value`, and
      operation/txid/timestamp headers.
- [x] Add a versioned SuperJSON value codec without non-standard State Protocol headers.
- [x] Resolve outbox reference placeholders on the server projection boundary.
- [x] Implement `createFragnoStateSchema()` with explicit public collection names and upstream state
      event helpers.
- [x] Implement the pure protocol/materialization layer with complete-batch validation, reset
      controls, transaction IDs, and unknown-type handling.
- [x] Add the upstream-aligned `state`, `streamOptions`, `stream`, `collections`, `offset`,
      callback, and `utils.awaitTxId()` API.
- [x] Migrate the browser example and package README to the State Protocol API.
- [x] Change persisted source identity to include the canonical state registration fingerprint.
- [x] Extract stream offset validation, status control, transaction-ID waiting, and the
      transport-only Durable Stream consumer into the dedicated consumer layer.
- [x] Extract the TanStack source collection, derived views, hydration, checkpoint commit, and
      readiness bridge into `src/tanstack/`.
- [x] Add a live State Protocol integration test covering a real Fragno write, the production state
      projection route, the Durable Streams consumer, and the public TanStack collection.
- [x] Extract coordinator leadership orchestration into a dedicated coordinated-consumer runtime,
      with focused follower-promotion, request-retention, message-routing, and cleanup tests.
- [x] Add focused exact persistence acknowledgment, failed-write, shutdown-rejection, and provider
      resolution tests for `src/persistence/`.
- [x] Migrate the former schema-indexed suite to explicit State Protocol collection names, the
      production `/_internal/outbox/durable/state` route, and the public `state`, `streamOptions`,
      `collections`, and `subscribeStatus()` API. The test-only compatibility harness has been
      deleted.
- [x] Remove the temporary raw-outbox API overload, `schemas`, `forSchema()`, and `subscribe()`
      alias from the production package.
- [x] Remove raw-outbox parsing and materialization code from the production TanStack runtime.
- [x] Run persistence, coordination, lifecycle, and materialization integration contracts against
      the new public API, including a Kysely SQLite backend and Node SQLite frontend persistence.
- [x] Reduce `src/stream-db.ts` to the planned thin facade. Materialized collection preparation,
      hydration, observation, and atomic commits now live in
      `src/tanstack/materialized-state-runtime.ts`; coordinator checkpoint handling and
      batch/consumer lifecycle now live in `src/runtime/stream-database-runtime.ts`.
- [ ] Split the broad `stream-db.integration.test.ts` suite into smaller persistence, coordination,
      lifecycle, and end-to-end integration suites while retaining the concrete SQLite coverage.
- [ ] Add the remaining focused upstream-overlap contracts, especially positive existing-stream
      injection, callback ordering, live-mode forwarding, and replay-safe duplicate inserts.
- [ ] Replace the isolated TanStack lifecycle shim when TanStack exposes public asynchronous
      `markError(error)` and preload-error callbacks. Fragno public collection preloads reject
      through the stream lifecycle today, while arbitrary downstream TanStack live-query preload
      promises only expose first-ready callbacks; those collections still transition to `error`
      immediately.

### Phase status

- **Phase 0 — complete:** feasibility decisions are recorded. Complete update post-images are not
  currently available in the existing adapter mutation round-trip, so the temporary explicit patch
  envelope is the chosen extension. Event identity, SuperJSON representation, and checkpoint
  metadata behavior are implemented.
- **Phase 1 — complete:** the State Protocol projection, reference resolution, codec, route, route
  documentation, and server-side tests are implemented.
- **Phase 2 — complete:** the state registry and pure batch planner are implemented and covered by
  focused tests, including historical static-default and nullable-column replay. The raw planner has
  been deleted from the production runtime.
- **Phase 3 — complete:** offset, status, transaction-ID tracking, and the transport-only consumer
  are extracted. Focused unit tests and a live production-route integration test pass.
- **Phase 4 — core complete:** the authoritative source collection, derived public views, atomic
  checkpoint commits, readiness bridge, thin public facade, and new public API are implemented.
  Additional upstream-overlap contracts remain.
- **Phase 5 — complete:** persisted restore, canonical cache identity, exact write acknowledgment,
  scope isolation, version changes, failed writes, and close ordering are covered through the public
  API with the concrete Node SQLite provider. Exact acknowledgment is also isolated in focused
  `src/persistence/` tests.
- **Phase 6 — complete:** leader-only activation, follower promotion, request retention, coordinator
  subscription cleanup, message routing, terminal errors, and follower checkpoint readiness are
  isolated in `src/coordination/` or covered by concrete coordinator tests.
- **Phase 7 — complete:** the React SPA example, package README, route usage, package exports,
  changeset, production runtime, and integration tests use only the new API. The schema-indexed
  compatibility harness and raw-response projection adapter have been deleted.
- **Phase 8 — not started:** no upstream proposals have been opened yet.

### Latest validation

As of July 21, 2026:

- `@fragno-dev/tanstack-db`: 11 test files and 105 tests pass; package typecheck and build pass.
- `@fragno-dev/db`: 87 test files pass, 1 is skipped, and 1,525 tests pass; package typecheck and
  build pass.
- `example-apps/react-spa-tanstack-db`: typecheck passes against the new public API.
- Targeted Oxlint, formatting, and `git diff --check` pass for the changed implementation.

### Phase 0 decision: update post-images

The current mutation executor cannot produce complete update post-images for every database adapter
without broad executor changes or an additional round-trip. The first implementation therefore uses
a documented Fragno value-codec extension:

- creates use `mode: "row"` and contain complete visible non-ID values;
- updates use `mode: "patch"` and contain the committed patch;
- both remain standard State Protocol change events at the envelope level;
- the client codec materializes and validates the complete row before opening a TanStack
  transaction.

This is intentionally isolated in the protocol/materialization layer. Replace patch values with
complete update rows once the mutation executor can return post-images in the existing write
round-trip.

## Decision summary

Build a **Fragno-specific compatible superset** of upstream `@durable-streams/state/db`, rather than
wrapping or forking upstream's current `createStreamDB()`.

We will align with upstream wherever its concepts fit:

- use the Durable Streams State Protocol as the canonical stream event format;
- align public option names and return shapes with upstream;
- expose TanStack collections through `db.collections`;
- preserve upstream lifecycle meanings for `preload()`, `offset`, `stream`, and `close()`;
- use upstream state event types instead of defining equivalent Fragno types;
- add Fragno functionality through explicit extensions rather than changing the meaning of upstream
  concepts.

We will retain our own runtime because Fragno additionally requires:

- projection from Fragno schemas and table codecs;
- server-authoritative, read-only collections;
- complete row validation and external-ID/reference materialization;
- resumable persisted state;
- atomic row and checkpoint persistence;
- exact persistence acknowledgment before stream acknowledgment;
- one coordinated stream consumer across browser tabs;
- authoritative readiness and terminal error propagation;
- finite synchronization and deterministic test orchestration.

The implementation should make it possible to replace more of our runtime with upstream later if
upstream gains the required extension points.

## Why not wrap upstream `createStreamDB()` now

The shared Durable Streams transport is compatible, but upstream currently assumes a different state
source and weaker lifecycle guarantees:

- stream items are individual State Protocol events, while Fragno currently exposes outbox entries
  containing mutation arrays;
- upstream updates replace complete values, while Fragno outbox updates are patches;
- upstream has no persisted checkpoint or resume mechanism;
- upstream creates one independently committed TanStack source collection per state collection;
- upstream has no multi-tab leadership or follower readiness protocol;
- upstream requires explicit `preload()` to start the consumer;
- upstream does not provide the error and persistence boundaries required by Fragno;
- upstream collections are designed for optimistic mutation, while Fragno writes must go through
  server routes or sync commands.

Trying to wrap this implementation would move the current complexity into callbacks and lifecycle
workarounds. Instead, we will align at the **protocol and public-contract boundaries** while keeping
Fragno's stronger runtime semantics explicit.

## Target public API

The new API should resemble upstream usage while making the Fragno projection explicit.

```ts
import { createFragnoStateSchema, createFragnoStreamDB } from "@fragno-dev/tanstack-db";

const state = createFragnoStateSchema({
  comments: {
    schema: commentsSchema,
    table: "comment",
  },
  ratings: {
    schema: ratingsSchema,
    table: "rating",
    namespace: "tenant-ratings",
  },
});

const db = createFragnoStreamDB({
  streamOptions: {
    url: "/api/comments/_internal/outbox/durable/state",
    headers: { Authorization: `Bearer ${token}` },
  },
  live: "long-poll",
  state,
  persistence: {
    provider: persistence,
    scope: `account:${accountId}`,
    version: 1,
  },
});

await db.preload();

const comments = db.collections.comments;
console.log(db.offset);

await db.close();
```

### Upstream-aligned surface

Use the same names and meanings where possible:

```ts
type FragnoStreamDB<TState> = {
  readonly collections: CollectionMap<TState>;
  readonly stream: DurableStream;
  readonly offset: string;
  preload(): Promise<void>;
  close(): Promise<void>;
  utils: {
    awaitTxId(txid: string, timeout?: number): Promise<void>;
  };
};
```

Differences from upstream must only strengthen semantics:

- `preload()` waits for authoritative catch-up and required persistence commits;
- `close()` is asynchronous and completes cleanup and pending persistence work;
- collections are server-authoritative and do not expose Fragno-supported direct writes;
- `offset` is the latest durably accepted checkpoint, not merely the latest observed response.

### Fragno extensions

Keep Fragno-specific capabilities clearly named:

```ts
type FragnoStreamDBExtensions = {
  readonly status: FragnoStreamDBStatus;
  syncOnce(): Promise<FragnoStreamDBStatus>;
  drain(options?: { afterOffset?: string }): Promise<FragnoStreamDBStatus>;
  subscribeStatus(listener: (status: FragnoStreamDBStatus) => void): () => void;
};
```

The exact placement of advanced methods may change during implementation, but we should not overload
an upstream name with incompatible behavior.

### Removed current API

Make an atomic breaking migration:

- replace top-level `url`, `headers`, `params`, and `fetch` with upstream-style `streamOptions`;
- support upstream-style `stream` injection for an existing `DurableStream` instance;
- replace `schemas` plus `forSchema()` with an explicit `state` definition plus `db.collections`;
- replace `subscribe()` with the unambiguous `subscribeStatus()`;
- expose `offset` directly in addition to the richer status object;
- remove compatibility aliases after all repository consumers migrate.

Explicit state collection names solve table-name collisions across schemas and produce an obvious,
stable persisted collection identity.

## Canonical wire protocol

### Preferred direction

Expose an explicitly named Durable Streams State Protocol projection from Fragno's outbox. Do not
make the TanStack client understand raw outbox storage records.

Each mutation should become a standard upstream `ChangeEvent`:

```ts
{
  type: "fragno:<stable-table-identity>",
  key: externalId,
  value: completeMaterializedRow,
  old_value: previousCompleteRow, // optional
  headers: {
    operation: "insert" | "update" | "delete",
    txid: uowId,
    offset: mutationVersionstamp,
  },
}
```

The State Protocol event is the trust boundary between the server projection and the client. The
client should not need to know about:

- outbox entry IDs;
- SuperJSON envelopes;
- reference placeholder maps;
- create/update mutation storage shapes;
- database-only values such as unresolved `DbNow` expressions.

### Complete values, not patches

Upstream State Protocol updates replace the stored value. To align truthfully, insert and update
events should carry complete post-mutation rows.

Before implementation, prove that every Fragno database adapter can produce complete visible
post-images without adding an extra database round-trip. Preferred sources are mutation returning
values and values already available to the unit of work.

If an adapter cannot provide complete post-images, make that limitation explicit. Do not label a
patch as a standard `update` event. The fallback would be a documented Fragno protocol extension,
parsed in layer 1, until complete post-images are available.

### JSON codecs

State Protocol values are JSON values. Fragno rows can contain richer values such as `Date`.
`createFragnoStateSchema()` must therefore associate each collection with a codec that:

1. decodes the JSON wire value into the Fragno table's runtime row representation;
2. restores IDs and references as external ID strings;
3. validates the complete row with the table's Standard Schema boundary;
4. returns the exact row stored in TanStack DB.

The codec belongs to the Fragno state definition, not the stream consumer or TanStack sink.

### Stable event type identity

Define one canonical event type encoder using:

- logical schema name;
- normalized physical namespace;
- table name.

The encoding must be collision-free and tested with empty, null, and punctuation-containing names.
Consumers must not construct event type strings independently.

### Route naming

Expose a route whose name makes the projection explicit, for example:

```text
/_internal/outbox/durable/state
```

Do not silently change a route documented as returning raw outbox entries. Since this is pre-1.0, we
can remove or rename the current experimental route and migrate all callers atomically.

## Architecture

The runtime consists of four layers and a thin public facade. Dependencies flow downward; lower
layers never import the facade or higher layers.

```text
public facade
    |
    v
1. protocol + materialization
    |
    v
2. Durable Stream consumer
    |
    v
3. TanStack state sink
    |
    v
4. persistence + cross-context coordination
```

The consumer and sink communicate through small explicit contracts so each can be tested with
concrete in-memory collaborators.

## Layer 1: protocol and materialization

### Responsibility

Turn untrusted JSON stream items into a fully validated, deterministic state transition plan.

This layer owns:

- State Protocol structural parsing;
- event type routing;
- per-collection JSON decoding;
- complete row validation;
- insert/update/delete semantics;
- unknown event policy;
- transaction ID extraction;
- planning all changes before any TanStack transaction begins.

This layer does not import TanStack DB, persistence adapters, coordinators, or the Durable Streams
client.

### Suggested modules

```text
src/state/fragno-state-schema.ts
src/state/event-type.ts
src/materialization/parse-state-event.ts
src/materialization/plan-state-batch.ts
src/materialization/materialized-state.ts
```

### Core types

```ts
type ValidatedStateChange =
  | { type: "insert"; collection: CollectionIdentity; key: string; value: object }
  | { type: "update"; collection: CollectionIdentity; key: string; value: object }
  | { type: "delete"; collection: CollectionIdentity; key: string };

type MaterializationPlan = {
  changes: readonly ValidatedStateChange[];
  txids: readonly string[];
};
```

A plan is created completely before writes begin. Invalid events cannot leave a partially applied
TanStack transaction.

### Invariants

- Every non-delete value is a complete validated row.
- The event key equals the row's materialized primary key.
- Unknown event types follow one documented policy; the preferred default is to ignore unrelated
  event types but reject malformed events targeting a registered collection.
- Replayed inserts are idempotent and become updates when the same key already exists.
- Updates for missing rows follow the State Protocol's replacement semantics; choose either upsert
  or explicit rejection and test it. Prefer upstream behavior unless Fragno has a stronger
  invariant.
- Delete of a missing row is idempotent.
- Internal ordering metadata such as upstream's `_seq` must not leak into Fragno rows.

## Layer 2: Durable Stream consumer

### Responsibility

Own the transport session and convert Durable Streams response batches into ordered calls to the
materialization boundary.

This layer owns:

- lazy stream creation or reuse;
- finite reads and configured live mode;
- offset validation and monotonicity;
- abort and close behavior;
- initial catch-up detection through `batch.upToDate`;
- batching callbacks compatible with upstream;
- serialization of finite and live consumers;
- retry/terminal error classification supplied by the Durable Streams client.

This layer does not know about tables, schemas, TanStack collections, SQLite, or browser leadership.

### Suggested modules

```text
src/consumer/stream-offset.ts
src/consumer/stream-session.ts
src/consumer/stream-consumer.ts
```

### Consumer contract

```ts
type ConsumeBatch = (batch: JsonBatch<StateEvent>) => Promise<void>;

type StreamConsumer = {
  syncOnce(options: { offset: string; signal: AbortSignal }): Promise<void>;
  startLive(options: { offset: string; live: LiveMode; signal: AbortSignal }): Promise<void>;
  close(reason?: unknown): void;
};
```

The consumer must not advance its accepted offset itself. The sink returns only after a batch and
its checkpoint are safely accepted; only then may the runtime expose the new offset.

### Upstream-aligned callbacks

Support the upstream callback concepts with precise timing:

- `onBeforeBatch`: after transport parsing and before event materialization;
- `onEvent`: after an event passes structural parsing, before commit;
- `onBatch`: after the batch and checkpoint have committed successfully.

Our `onBatch` timing is intentionally stronger than upstream's current implementation and must be
documented.

## Layer 3: TanStack state sink

### Responsibility

Apply validated plans to one authoritative TanStack source collection and expose public table
collections as derived live-query views.

This layer owns:

- source collection creation;
- source sync handler activation;
- source row identity;
- atomic application of all collection changes in a response batch;
- atomic checkpoint writes;
- derived public collections;
- truthful TanStack readiness;
- narrow compatibility handling for missing public TanStack lifecycle APIs.

This layer does not parse stream JSON or understand browser leader election.

### Suggested modules

```text
src/tanstack/readiness.ts
src/tanstack/state-sink.ts
src/tanstack/materialized-state-runtime.ts
```

### One source collection

Retain the current single-source architecture rather than copying upstream's collection-per-event
source design.

One source collection gives Fragno:

- one atomic transaction for rows from every registered collection;
- one authoritative checkpoint;
- one persistence identity and schema version;
- one leader election group;
- derived joins that cannot observe tables persisted at different offsets.

Public `db.collections.*` values remain TanStack live-query collections projected from this source.

### Checkpoint

Store a versioned checkpoint in the same source transaction as row changes:

```ts
type StreamCheckpoint = {
  protocolVersion: 1;
  offset: string;
  cacheVersion: number;
  ownerId: string;
  generation: string;
  upToDate: boolean;
};
```

Prefer TanStack collection metadata as the canonical conceptual home. If a synthetic source row is
still required for reactive coordinator observation, isolate it behind the sink and do not expose it
to materialization logic or public collections.

### Readiness

Use `markReady()` only when the authoritative source has caught up and the required persisted
checkpoint has completed.

Do not use TanStack readiness as a proxy for local cache hydration.

Expected lifecycle:

```text
loading
  -> hydrate persisted source rows
  -> resume stream from persisted checkpoint
  -> apply responses through an up-to-date checkpoint
  -> await exact persistence acknowledgment
  -> mark source ready
  -> derived collections become ready
```

If TanStack still lacks a public asynchronous `markError(error)` API, isolate any use of internal
lifecycle APIs in `readiness.ts`, pin the supported TanStack version, and cover the shim with
focused contract tests.

## Layer 4: persistence and cross-context coordination

### Responsibility

Make accepted checkpoints durable and ensure one browser context consumes the shared stream.

This layer owns:

- persistence provider resolution;
- cache identity and version policy;
- persisted source hydration;
- exact checkpoint generation acknowledgment;
- leader election integration;
- follower checkpoint observation;
- follower promotion;
- terminal leader error messages;
- shutdown ordering.

It must not understand Fragno tables or parse State Protocol events.

### Suggested modules

```text
src/persistence/cache-identity.ts
src/persistence/persistence-tracker.ts
src/coordination/coordinated-consumer.ts
src/coordination/coordinator-messages.ts
```

### Cache identity

Build the persisted source collection ID from:

- persistence scope;
- stream URL or stable stream identity;
- canonical state registration fingerprint.

The registration fingerprint contains each public collection's:

- public collection name;
- event type;
- logical schema name;
- normalized namespace;
- table name.

Sort the representation before serialization. Registration order must not change identity.

`persistence.version` remains responsible for materialized row-shape changes.

### Exact persistence acknowledgment

Continue using checkpoint generations as exact barriers:

1. register the expected generation before TanStack commit;
2. write rows and checkpoint in one TanStack transaction;
3. observe the matching `PersistedTx` in the wrapped persistence adapter;
4. await that adapter write;
5. only then accept the stream offset and report readiness.

Do not replace this with a generic `waitForIdle()` call.

### Coordination messages

Keep coordinator payloads versioned and independently parsed:

```ts
type FragnoCoordinatorMessage = {
  type: "fragno-stream:terminal-error";
  version: 1;
  ownerId: string;
  offset: string;
  error: { name: string; message: string };
};
```

Reject or ignore malformed, stale, behind-checkpoint, and wrong-owner messages according to explicit
pure functions in `coordinator-messages.ts`.

## Public facade

`src/stream-db.ts` is the public facade. It:

1. defines the public option and result types;
2. validates creation options;
3. constructs or accepts the Durable Stream;
4. delegates runtime assembly to `src/runtime/stream-database-runtime.ts`;
5. returns the typed public API.

The session runtime wires the consumer and coordinator to
`src/tanstack/materialized-state-runtime.ts`, which owns collection construction, hydration,
observation, readiness, and atomic commits.

It should not contain event parsing, row materialization, persistence transaction inspection,
coordinator envelope parsing, or offset arithmetic.

The facade orchestration now reads approximately as:

```ts
assertValidCreateOptions(options);
const stream = createDurableStream(options);
return new StreamDatabaseRuntime({ ...callbacks, state: options.state, stream });
```

The runtime modules expose responsibilities rather than transport, persistence, or materialization
mechanics through the facade.

## Upstream dependency policy

### Depend on upstream protocol definitions

Import State Protocol types and guards from `@durable-streams/state`:

- `StateEvent`;
- `ChangeEvent`;
- `ControlEvent`;
- operation and header types where appropriate.

Do not copy these definitions into Fragno.

### Do not depend on upstream implementation internals

Do not import or copy upstream's `EventDispatcher`, internal sequence fields, or private lifecycle
assumptions.

### Contract tests against upstream behavior

Create a shared contract suite for the overlapping API:

- typed collections are available immediately after construction;
- no stream request occurs until activation;
- `preload()` waits for initial up-to-date state;
- insert/update/delete events materialize correctly;
- unknown event types are ignored;
- duplicate inserts are replay-safe;
- `offset` advances after accepted batches;
- `stream` injection works;
- `live` is forwarded correctly;
- callbacks fire in documented order;
- `awaitTxId()` resolves after the containing batch commits;
- `close()` rejects pending waits and stops transport work.

Fragno extension tests then specify stronger persistence, coordination, readiness, and validation
semantics.

## Activation policy

Align with upstream's lazy stream creation while preserving the more ergonomic Fragno behavior:

- construction creates collections but opens no stream request;
- `db.preload()` explicitly activates every collection and starts synchronization;
- subscribing to any public collection also activates the shared source automatically;
- `syncOnce()` requests finite activation;
- `drain()` never starts new work;
- once activated, the app-scoped runtime remains active until `close()`.

Automatic subscription activation is a Fragno extension, not a different meaning for `preload()`.

## Error policy

Represent runtime state explicitly:

```ts
type FragnoStreamDBStatus =
  | { status: "idle"; offset: string; error: null }
  | { status: "loading"; offset: string; error: null }
  | { status: "ready"; offset: string; error: null }
  | { status: "error"; offset: string; error: Error }
  | { status: "closed"; offset: string; error: null };
```

Rules:

- current terminal state takes precedence over historical readiness;
- a failed batch never advances the accepted offset;
- an initial failure rejects database and collection readiness calls;
- a post-ready terminal failure makes later readiness calls reject;
- `onError` fires once for each terminal transition;
- closing is not reported as a stream error;
- followers receive terminal leader failures and do not wait forever;
- transient retry behavior remains owned by the Durable Streams client.

## Transaction and visibility semantics

For each Durable Streams response batch:

1. parse every event;
2. decode and validate every targeted row;
3. build the complete materialization plan;
4. begin one source collection transaction;
5. apply changes in stream order;
6. write the checkpoint;
7. commit the source transaction;
8. await the exact persisted checkpoint generation when configured;
9. expose the new accepted offset;
10. resolve txid waiters;
11. mark ready when the accepted batch is up to date;
12. invoke the committed `onBatch` callback.

No public query may observe a checkpoint newer than its rows or rows newer than their checkpoint.

## Implementation phases

### Phase 0: feasibility decisions

- Prove complete post-image availability for create and update across SQLite, Postgres, and MySQL
  adapters without an extra round-trip.
- Decide the canonical event type encoding.
- Decide the JSON codec representation for dates and other non-JSON runtime values.
- Confirm whether TanStack metadata can be the canonical checkpoint while remaining observable by
  followers.
- Record any required upstream or TanStack API gaps.

Do not start the client rewrite until the full-row event decision is explicit.

### Phase 1: State Protocol server projection

- Add State Protocol types from `@durable-streams/state` to the relevant package dependencies.
- Implement pure outbox-to-state-event projection.
- Resolve references and database-generated values before serialization.
- Expose the explicitly named state projection route.
- Add protocol conformance and malformed-payload tests.
- Update the Durable Streams conformance fixture without preserving the experimental old format.

### Phase 2: state schema and pure materializer

- Implement `createFragnoStateSchema()`.
- Implement stable collection/event identities.
- Implement JSON codecs and complete row validation.
- Implement pure batch planning and in-memory materialized state.
- Port all create/update/delete/default/reference/date validation tests to focused colocated tests.

### Phase 3: Durable Stream consumer

- Extract offset parsing and comparison.
- Implement finite and live sessions independent of TanStack.
- Implement callback ordering, abort, and close behavior.
- Test against the concrete Durable Streams test server and the real Fragno route.

### Phase 4: in-memory TanStack sink

- Build the one-source collection and derived public collections.
- Implement atomic plan and checkpoint commits.
- Implement truthful readiness and terminal error propagation.
- Add upstream overlap contract tests.
- Migrate the example to the new `state` and `collections` API without persistence first.

### Phase 5: persistence

- Add canonical cache identity.
- Restore source rows and checkpoint from the resolved provider.
- Add exact checkpoint generation acknowledgment.
- Test reload, registration changes, scope isolation, version changes, failed writes, and close
  ordering with the concrete Node SQLite provider.

### Phase 6: coordination

- Add leader-only consumption.
- Add follower checkpoint readiness.
- Add terminal error propagation and stale-message guards.
- Add follower promotion without polling if the coordinator exposes an event; otherwise isolate the
  smallest required polling mechanism.
- Test with concrete coordinator instances rather than module interception.

### Phase 7: facade and repository migration

- Replace the current public API atomically.
- Migrate `example-apps/react-spa-tanstack-db`.
- Rewrite package documentation around State Protocol terminology.
- Remove `forSchema()`, old option names, old route usage, and compatibility code.
- Remove `ISSUES.md` and `FIXES.md` once their still-relevant invariants are represented by code,
  tests, or this architecture document.

### Phase 8: upstream contributions

Open focused upstream proposals for generally reusable gaps:

- custom event decoding or collection codecs;
- persisted checkpoint/resume support;
- asynchronous sink acknowledgment;
- public `markError(error)` support in TanStack sync adapters;
- subscription-driven shared consumer activation;
- asynchronous cleanup;
- an optional single-source/multi-view StreamDB architecture.

Adopt upstream implementations when they provide the same semantics. Delete corresponding Fragno
code instead of maintaining compatibility wrappers.

## Test organization

Co-locate tests with the layer they specify:

```text
src/state/fragno-state-schema.test.ts
src/materialization/plan-state-batch.test.ts
src/consumer/stream-consumer.test.ts
src/tanstack/state-sink.test.ts
src/persistence/persistence-tracker.test.ts
src/coordination/coordinated-consumer.test.ts
src/stream-db.integration.test.ts
```

Keep a smaller end-to-end suite for:

- real Fragno writes;
- real outbox projection;
- real Durable Streams reads;
- real TanStack live queries;
- real SQLite persistence;
- simulated multi-tab coordination.

Avoid one monolithic test file that requires understanding every layer to diagnose a failure.

## Non-goals

- Backward compatibility with the current experimental API or persisted cache.
- Direct client appends to the internal outbox stream.
- Upstream-style optimistic actions that bypass Fragno routes or sync commands.
- Generic conflict resolution in the Stream DB package.
- SSE support before Fragno's Durable Streams route supports it.
- Supporting arbitrary raw outbox payload consumers through the State Protocol route.

## Completion criteria

The refactor is complete when:

- the wire projection is a truthful Durable Streams State Protocol implementation;
- the public API uses `streamOptions`, `stream`, `state`, `collections`, `offset`, `preload()`, and
  `close()` with upstream-compatible meanings;
- Fragno-specific behavior is exposed through clearly named extensions;
- `src/stream-db.ts` is orchestration rather than implementation;
- protocol/materialization code has no TanStack or persistence dependencies;
- consumer code has no Fragno schema or TanStack dependencies;
- every accepted batch commits rows and checkpoint atomically;
- persisted readiness waits for the exact checkpoint write;
- only one coordinated browser context consumes the stream;
- followers become ready or fail deterministically;
- all repository consumers use the new API with no compatibility aliases;
- old implementation modules and obsolete design notes are removed.
