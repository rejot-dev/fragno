# Fragno DB Outbox — Implementation Plan

Specs: [spec-outbox.md](./spec-outbox.md)

- [x] Add `fragno_db_outbox` table (including `refMap`) to `internalSchema` and update internal
      fragment services to include an outbox retrieval API (`outboxService.list`) as specified in
      `specs/spec-outbox.md` §5.4, §5.7, and §5.8.
- [x] Increment internal schema version and ensure migration generation includes the outbox table
      (update tests that assert settings migration ordering where needed).
- [x] Introduce `OutboxConfig` in `SqlAdapterOptions` and plumb it through the SQL adapter into the
      UOW executor (`packages/fragno-db/src/adapters/generic-sql/generic-sql-adapter.ts`).
- [x] Extend `DriverConfig` with an `outboxVersionstampStrategy` (or equivalent selector) and
      implement it for each supported driver type
      (`packages/fragno-db/src/adapters/generic-sql/driver-config.ts`).
- [x] Implement versionstamp reservation SQL in the SQL UOW executor based on driver config
      strategy, using the settings table key `${SETTINGS_NAMESPACE}.outbox_version` and holding the
      lock for the duration of the transaction
      (`packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`).
- [x] Implement outbox payload serialization from UOW mutation ops using **superjson** (spec §5.5),
      excluding internal fragment mutations.
- [x] Add reference placeholder + `refMap` support (spec §5.8): detect internal-only references,
      emit `{ "__fragno_ref": "<opIndex>.<columnName>" }` in payload, and populate `refMap` with
      external IDs.
- [x] Introduce a post‑mutation lookup plan (compiler → executor) to resolve internal IDs to
      external IDs inside the mutation transaction, and use it to populate `refMap`.
- [x] Integrate outbox insertion so one outbox row is inserted per successful UOW batch (spec
      §5.5–§5.6).
- [x] Ensure the outbox row is written only after successful mutation execution and before commit;
      rollbacks must not leave outbox rows or version increments.
- [x] Add programmatic retrieval tests for `outboxService.list` and ordering by `versionstamp`.
- [x] Add tests for reference placeholders + `refMap` resolution (internal-only references), and
      ensure internal fragment mutations are excluded from payloads.
- [x] Add adapter tests that verify outbox opt‑in behavior (disabled by default, enabled when
      configured) across supported databases.
- [x] Add ordering tests that verify versionstamp monotonicity across concurrent UOWs and that
      outbox entries reflect commit order for outbox‑enabled mutations.
- [x] Update `specs/README.md` to include the new spec and implementation plan entries.
