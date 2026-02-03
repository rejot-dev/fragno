# Fragno DB Namespaces + Naming Strategy — Implementation Plan

Spec: `specs/spec-db-namespace-and-naming.md`

- [x] Update `schema()` and `SchemaBuilder` to require a name, add `Schema.name`, and update all
      schema definitions and tests to pass the name. (Spec §§6.1, 12)
- [x] Add `databaseNamespace` to `FragnoPublicConfigWithDatabase` and resolve namespace at
      instantiation time based on override presence or `schema.name`; remove
      `withDatabase(schema, namespace?)` and update call sites. (Spec §§6.2–6.3, 12)
- [x] Ensure the internal fragment sets `databaseNamespace: null` when instantiated so its tables
      remain un‑namespaced. (Spec §6.4)
- [x] Remove `ormName` from `Table`, `Column`, `Relation`, and `Index` types and update all
      references to use logical names. (Spec §8)
- [x] Introduce `SqlNamingStrategy` + built‑in strategies and a `NamingResolver`; expose strategy
      from adapters and allow user overrides in adapter options. (Spec §§7.1–7.4)
- [x] Replace `TableNameMapper` usage across runtime SQL compilation, encoders/decoders, and query
      builders with `NamingResolver` lookups. (Spec §§7.4, 9, 11.1)
- [x] Update migration SQL generation to use the naming resolver for tables/columns/indexes/FKs and
      implement schema‑scoped strategy with schema creation. (Spec §11.2)
- [x] Update the in‑memory adapter store and reference resolution to rely on naming resolver
      mappings for table/column access. (Spec §9)
- [x] Update Drizzle/Prisma schema generators to accept a naming strategy, emit physical names for
      tables/columns/constraints, and support schema‑scoped strategy; update snapshots. (Spec §10)
- [x] Update CLI schema generation and info reporting to pass through naming strategy and show
      schema names where relevant. (Spec §§6, 10)
- [x] Add/adjust unit and integration tests for namespace defaulting, explicit `null` override,
      custom naming strategy (including columns/constraints), and schema‑scoped namespacing. (Spec
      §13)
- [x] Update docs/examples to use the new `schema(name, ...)` signature and runtime namespace
      overrides. (Spec §§6, 12)
