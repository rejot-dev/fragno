# Database Adapter Simplification — Implementation Plan

Spec: `specs/spec-db-adapter-simplification.md`

## Tasks

- [ ] Update `DatabaseAdapter` interface to remove `createSchemaGenerator` and add any SQL adapter
      metadata needed for schema output selection (Spec 6.4, 7.1).
- [ ] Rename or replace `GenericSQLAdapter` with `SqlAdapter`, including `SqlAdapterOptions` and
      SQLite profile mapping (`sqliteProfile` + `sqliteProfiles`), and bump adapter name/version to
      `sql@1` (Spec 6.1, 6.2, 7.1).
- [ ] Introduce `SchemaOutputFormat` and update the generation engine to distinguish **schema
      generation** (`drizzle`/`prisma`) from **migration generation** (`sql`), enforcing `sql`-only
      `fromVersion/toVersion` rules (Spec 6.4, 7.2).
- [ ] Move Drizzle and Prisma generators to `@fragno-dev/db/schema-output/*` and update imports in
      tests and internal code (Spec 6.6, 7.3).
- [ ] Update `fragno-cli db generate` to accept `--format`, wire it to the generation engine, and
      make the CLI wording explicitly distinguish **schema generation** vs **migration generation**
      (Spec 6.5).
- [ ] Update `fragno-cli db info` to report database type and sqlite profile for SQL adapters, and
      remove `createSchemaGenerator`-based branching (Spec 6.5).
- [ ] Update `fragno-cli db migrate` messaging to clarify SQL-only behavior and remove adapter
      format inference (Spec 6.5).
- [ ] Refactor all adapter usages across packages, tests, and examples to use `SqlAdapter` and the
      explicit `--format` CLI flows (Spec 6.8). Depends on new adapter path exports.
- [ ] Update `@fragno-dev/db` package exports and `tsdown.config.ts` entries to remove old adapter
      paths and add new `adapters/sql` + `schema-output/*` entries (Spec 6.6).
- [ ] Update documentation and corpus content to reflect the new adapter and format model, including
      `database-fragments` guides and CLI reference (Spec 6.5, 6.8).
- [ ] Update tests for adapter parity, Prisma storage profile behavior, and generation engine format
      branching (Spec 9).
