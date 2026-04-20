# Fragno Lofi Canonical `find()` Rewrite — Implementation Plan

This plan rewrites `@fragno-dev/lofi` to follow the canonical `@fragno-dev/db` read API.

## Scope

The rewrite should make Lofi align with the current Fragno DB read surface:

- `find()` / `findFirst()` / `findWithCursor()` always use an explicit builder
- joins use `joinOne(...)` / `joinMany(...)`
- Lofi no longer depends on legacy relation-builder `.join((j) => ...)`
- Lofi no longer depends on legacy read-builder internals such as `FindBuilder` and
  `JoinFindBuilder`

This is a full runtime + test + docs migration, not just a search/replace cleanup.

## References

- `specs/spec-lofi.md`
- `specs/spec-lofi-submit.md`
- `specs/references/fragno-db-find-migration-checklist.md`
- `packages/lofi/src/query-types.ts`
- `packages/lofi/src/query/engine.ts`
- `packages/lofi/src/adapters/in-memory/query.ts`
- `packages/lofi/src/adapters/stacked/merge.ts`
- `packages/lofi/src/submit/local-handler-tx.ts`

## Goals

- Remove Lofi’s dependence on legacy DB read-builder APIs.
- Make the public Lofi query interface match the canonical DB read API.
- Preserve current IndexedDB, in-memory, stacked-overlay, optimistic submit, and scenario behavior.
- Rewrite test coverage so it validates canonical joins instead of legacy relation joins.
- Unblock later removal of legacy read-builder internals from `@fragno-dev/db`.

## Non-goals

- Reworking Lofi’s submit/conflict semantics.
- Redesigning overlay behavior or outbox semantics.
- Broad docs/template cleanup outside Lofi.
- Supporting both old and new join APIs long-term.

## Success Criteria

- No `packages/lofi/**` runtime code imports `FindBuilder` / `JoinFindBuilder` from
  `@fragno-dev/db/unit-of-work` for read execution.
- No `packages/lofi/**` code uses legacy `.join((j) => ...)`.
- No `packages/lofi/**` code uses builder-less `find("table")`.
- `packages/lofi` targeted `types:check` and `test` pass.
- Full repo `types:check`, `build`, `test`, and `lint` pass after the rewrite.

## Work Plan

### 1. Lock the target Lofi query API

- [ ] Update `packages/lofi/src/query-types.ts` so Lofi’s public query interface mirrors the
      canonical DB API only.
- [ ] Remove builder-less overloads from `find(...)` / `findFirst(...)` where Lofi still exposes
      them.
- [ ] Ensure join typing is expressed in terms of canonical join output, not legacy relation-join
      builder output.
- [ ] Audit `packages/lofi/src/types.ts` and related exports so downstream users only see the new
      read shape.

### 2. Introduce a canonical read-plan representation inside Lofi

- [ ] Add a shared internal representation for Lofi reads that captures:
  - root table
  - selected index / predicates
  - select clause
  - ordering
  - cursor pagination
  - nested `joinOne(...)` / `joinMany(...)`
- [ ] Build this around the canonical API shape instead of reconstructing legacy relation joins.
- [ ] If Lofi needs new support from `@fragno-dev/db`, add a minimal stable surface for the built
      canonical read description rather than reusing legacy read-builder internals.
- [ ] Keep this representation shared across IndexedDB, in-memory, stacked merge, and local submit
      execution so the semantics stay aligned.

### 3. Rewrite the IndexedDB query engine

- [ ] Refactor `packages/lofi/src/query/engine.ts` to execute canonical reads without instantiating
      legacy `FindBuilder`.
- [ ] Preserve support for:
  - `whereIndex(...)`
  - `select(...)`
  - `selectCount()`
  - `orderByIndex(...)`
  - `after(...)` / `before(...)`
  - `pageSize(...)`
  - nested `joinOne(...)` / `joinMany(...)`
- [ ] Keep `findFirst(...)` semantics aligned with the canonical API.
- [ ] Ensure returned row typing still matches current `FragnoId` / reference decoding behavior.

### 4. Rewrite the in-memory query engine

- [ ] Refactor `packages/lofi/src/adapters/in-memory/query.ts` to use the same canonical read-plan
      representation.
- [ ] Preserve parity with IndexedDB behavior for filtering, sorting, selection, counts, and
      pagination.
- [ ] Re-implement nested join expansion using canonical joins instead of legacy relation-builder
      callbacks.
- [ ] Keep behavior aligned for null / missing join targets and array joins.

### 5. Rewrite stacked merge around canonical joins

- [ ] Refactor `packages/lofi/src/adapters/stacked/merge.ts` so overlay/base merge logic works from
      canonical join nodes rather than relation-builder joins.
- [ ] Preserve existing stacked behaviors covered by tests, including:
  - overlay patching of joined rows
  - tombstones suppressing base rows
  - nested join patching
  - backfilling overlay-only rows
  - pagination with overlay rows present
  - join filters and ordering
- [ ] Make canonical join handling the only path in merge/backfill logic.
- [ ] Remove any dependency on legacy relation metadata that exists only to support old joins.

### 6. Rewrite local optimistic handler execution

- [ ] Refactor `packages/lofi/src/submit/local-handler-tx.ts` so optimistic local reads execute via
      the canonical Lofi read path.
- [ ] Remove translation through `JoinFindBuilder` / legacy compiled joins.
- [ ] Keep support for replaying browser-side `handlerTx()` reads used by submit/rebase flows.
- [ ] Preserve optimistic execution semantics for commands that read related rows before mutating.

### 7. Migrate tests to the canonical API

- [ ] Rewrite `packages/lofi/src/query/query.test.ts` to use canonical joins.
- [ ] Rewrite `packages/lofi/src/adapters/in-memory/query.test.ts` to use canonical joins.
- [ ] Rewrite `packages/lofi/src/adapters/stacked/adapter.test.ts` to use canonical joins.
- [ ] Rewrite `packages/lofi/src/adapters/stacked/merge.test.ts` to use canonical joins.
- [ ] Rewrite `packages/lofi/src/submit/local-handler-tx.test.ts` to use canonical joins.
- [ ] Rewrite `packages/lofi/src/testing/outbox-sync.test.ts` to use canonical joins.
- [ ] Rewrite `packages/lofi/src/testing/scenario.test.ts` remaining legacy reads to use canonical
      joins.
- [ ] Replace remaining builder-less test reads in:
  - `packages/lofi/src/adapters/in-memory/adapter.test.ts`
  - `packages/lofi/src/optimistic/overlay-manager.test.ts`
  - `packages/lofi/src/submit/client.test.ts`

### 8. Update public docs and examples in Lofi

- [ ] Update `packages/lofi/README.md` to show explicit-builder `find(...)` usage.
- [ ] Update README join examples to use `joinOne(...)` / `joinMany(...)`.
- [ ] Audit any exported snippets/examples in Lofi for legacy joins or builder-less reads.

### 9. Remove legacy coupling from Lofi runtime code

- [ ] Remove read-path imports of `FindBuilder` / `JoinFindBuilder` from Lofi runtime modules.
- [ ] Ensure any remaining DB dependency is on stable canonical read surfaces only.
- [ ] Verify Lofi no longer requires old relation-join helper behavior from `@fragno-dev/db`.

### 10. Validation and follow-up cleanup

- [ ] Run `pnpm exec turbo types:check --filter=@fragno-dev/lofi --output-logs=errors-only`
- [ ] Run `pnpm exec turbo test --filter=@fragno-dev/lofi --output-logs=errors-only`
- [ ] Re-scan `packages/lofi/**` for legacy `.join((j) => ...)` usage
- [ ] Re-scan `packages/lofi/**` for builder-less `find("table")` usage
- [ ] Update `specs/references/fragno-db-find-migration-checklist.md`
- [ ] Run `pnpm exec turbo types:check --output-logs=errors-only`
- [ ] Run `pnpm exec turbo build --output-logs=errors-only`
- [ ] Run `pnpm exec turbo test --output-logs=errors-only`
- [ ] Run `pnpm run lint`

## Suggested Execution Order

1. Lock the public/query typing surface.
2. Introduce the shared canonical read-plan representation.
3. Migrate IndexedDB and in-memory query engines.
4. Migrate stacked merge.
5. Migrate `local-handler-tx.ts`.
6. Rewrite tests.
7. Update README and migration checklist.
8. Run package-targeted validation, then repo-wide validation.

## Notes

- The biggest risk area is `packages/lofi/src/adapters/stacked/merge.test.ts`; treat it as the main
  semantic regression suite for overlay + join behavior.
- The most important runtime file is `packages/lofi/src/submit/local-handler-tx.ts`; once that is
  off legacy builders, the remaining DB-internal cleanup becomes much safer.
- If a small new helper/export is needed from `@fragno-dev/db` to represent built canonical reads,
  prefer adding that explicitly instead of letting Lofi keep reaching into legacy unit-of-work
  internals.
