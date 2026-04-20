# Fragno DB `find()` migration checklist

The query-tree read API is now the canonical `find()` / `findFirst()` / `findWithCursor()` API in
`@fragno-dev/db`. `@fragno-dev/db` itself type-checks and tests cleanly after the rename, but the
rest of the monorepo still contains callers that rely on old relation-join behavior, builder-less
`find(...)` usage, or outdated docs/examples. This checklist tracks the remaining work before the
migration can be considered complete.

## Current status

- `@fragno-dev/db` package validation passes
- full repo `build` passes
- full repo `types:check` passes again after clearing the next surfaced blockers in
  `packages/resend-fragment`, `packages/github-app-fragment`, `packages/cloudflare-fragment`, and
  `packages/pi-fragment`
- targeted `test` runs now pass for `@fragno-dev/resend-fragment`,
  `@fragno-dev/github-app-fragment`, `@fragno-dev/cloudflare-fragment`, and
  `@fragno-dev/pi-fragment`
- `packages/fragno-test` blockers are fixed
- `packages/telegram-fragment` blockers are fixed
- `packages/lofi` typecheck blockers are fixed, and its local handler transaction bridge now
  translates relation-backed query-tree joins for optimistic execution
- `packages/auth` targeted `types:check` and `test` now pass after migrating remaining legacy joins
- latest repo scan shows the remaining old-style relation joins are concentrated in `packages/lofi`
  (40 hits, mostly tests plus the local-handler relation bridge)
- the same scan shows remaining builder-less `find(...)` calls in `packages/lofi` (4 test hits plus
  `packages/lofi/README.md`)

## Checklist

### Immediate repo type-check blockers

- [x] Migrate `packages/fragno-test/src/adapter-conformance.test.ts` off legacy `.join((j) => ...)`
      calls and rewrite the nested-read assertions to use query-tree joins
- [x] Migrate `packages/fragno-test/src/db-roundtrip-guard.test.ts` off builder-less
      `.find("users")` calls to explicit query-tree builders
- [x] Re-run full repo type-check after fixing the first `@fragno-dev/test` blockers
- [x] Migrate the first `packages/telegram-fragment` legacy relation joins surfaced by type-check
- [x] Continue with the next repo-wide blocker in `packages/auth`
- [x] Continue with the next repo-wide blocker in `packages/resend-fragment`
- [x] Continue with the next repo-wide blocker in `packages/github-app-fragment`
- [x] Continue with the next repo-wide blocker in `packages/cloudflare-fragment`
- [x] Continue with the next repo-wide blocker in `packages/pi-fragment`

### Remaining legacy relation-join migrations (`.join((j) => ...)`)

- [x] Migrate remaining legacy relation joins in `packages/auth/**`
- [x] Migrate remaining legacy relation joins in `packages/cloudflare-fragment/**`
- [x] Migrate remaining legacy relation joins in `packages/github-app-fragment/**`
- [x] Migrate remaining legacy relation joins in `packages/resend-fragment/**`
- [x] Migrate remaining legacy relation joins in `packages/telegram-fragment/**` (current scan is
      clean)
- [x] Migrate remaining legacy relation joins in `apps/docs/**` code examples and snippets
- [~] Decide what to do with legacy relation-join usage in `packages/lofi/**` (typecheck blockers
  fixed and optimistic execution now has a relation-backed query-tree bridge; current scan still
  finds 40 relation-join usages, mostly in tests plus the bridge)
- [ ] Remove old relation-join-only tests that no longer match the canonical API, or rewrite them as
      query-tree tests where equivalent coverage is desired

### Remaining builder-less `find(...)` call migrations

- [x] Replace builder-less `find(...)` usage in `apps/backoffice/app/fragno/automation/routes.ts`
- [x] Replace builder-less `find(...)` usage in `packages/pi-fragment/src/pi/test-utils.ts`
- [x] Replace builder-less `find(...)` usage in
      `packages/fragno-test/src/db-roundtrip-guard.test.ts`
- [~] Replace builder-less `find(...)` usage in `packages/lofi/**` where applicable (current scan
  finds 4 test call sites plus `packages/lofi/README.md`)
- [x] Replace builder-less `find(...)` usage in `packages/github-app-fragment/**` tests
- [~] Replace builder-less `find(...)` usage in docs/README examples such as
  `packages/lofi/README.md` (current scan only finds `packages/lofi/README.md`)

### Package-by-package migration backlog from the earlier repo scan

- [x] `apps/backoffice`
- [x] `apps/docs`
- [x] `example-fragments/fragno-db-library` (current scan clean)
- [x] `example-fragments/otp-fragment` (current scan clean)
- [x] `example-fragments/workflow-usage-fragment` (current scan clean)
- [x] `packages/auth`
- [x] `packages/cloudflare-fragment`
- [x] `packages/forms` (current scan clean)
- [x] `packages/fragment-mailing-list` (current scan clean)
- [x] `packages/fragment-upload` (current scan clean)
- [x] `packages/fragment-workflows` (current scan clean)
- [x] `packages/github-app-fragment`
- [x] `packages/pi-fragment`
- [x] `packages/resend-fragment`
- [x] `packages/stripe` (current scan clean)
- [x] `packages/telegram-fragment` (current scan clean)

### Documentation and examples cleanup

- [~] Update docs/examples that still describe the migration in terms of `findNew()` (current repo
  search only finds `specs/references/fragno-db-query-tree-join-api.md`)
- [x] Update docs/examples that still show relation-builder joins instead of query-tree joins
- [x] Update templates and example fragments to use canonical `find()` naming consistently
      (currently tracked examples are clean; deferred template follow-up is out of scope here)
- [~] Audit README / CLAUDE / MDX snippets for builder-less `find(...)` examples (current scan only
  finds `packages/lofi/README.md`)

### Internal cleanup after callers are migrated

- [ ] Remove the remaining legacy read-builder internals from
      `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts` (`FindBuilder`, `JoinFindBuilder`,
      related old retrieval plumbing) once no callers depend on them
- [ ] Remove old relation-join helper types from `packages/fragno-db/src/query/mod.ts` and
      `packages/fragno-db/src/query/find-options.ts` if they are no longer needed
- [ ] Decide whether legacy relation metadata should remain part of the query type surface, or only
      runtime schema metadata for non-query features
- [ ] Revisit `referenceColumn()` / reference-metadata follow-up if the long-term goal is to reduce
      schema-reference coupling further

### Final validation

- [x] Run `pnpm exec turbo types:check --output-logs=errors-only`
- [x] Run `pnpm exec turbo build --output-logs=errors-only`
- [ ] Run `pnpm exec turbo test --output-logs=errors-only`
- [ ] Run `pnpm run lint`
