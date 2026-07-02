# Lofi local schemas implementation plan

Goal: support read-only local schemas whose rows are materialized transactionally from server outbox
mutations. No dependency tracking. No targeted rebuilds; schema/projection changes can be handled by
deleting the whole IndexedDB database.

## Constraints

- [x] Local schemas are queryable like normal Lofi schemas.
- [x] Local schemas are not submitted to the server and are not valid sync command targets.
- [x] Local rows are written only by local projection code during mutation application.
- [x] Applying server mutations and local projection writes happens in the same adapter transaction.
- [x] Rebuild support is limited to throwing away the whole IndexedDB database.
- [x] Projection code receives every applied mutation batch; filtering is user code.
- [x] Scenario tester supports local schemas and includes coverage for indexeddb, in-memory, and
      stacked clients.

## Slice 1: public types

- [x] Add `LofiLocalProjection` type.
  - [x] Inputs: applied mutation batch, local-schema read API, local write API, source mutation
        batch metadata.
  - [x] Local write API supports `create`/`update`/`delete` against registered local schemas.
- [x] Extend adapter options with `localSchemas?: LofiSchemaRegistration[]` and
      `projections?: LofiLocalProjection[]`.
- [x] Add tests that local schema names must be non-empty and unique across server + local schemas.

## Slice 2: projection application core

- [x] Add shared helper that validates projection writes target local schemas only.
- [x] Add shared helper that turns projection writes into internal `LofiMutation`s.
- [x] Add tests that projection writes to server schemas are rejected.
- [x] Add tests that projection reads/writes to unknown or non-local schemas/tables are rejected.

## Slice 3: IndexedDbAdapter transaction support

- [x] Register indexes for server schemas and local schemas in the same IndexedDB rows store.
- [x] Include local schemas in the schema fingerprint.
- [x] During `applyOutboxEntry`, apply known server mutations, run projections, then write local
      rows before committing the transaction.
- [x] Ensure inbox dedupe skips both server mutations and projections for already-applied entries.
- [x] Tests:
  - [x] synced server mutation materializes a local view row.
  - [x] duplicate outbox entry does not rerun projection writes.
  - [x] projection failure aborts the whole transaction, including server rows and inbox entry.
  - [x] local schema can be queried with existing `createQueryEngine(localSchema)`.

## Slice 4: InMemoryLofiAdapter support

- [x] Register local schemas in the same store metadata/index setup.
- [x] Apply server mutations and projection writes by staging local projection writes before
      mutating store state.
- [x] Tests mirror IndexedDB behavior for materialization, duplicate entries, abort-on-error, and
      querying.

## Slice 5: StackedLofiAdapter support

- [x] Pass local schemas/projections into base and overlay adapters where applicable.
- [x] Keep outbox sync writing to base only.
- [x] Ensure optimistic overlay reads can include local schema rows from base plus overlay.
- [x] Tests:
  - [x] stacked client queries local schema rows after sync.
  - [x] optimistic command projection affects overlay-local rows only until confirmed.
  - [x] confirmed command moves projected local rows into base and clears overlay state.

## Slice 6: Scenario tester API

- [x] Extend `ScenarioDefinition` with `localSchemas?: AnySchema[]` and
      `localProjections?: LofiLocalProjection[]`.
- [x] Pass local schemas/projections into all scenario adapter constructors.
- [x] Add `client.localQuery(schema)` or equivalent access in scenario context, without breaking
      existing `client.query`.
- [x] Allow scenario stores to target local schemas.

## Slice 7: Scenario coverage

- [x] Add scenario: server creates source rows, client syncs, local read returns materialized view
      rows.
- [x] Add scenario: server updates source row, client syncs, local view row updates.
- [x] Add scenario: server deletes source row, client syncs, local view row deletes.
- [x] Add scenario: two clients independently materialize the same read-only local view.
- [x] Add scenario: reactive store over local schema updates after sync.
- [x] Add scenario: stacked optimistic command updates local view before submit and reconciles after
      submit.

## Slice 8: docs and exports

- [x] Export local schema/projection types from `@fragno-dev/lofi`.
- [x] Add README example for a read-only materialized local view.
- [x] Document that projection/schema changes require deleting the whole IndexedDB database.
